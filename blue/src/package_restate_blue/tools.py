"""OpenTofu and Ansible stages plus the acceptance proof, the port of
io.github.getcolors.restate.tools."""

from __future__ import annotations

import asyncio
import json
import math
import re
import time
from decimal import Decimal
from pathlib import Path

from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec

from . import validate

infrastructure_tool = "restate-infrastructure"
dns_tool = "restate-dns"
ansible_tool = "restate-ansible"
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


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    xs = value if isinstance(value, list) else re.split(
        r"[,\s]+", "" if value is None else str(value))
    return [s for s in (str(x).strip() for x in xs) if s]


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


def fallback_params(opts: dict) -> dict:
    return {"ip": "192.0.2.10", "user": "root", "sudoer": "root",
            "name": opts.get("profile")}


def output_params(result: dict) -> dict | None:
    return (result.get("tofu/outputs") or {}).get("params")


# ---------------------------------------------------------------- compute


def infrastructure_data(opts: dict) -> dict:
    return {**opts,
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-ssh-sources")),
            "http-sources-hcl": tofu.hcl_list(cidrs(opts, "digitalocean-http-sources"))}


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    specs = [spec(template("infrastructure", "main.tf"), f"{dir}/main.tf",
                  infrastructure_data(opts))]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") == "build":
        return {**result, **fallback_params(opts)}
    if opts.get("blue/event") == "delete":
        return result
    return {**result, **fallback_params(opts), **(output_params(result) or {})}


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
    return {**opts,
            "ip": opts.get("ip") or "192.0.2.10",
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
    await runtime.exec(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
         f"root@{opts.get('ip')}", "systemctl reboot"], timeout_ms=20000)
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
