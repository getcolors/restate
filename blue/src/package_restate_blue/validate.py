"""Desired-state and credential validation over ONCE's backend provider
registry, the port of io.github.getcolors.restate.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the three colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue.validate import providers

__all__ = ["providers"]

profile_par = par_name("profile")

required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy", "restate-host", "restate-node-name", "restate-image",
    "restate-typescript-sdk-version", "restate-data-dir", "restate-backup-dir",
    "reference-app-delay-seconds", "reference-app-max-activity-attempts",
    "reference-app-fail-activity-attempts", "caddy-image",
    "restate-backup-r2-bucket", "restate-backup-r2-endpoint",
    "restate-backup-r2-region", "restate-backup-oncalendar",
    "restate-backup-retention-days", "digitalocean-name", "digitalocean-region",
    "digitalocean-size", "digitalocean-image", "digitalocean-ssh-keys",
    "digitalocean-ssh-sources", "digitalocean-http-sources",
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


def _positive_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool) and x > 0


def _plain_int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    for key in required:
        if missing(opts.get(key)):
            errors.append(f":{key} is required")
    if opts.get("provider-compute") != "digitalocean":
        errors.append(":provider-compute must be digitalocean")
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
    if "digitalocean-vpc-uuid" in opts:
        errors.append(":digitalocean-vpc-uuid must be absent; "
                      "the default regional VPC is discovered at runtime")
    if "digitalocean-vpc-cidr" in opts:
        errors.append(":digitalocean-vpc-cidr must be absent; "
                      "this package must not create a VPC")
    return errors


def _backend_entry(opts: dict) -> dict:
    return (providers.get("provider-backend") or {}).get(opts.get("provider-backend")) or {}


def backend_secrets(opts: dict) -> list[str]:
    return _backend_entry(opts).get("secrets") or []


def secret_errors(opts: dict) -> list[str]:
    keys = ["do-token", "cloudflare-api-token",
            "restate-backup-r2-access-key-id",
            "restate-backup-r2-secret-access-key",
            *backend_secrets(opts)]
    return [f"required credential is not set: {par_name(key)}"
            for key in dict.fromkeys(keys) if missing(opts.get(key))]


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {"do-token": "DIGITALOCEAN_TOKEN"}
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        return _backend_entry(opts).get("tofu-env") or {}
    return {}
