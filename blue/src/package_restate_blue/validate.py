"""Desired-state and credential validation, the port of
io.github.getcolors.restate.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import compute as once_compute
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

# provider-compute -> what that choice implies.
#
# `required` are the non-secret keys that provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, and `tofu-env` the
# subset OpenTofu reads from the process environment itself. Keeping the three
# together is what stops a provider being validated against one set of keys and
# run with another -- a stage exporting a credential nobody checked for, or a
# check demanding a key no template uses. The keys of this map are the
# advertised providers; a provider without a template directory and a golden
# is not advertised. One entry today: this package puts a provider firewall in
# front of the host, so the sources are required where ONCE's own compute
# templates need none.
#
# Two keys the template reads are deliberately not required. `digitalocean-name`
# is an optional override of the profile (Compute Name Standard), and
# `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
compute_providers = {
    "digitalocean": {
        "required": ["digitalocean-region", "digitalocean-size", "digitalocean-image",
                     "digitalocean-ssh-sources", "digitalocean-http-sources"],
        "secrets": ["do-token"],
        "tofu-env": {"do-token": "DIGITALOCEAN_TOKEN"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered. A legacy state
# -- `params` without `provider` -- is whatever this value says it is, and
# `restate-digitalocean`'s R2 state may still hold one.
default_compute_provider = "digitalocean"

# How this package describes itself to ONCE's `compute`, the Compute Provider
# Standard's operations over a package-owned registry. The registry and the
# default are the data above; `sources` names the firewall lists the template
# reads -- SSH must list at least one CIDR, an empty HTTP list means no public
# HTTP. The name rules are ONCE's.
spec: once_compute.ComputeSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources"], "may_be_empty": ["http-sources"]},
}

# Every key desired state must carry whichever provider is selected. The
# provider-scoped keys come from `compute_providers`.
required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy", "restate-host", "restate-node-name", "restate-image",
    "restate-typescript-sdk-version", "restate-data-dir", "restate-backup-dir",
    "reference-app-delay-seconds", "reference-app-max-activity-attempts",
    "reference-app-fail-activity-attempts", "caddy-image",
    "restate-backup-r2-bucket", "restate-backup-r2-endpoint",
    "restate-backup-r2-region", "restate-backup-oncalendar",
    "restate-backup-retention-days",
    "r2-bucket", "r2-endpoint",
]

HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
IMAGE_RE = re.compile(r"^[^\s:@]+(?:/[^\s:@]+)*:[^\s:@]+$")


def missing(x) -> bool:
    return x is None or (isinstance(x, str) and not x.strip())


def env_errors(env: dict) -> list[str]:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


# `<provider>-<suffix>`: desired state names compute keys after the provider,
# so the shared steps reach them through the selected provider rather than a
# fixed prefix. ONCE's; named here so `tools` reads the same.
compute_key = once_compute.compute_key

# What this deployment's machine is called: `digitalocean-name` when present,
# else the profile (Compute Name Standard). ONCE's; the template derives the
# Droplet name, the firewall name and `params.name` from this one answer.
compute_name = once_compute.compute_name


def keygen(opts: dict) -> bool:
    """Whether this deployment owns its machine keypair. Delegates to ONCE, the
    standard's reference implementation, so one rule decides it everywhere."""
    return once_ssh.keygen(opts)


# A source list as desired state or an overlay string carries it. ONCE's, so
# the validator and the template can never disagree about what an entry is.
cidrs = once_compute.cidrs


def _positive_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _plain_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def state_errors(opts: dict) -> list[str]:
    """Every problem with desired state at once: the missing keys (this
    package's and the selected provider's), the package's own checks, then the
    Compute Provider Standard's -- selection, the network contract and the
    provider rules, DigitalOcean's VPC refusal among them -- which are ONCE's
    over `spec`."""
    errors: list[str] = []
    for key in [*required, *once_compute.required_keys(spec, opts)]:
        if missing(opts.get(key)):
            errors.append(f":{key} is required")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")
    if not (missing(opts.get("restate-host"))
            or HOST_RE.match(str(opts.get("restate-host")))):
        errors.append(":restate-host must be a fully qualified hostname")
    for key in ["restate-image", "caddy-image"]:
        value = opts.get(key)
        if not missing(value) and not IMAGE_RE.match(str(value)):
            errors.append(f":{key} must carry an explicit image tag")
    for key in ["reference-app-delay-seconds", "reference-app-max-activity-attempts",
                "reference-app-fail-activity-attempts", "restate-backup-retention-days"]:
        if not missing(opts.get(key)) and not _positive_int(opts.get(key)):
            errors.append(f":{key} must be a positive integer")
    max_attempts = opts.get("reference-app-max-activity-attempts")
    fail_attempts = opts.get("reference-app-fail-activity-attempts")
    if (_plain_int(max_attempts) and _plain_int(fail_attempts)
            and max_attempts <= fail_attempts):
        errors.append(":reference-app-max-activity-attempts must exceed "
                      ":reference-app-fail-activity-attempts")
    errors += once_compute.state_errors(spec, opts)
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers.get("provider-backend", {}).get(opts.get("provider-backend"))
    return (entry or {}).get("secrets", [])


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real create or delete needs: the selected compute
    provider's, Cloudflare's, the backup bucket's, and the backend's."""
    keys = [*once_compute.secrets(spec, opts),
            "cloudflare-api-token",
            "restate-backup-r2-access-key-id",
            "restate-backup-r2-secret-access-key",
            *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if missing(opts.get(key))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return once_compute.tofu_env(spec, opts)
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers.get("provider-backend", {}).get(
            opts.get("provider-backend"))
        return (entry or {}).get("tofu-env", {})
    return {}
