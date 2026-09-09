"""Desired-state and credential validation, the port of
io.github.getcolors.restate.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from . import compute
from colors_compute.ssh import _mode
from package_once_blue.validate import providers as once_providers

profile_par = par_name("profile")

default_compute_provider="digitalocean"

required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy", "restate-host", "restate-node-name", "restate-image",
    "restate-typescript-sdk-version", "restate-data-dir", "restate-backup-dir",
    "reference-app-delay-seconds", "reference-app-max-activity-attempts",
    "reference-app-fail-activity-attempts", "caddy-image",
    "restate-backup-r2-bucket", "restate-backup-r2-endpoint",
    "restate-backup-r2-region", "restate-backup-oncalendar",
    "restate-backup-retention-days",
]

HOST_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
IMAGE_RE = re.compile(r"^[^\s:@]+(?:/[^\s:@]+)*:[^\s:@]+$")


def missing(x) -> bool:
    return x is None or (isinstance(x, str) and not x.strip())


def env_errors(env: dict) -> list[str]:
    if str(env.get(profile_par) or ""):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def keygen(opts):
    try: return _mode(opts)['mode'] == 'managed'
    except ValueError: return True


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
    for key in required:
        if missing(opts.get(key)):
            errors.append(f":{key} is required")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("s3", "r2"):
        errors.append(":provider-backend must be s3 or r2")
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
    errors += compute.errors(opts)
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers.get("provider-backend", {}).get(opts.get("provider-backend"))
    return (entry or {}).get("secrets", [])


def secret_errors(opts: dict) -> list[str]:
    """Credentials a real create or delete needs: the selected compute
    provider's, Cloudflare's, the backup bucket's, and the backend's."""
    keys = [
            "cloudflare-api-token",
            "restate-backup-r2-access-key-id",
            "restate-backup-r2-secret-access-key",
            *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if missing(opts.get(key))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {}
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers.get("provider-backend", {}).get(
            opts.get("provider-backend"))
        return (entry or {}).get("tofu-env", {})
    return {}
