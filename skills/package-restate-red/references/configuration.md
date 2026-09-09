# Configuration

Required non-secret keys are demonstrated in the package `colors.yml`. The
package advertises one compute provider, `digitalocean`; `provider-compute`
selects it, and only the selected provider's keys and credential are required.
Keys of another provider are accepted and ignored.

## Credentials

Every deployment requires these private environment variables:

```text
COLORS_PAR_CLOUDFLARE_API_TOKEN
COLORS_PAR_R2_ACCESS_KEY_ID
COLORS_PAR_R2_SECRET_ACCESS_KEY
COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID
COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY
```

plus the selected compute provider's:

```text
COLORS_PAR_DO_TOKEN          # provider-compute: digitalocean
```

Never set `COLORS_PAR_PROFILE`.

## Compute ownership

The pinned `colors-compute` library owns provider selection, remote S3/R2
state, deployment coordination, machine keys, network policy and the single
node. This package supplies singleton topology and SSH/HTTP ingress, then
uses the returned address, login user and SSH identity for its application
steps. New provider support belongs in the library; consumers update its pin.
The application needs a supported Ubuntu image and sufficient memory for
Restate and the reference application. Build first to check adapter capabilities.

Use `restate-ssh-sources` and `restate-http-sources` for neutral CIDR
allowlists. Existing selected-provider source options remain compatible.
External account key references may use `ssh-private-key-path` or operator/agent SSH configuration; external
private keys are never generated or removed. The local SSH block writes
`IdentityFile` only for a managed deployment key.

Existing `<profile>/restate-infrastructure.tfstate` is refused before
compute mutation. Do not remove it to bypass this check: migrate ownership
explicitly or destroy the old deployment through its original version first.
Unreadable state and provider mismatches fail closed.

The default adapter remains `digitalocean`. The node requests TCP22/80/443;
Restate ingress, admin and fabric ports remain private to Compose.

No private network is requested by default. The library validates supported
explicit network references without taking ownership of existing networks.
Remote state must use S3 (ambient AWS credentials) or R2 (the two explicit
backend credentials). Adapter inputs and supported capabilities belong to the
library; update its dependency to add a provider.

External key references may use `ssh-private-key-path` or operator/agent SSH configuration. Managed key generation,
registration, ownership checks and cleanup are library operations. Keys are
removed only after compute destruction. The local SSH updater locks and
atomically updates `Host <profile>` with the observed login and address;
`IdentityFile`/`IdentitiesOnly` appear only for managed keys. Conflicting
unmanaged stanzas and leading global SSH options refuse the update.

A delete uses the owned state's address. It does not support a cleanup IP
override. An unreadable state cannot be treated as an empty deployment.

## Restate and the reference application

| Key | Required | Meaning |
|---|---|---|
| `restate-host` | yes | The public hostname; a Cloudflare apex or subdomain |
| `restate-node-name` | yes | The stable Restate node name, e.g. `restate-1` |
| `restate-image` | yes | Exact server image pin, e.g. `docker.restate.dev/restatedev/restate:1.7.3` |
| `restate-typescript-sdk-version` | yes | Exact `@restatedev/restate-sdk` version for the reference app |
| `restate-data-dir` | yes | Host path for Restate state, `/var/lib/restate` |
| `restate-backup-dir` | yes | Host path for local backup archives |
| `reference-app-delay-seconds` | yes | The durable sleep; must outlast the acceptance reboot |
| `reference-app-max-activity-attempts` | yes | Retry budget of the reference activity |
| `reference-app-fail-activity-attempts` | yes | Attempts that fail on purpose; must be below the budget |
| `caddy-image` | yes | Exact Caddy image pin |
| `caddy-acme-email` | no | ACME account contact; omit rather than use a placeholder |

`restate-image`, `caddy-image`, and `restate-typescript-sdk-version` are exact
pins. `reference-app-delay-seconds` must leave enough time for the acceptance
check to reboot the Droplet while the workflow is sleeping.

## Backups

| Key | Required | Meaning |
|---|---|---|
| `restate-backup-r2-bucket` | yes | R2 bucket for the archives |
| `restate-backup-r2-endpoint` | yes | R2 S3 endpoint |
| `restate-backup-r2-region` | yes | `auto` |
| `restate-backup-oncalendar` | yes | systemd `OnCalendar` for the backup timer |
| `restate-backup-retention-days` | yes | Local archives older than this are pruned |

Backups stop the stateful containers briefly to produce a consistent archive
and retain local archives according to `restate-backup-retention-days`; R2
lifecycle policy is an external operational concern.

## OpenTofu state

| Key | Required | Meaning |
|---|---|---|
| `provider-backend` | yes | `s3` or `r2` |
| `r2-bucket` | yes | State bucket; keys are `<profile>/<stage>.tfstate` |
| `r2-endpoint` | yes | R2 S3 endpoint |
| `compute-prevent-destroy` | yes | Keep `true`; lifted for one run by `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` |
