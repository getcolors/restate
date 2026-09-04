"""OpenTofu and Ansible stages plus the acceptance proof, the port of
io.github.getcolors.restate.tools."""

from __future__ import annotations

import asyncio
import json
import math
import time
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec, scaffold
from package_once_blue import compute as once_compute

from . import ssh, ssh_config, validate

infrastructure_tool = "restate-infrastructure"
dns_tool = "restate-dns"
ansible_tool = "restate-ansible"
ansible_local_tool = "restate-ansible-local"
ROOT = Path(__file__).parent / "resources"
template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="restate")


def template(path: str, file: str) -> dict:
    name = f"tools/{path.replace('.', '/')}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


# The source lists as validate parses them, so the template and the
# validator can never disagree about what an entry is. ONCE's.
cidrs = validate.cidrs


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = "" if opts.get(key) is None else str(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


# What `build` and `--dry-run` render in place of a compute output: the
# documentation address, shaped like the selected provider's real `params` so
# every later stage sees the same keys either way. ONCE's.
fallback_params = once_compute.fallback_params

# Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute output
# carries no `ip`. ONCE's; `infrastructure_step` is what wires it.
resolved_compute = once_compute.resolved_compute

# `<provider>-<suffix>`, the selected provider's key. ONCE's, via validate.
compute_key = validate.compute_key

# The machine's name: `digitalocean-name` when present, else the profile.
# ONCE's, via validate; the template derives every label from it.
compute_name = validate.compute_name


# ---------------------------------------------------------------- compute


def infrastructure_data(opts: dict) -> dict:
    """Template values for the compute stage. The name, the keypair mode and
    the source lists are resolved here once, so the template interpolates
    values and never branches on which provider it belongs to."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "compute-name": compute_name(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, compute_key(opts, "ssh-sources"))),
            "http-sources-hcl": tofu.hcl_list(cidrs(opts, compute_key(opts, "http-sources")))}


def infrastructure_specs(opts: dict) -> list[dict]:
    """Providers are selected by template directory, not by conditionals
    inside one file: `tools/infrastructure/<provider>/main.tf` renders to the
    same `main.tf` whichever provider produced it."""
    dir = tool_dir(opts, infrastructure_tool)
    return [spec(template(f"infrastructure.{opts.get('provider-compute')}", "main.tf"),
                 f"{dir}/main.tf", infrastructure_data(opts))]


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    result = await tofu.tofu_with_spec(
        opts, infrastructure_specs(opts),
        dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return resolved_compute(result, fallback_params(opts), once_compute.output_params(result))


# -------------------------------------------------------------------- dns


def dns_json(opts: dict) -> str:
    return tofu.constructs_json([
        tofu.construct("resource", "cloudflare_dns_record", "restate",
                       {"zone_id": "${data.cloudflare_zone.zone.id}",
                        "name": opts.get("restate-host"),
                        "content": opts.get("ip"), "type": "A",
                        "proxied": True, "ttl": 1})])


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    data = {**opts, "ip": opts.get("ip") or fallback_params(opts)["ip"]}
    specs = [spec(template("dns", "main.tf"), f"{dir}/main.tf", data),
             raw_spec(f"{dir}/record.tf.json", dns_json(data))]
    return await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-dns"))


# ---------------------------------------------------------- ansible (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. The address, the user and the alias
    are run-time facts and reach the play as extra-vars instead, so the
    rendered playbook carries no IP and is identical on every workstation (SSH
    Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    return [spec(template("ansible-local", name), f"{dir}/{name}", data)
            for name in ["ansible.cfg", "inventory.ini", "main.yml"]]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves both
    events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ip": opts.get("ip") or fallback_params(opts)["ip"],
                    "user": opts.get("user") or "root",
                    "block_state": "absent" if delete else "present"})


# ---------------------------------------------------------------- ansible


def _java_double(x: float) -> str:
    """Java's Double.toString, which is what Green's cheshire JSON emits for
    floats: decimal between 1e-3 and 1e7, `d.dddE±e` scientific outside it.
    Python's own repr disagrees exactly where scientific notation starts
    (0.0001 -> "1.0E-4"), and the goldens carry the Java form."""
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    negative = math.copysign(1.0, x) < 0
    magnitude = abs(x)
    if magnitude == 0.0:
        return "-0.0" if negative else "0.0"
    _sign, digits, exponent = Decimal(repr(magnitude)).as_tuple()
    digit_str = "".join(map(str, digits)).rstrip("0") or "0"
    dec_exp = exponent + len(digits) - 1
    if -3 <= dec_exp < 7:
        if dec_exp >= 0:
            whole = digit_str[:dec_exp + 1].ljust(dec_exp + 1, "0")
            frac = digit_str[dec_exp + 1:] or "0"
        else:
            whole = "0"
            frac = "0" * (-dec_exp - 1) + digit_str
        rendered = f"{whole}.{frac}"
    else:
        mantissa = digit_str[0] + "." + (digit_str[1:] or "0")
        rendered = f"{mantissa}E{dec_exp}"
    return ("-" if negative else "") + rendered


def _pretty(value, indent=0):
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract."""
    if isinstance(value, list):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k))} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    if isinstance(value, float) and not isinstance(value, bool):
        return _java_double(value)
    return json.dumps(value)


def inventory(opts: dict) -> str:
    return _pretty(
        {"all": {"children": {"restate": {"hosts": {
            opts.get("profile"): {"ansible_host": opts.get("ip") or "192.0.2.10",
                                  "ansible_user": "root"}}}}}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage. `ssh-private-key-path` reaches
    ansible.cfg so convergence uses the deployment's own key in keygen mode,
    where nothing guarantees an agent holds it."""
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
            "ssh-keygen": validate.keygen(opts),
            "app-files": ["Dockerfile", "package.json", "package-lock.json",
                          "tsconfig.json", "src/index.ts"],
            "restate-backup-access-key":
                "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID') }}",
            "restate-backup-secret-key":
                "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY') }}"}


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [spec(template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            spec(template("ansible", "main.yml"), f"{dir}/main.yml", data),
            spec(template("ansible", "cleanup.yml"), f"{dir}/cleanup.yml", data),
            spec(template("ansible", "compose.yml"), f"{dir}/compose.yml", data),
            spec(template("ansible", "Caddyfile"), f"{dir}/Caddyfile", data),
            spec(template("ansible", "backup"), f"{dir}/backup", data),
            spec(template("ansible.app", "Dockerfile"), f"{dir}/app/Dockerfile", data),
            spec(template("ansible.app", "package.json"), f"{dir}/app/package.json", data),
            spec(template("ansible.app", "package-lock.json"),
                 f"{dir}/app/package-lock.json", data),
            spec(template("ansible.app", "tsconfig.json"), f"{dir}/app/tsconfig.json", data),
            spec(template("ansible.app.src", "index.ts"), f"{dir}/app/src/index.ts", data),
            raw_spec(f"{dir}/inventory.json", inventory(data))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("ip"):
        # No compute in state: there is no host to clean up, and the rendered
        # inventory would fall back to 192.0.2.10. Remove the rendered tree the
        # way a completed cleanup would and let the teardown continue.
        return {**scaffold(opts, ansible_specs(opts)),
                "blue/exit": 0, "restate/cleanup": "skipped-no-compute"}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "main.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


# ------------------------------------------------------------- acceptance


async def run_json(args: list[str], timeout_ms: int):
    result = await runtime.exec(args, timeout_ms=timeout_ms)
    if result.exit == 0:
        try:
            return [json.loads(str(result.out or "")), None]
        except Exception:
            return [None, None]
    return [None, f"{result.err or ''}{result.out or ''}"]


async def wait_health(url: str, attempts: int) -> bool:
    n = attempts
    while True:
        result = await runtime.exec(["curl", "-fsS", f"{url}/health"], timeout_ms=10000)
        if result.exit == 0:
            return True
        if n > 0:
            await asyncio.sleep(5)
            n -= 1
        else:
            return False


async def acceptance_step(opts: dict) -> dict:
    """The end-to-end proof of the reference workflow: exactly-once duplicate
    starts, a full Droplet reboot during the durable sleep, and the retried
    activity's final result after recovery."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    base = f"https://{opts.get('restate-host')}"
    id = f"acceptance-{int(time.time() * 1000)}"
    if not await wait_health(base, 60):
        return {**opts, "blue/exit": 1, "blue/err": "HTTPS health did not become ready"}
    start_args = ["curl", "-fsS", "-X", "POST",
                  "-H", "content-type: application/json",
                  "--data", '{"value":7}', f"{base}/workflows/{id}"]
    started, start_err = await run_json(start_args, 15000)
    duplicate, duplicate_err = await run_json(start_args, 15000)
    # The deployment's own key is selected in keygen mode (`ssh.identity_args`),
    # because nothing guarantees an agent holds it; opt-out mode adds nothing.
    await runtime.exec(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
         *ssh.identity_args(opts), f"root@{opts.get('ip')}", "systemctl reboot"],
        timeout_ms=20000)
    if start_err:
        return {**opts, "blue/exit": 1, "blue/err": f"workflow start failed: {start_err}"}
    if duplicate_err:
        return {**opts, "blue/exit": 1, "blue/err": f"duplicate start failed: {duplicate_err}"}
    if (started or {}).get("workflowId") != (duplicate or {}).get("workflowId"):
        return {**opts, "blue/exit": 1,
                "blue/err": "duplicate start did not return the same workflow ID"}
    if not await wait_health(base, 90):
        return {**opts, "blue/exit": 1,
                "blue/err": "HTTPS did not recover after Droplet restart"}
    n = 90
    while True:
        status, err = await run_json(["curl", "-fsS", f"{base}/workflows/{id}"], 10000)
        result = (status or {}).get("result") or {}
        if (status and status.get("status") == "completed"
                and result.get("activityAttempts") == 3
                and result.get("result") == 7 * 7):
            return {**opts, "blue/exit": 0, "restate/acceptance": status}
        if n == 0:
            return {**opts, "blue/exit": 1,
                    "blue/err": f"workflow did not complete after restart: {err or status}"}
        await asyncio.sleep(3)
        n -= 1
