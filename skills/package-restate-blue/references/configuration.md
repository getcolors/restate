# Configuration

Required non-secret keys are demonstrated in the package `colors.yml`.

The enabled deployment requires these private environment variables:

```text
COLORS_PAR_DO_TOKEN
COLORS_PAR_CLOUDFLARE_API_TOKEN
COLORS_PAR_R2_ACCESS_KEY_ID
COLORS_PAR_R2_SECRET_ACCESS_KEY
COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID
COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY
```

Never set `COLORS_PAR_PROFILE`. No VPC UUID or CIDR is accepted: the package
looks up `default-<digitalocean-region>` at runtime and never creates a VPC.

`restate-image`, `caddy-image`, and `restate-typescript-sdk-version` are exact
pins. `reference-app-delay-seconds` must leave enough time for the acceptance
check to reboot the Droplet while the workflow is sleeping. Backups stop the
stateful containers briefly to produce a consistent archive and retain local
archives according to `restate-backup-retention-days`; R2 lifecycle policy is an
external operational concern.
