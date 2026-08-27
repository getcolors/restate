"""The graph, the port of io.github.getcolors.restate.workflow."""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow

from . import tools, validate

DEFAULTS = {"provider-compute": "digitalocean", "provider-dns": "cloudflare",
            "provider-backend": "local", "compute-prevent-destroy": True,
            "workdir": ".colors"}


async def state_output(opts: dict) -> dict | None:
    """The compute stage's applied `params`, or None when no state is readable.
    Delete overlays this best-effort read so cleanup knows the address; an
    unreadable state (a fresh clone, a missing backend) is simply absent."""
    try:
        outputs = await tofu.outputs(tools.tool_dir(opts, tools.infrastructure_tool),
                                     tools.backend_credential_env(opts))
        return (outputs or {}).get("params")
    except Exception:
        return None


async def start_step(original: dict, env: dict | None = None) -> dict:
    async def after(opts, _env, context):
        if context["real"] and context["event"] == "delete":
            return {**opts, **((await state_output(opts)) or {}), "blue/exit": 0}
        return {**opts, "blue/exit": 0}

    return await preflight(
        original, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] in ("create", "delete") else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ],
        after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "restate/start": (start_step, "restate/ansible"),
            "restate/ansible": (tools.ansible_step, "restate/dns"),
            "restate/dns": (tools.dns_step, "restate/infrastructure"),
            "restate/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    return {
        "restate/start": (start_step, "restate/infrastructure"),
        "restate/infrastructure": (tools.infrastructure_step, "restate/dns"),
        "restate/dns": (tools.dns_step, "restate/ansible"),
        "restate/ansible": (tools.ansible_step, "restate/acceptance"),
        "restate/acceptance": (tools.acceptance_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


side_effecting = ["restate/infrastructure", "restate/dns", "restate/ansible",
                  "restate/acceptance"]


def create_workflow():
    wf = workflow(start="restate/start", wire_fn=wire_fn)
    wf = advice_add(wf, "restate/infrastructure", "before", "restate.workflow/backend",
                    backend_advice(tools.infrastructure_tool))
    wf = advice_add(wf, "restate/dns", "before", "restate.workflow/backend",
                    backend_advice(tools.dns_tool))
    return dry_run.advise(progress.advise(wf), side_effecting)


restate_workflow = create_workflow()
