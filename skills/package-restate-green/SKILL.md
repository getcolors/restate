---
name: package-restate-green
description: Provisions and operates production-oriented single-node Restate with a durable TypeScript reference workflow on one DigitalOcean Droplet.
license: MIT
---

# Restate with Green

Operate one Restate deployment from non-secret `colors.yml`. Read
[references/configuration.md](references/configuration.md) before changing
configuration or running a lifecycle operation.

## Providers

`provider-compute` selects the machine; `digitalocean` (one Droplet, the
region's default VPC discovered at runtime) is the one provider this package
advertises. It reads its own keys and its own credential:

| Provider | Credential | Keys |
|---|---|---|
| `digitalocean` | `COLORS_PAR_DO_TOKEN` | `digitalocean-region`, `digitalocean-size`, `digitalocean-image`, `digitalocean-ssh-sources`, `digitalocean-http-sources`; optional `digitalocean-name`, `digitalocean-ssh-keys` |

- `digitalocean-name` is optional and defaults to the profile.
- `digitalocean-ssh-keys` is optional. Leave it out and the package generates
  and owns the machine keypair at `~/.ssh/<profile>` on the first real create
  (keygen mode, the default); set it to an existing account key id to use that
  key instead.
- A real create also writes a managed `Host <profile>` block into
  `~/.ssh/config`, between `# BEGIN <profile> ANSIBLE MANAGED BLOCK` and
  `# END …` markers, so `ssh <profile>` reaches the Droplet; `delete` removes
  it before the Droplet is destroyed. The alias is the profile — there is no
  separate key for it. A `Host <profile>` stanza that already exists outside
  those markers, or an option standing above the first `Host` line of the
  file, refuses the create with the file and line named; the package never
  overwrites either. Remove or rename the stanza, move the global options
  below the block or into a `Host *` stanza at the end, or change `profile`.
- `digitalocean-ssh-sources` must list at least one CIDR; every entry of both
  source keys must be a valid IPv4 or IPv6 CIDR.
- A `provider-compute` that differs from the provider recorded in state is
  refused on `create` and `delete`; a state recorded before the package wrote
  the provider is treated as DigitalOcean's.

## Safety

- Keep credentials in gitignored `.envrc.private` as `COLORS_PAR_*` variables.
- Never set `COLORS_PAR_PROFILE` or edit/commit `.colors/`.
- Keep `compute-prevent-destroy: true`; deletion requires separate explicit
  authorization and a one-run environment override.
- Build and dry-run before a real create; neither reads `~/.ssh` or the
  state backend.
- Never publish Restate ports 8080, 9070, or 5122.

```sh
./green build
./green create --dry-run
./green create
```

Real create includes public HTTPS and reboot-during-delay acceptance checks.
