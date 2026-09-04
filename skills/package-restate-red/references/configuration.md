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

## Compute providers

### DigitalOcean (`provider-compute: digitalocean`)

| Key | Required | Meaning |
|---|---|---|
| `digitalocean-region` | yes | Droplet region, e.g. `ams3` |
| `digitalocean-size` | yes | Droplet size, e.g. `s-8vcpu-16gb` |
| `digitalocean-image` | yes | Image slug, `ubuntu-24-04-x64` |
| `digitalocean-ssh-sources` | yes | CIDRs admitted to TCP 22 |
| `digitalocean-http-sources` | yes | CIDRs admitted to TCP 80/443 |
| `digitalocean-name` | no | Droplet name; the profile by default |
| `digitalocean-ssh-keys` | no | An existing account key id; absent means keygen mode |

No VPC UUID or CIDR is accepted: the package looks up
`default-<digitalocean-region>` at runtime and never creates a VPC.

`digitalocean-name` is validated against DigitalOcean's naming rules
(lowercase letters, digits, dots and hyphens, 1-63 characters). The firewall
is named `<name>-firewall` and the compute output's `name` carries the same
resolved value.

### Firewall sources

`digitalocean-ssh-sources` must list at least one CIDR, and every entry of both
source keys must be a syntactically valid IPv4 or IPv6 CIDR; both are checked
before any provider call. An empty `digitalocean-http-sources` is allowed and
means no public HTTP: the 80 and 443 rules are emitted only when there is a
source to name, because a DigitalOcean rule with no source is an API error
rather than a closed port. The provider firewall admits 22, 80 and 443 from
those sources and nothing else.

### The machine keypair

When `digitalocean-ssh-keys` is absent (keygen mode, the default), the first
real `create` generates an ed25519 keypair at `~/.ssh/<profile>` and registers
it as an account key named after the profile; `delete` removes the local
keypair after the Droplet is destroyed. The key is not generated output: it
survives regeneration of `.colors/`, and a fresh clone on another workstation
does not carry it. A key on disk with no matching state, or an account key of
that name this deployment does not own, refuses the create rather than being
overwritten or adopted. Set `digitalocean-ssh-keys` to an existing account key
id to opt out; the package then creates and deletes no key material.

### The `~/.ssh/config` block

A real `create` writes one managed block into `~/.ssh/config`, after the
Droplet exists and before it is converged, so `ssh <profile>` needs no
address, no user and no `-i` flag:

```sshconfig
# BEGIN <profile> ANSIBLE MANAGED BLOCK
Host <profile>
    HostName <ip>
    User root
    Port 22
    IdentityFile ~/.ssh/<profile>      # keygen mode only
    IdentitiesOnly yes                 # keygen mode only
    StrictHostKeyChecking accept-new
    ForwardAgent no
# END <profile> ANSIBLE MANAGED BLOCK
```

The alias is the profile; there is no separate key for it. The `IdentityFile`
pair appears only in keygen mode, where the package knows the key because it
generated it; with `digitalocean-ssh-keys` set the operator's own arrangements
find the key. `delete` removes the block before the Droplet is destroyed (the
keypair, by contrast, goes after it). `build` and `--dry-run` never read the
file.

The block is inserted at the top of the file, because `ssh_config` takes the
first value it obtains and a `Host *` stanza above it would win on `User` and
`IdentityFile`. Two layouts make a real create refuse rather than rewrite the
file, each naming the file and the line: a `Host <profile>` stanza outside
the markers (remove or rename it if it is stale, or change `profile` if it
belongs to something else — the package never overwrites it), and an option
standing above the first `Host` or `Match` line, which is global today and
would be captured into this one stanza (move it below the managed block, or
into an explicit `Host *` stanza at the end of the file).

### State, switching and the recorded provider

Every provider shares one state key per profile, so switching would be a
rebuild: `delete` on the provider recorded in state, then `create` on the new
one. A `provider-compute` that differs from the provider recorded in state is
refused on both `create` and `delete`, before any credential is checked; a
state recorded before the package wrote the provider is treated as
DigitalOcean's. On a real `create` an unreadable state backend counts as no
state, as on a fresh clone; on a real `delete` it is an error, because a
delete that cannot see its state has nothing to address. A real converge
whose compute output carries no `ip` refuses rather than converging against
the documentation address `192.0.2.10` that `build` and `--dry-run` render.

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
| `provider-backend` | yes | `local`, `s3` or `r2` |
| `r2-bucket` | yes | State bucket; keys are `<profile>/<stage>.tfstate` |
| `r2-endpoint` | yes | R2 S3 endpoint |
| `compute-prevent-destroy` | yes | Keep `true`; lifted for one run by `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` |
