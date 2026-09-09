# Restate Package Skill

A tri-colour Package Skill (green, red, blue) that provisions Restate 1.7.3 and
a TypeScript reference workflow application on one VM through colors-compute.

The same deployment can run through the canonical Clojure implementation
(`package-restate-green`), the TypeScript one (`package-restate-red`), or the
Python one (`package-restate-blue`) — all three render byte-identical artifacts
from one `colors.yml`, guarded by `scripts/parity.sh`.

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

## Architecture and sizing

The library owns the VM, network policy and managed machine key. Cloudflare
publishes the zone apex and Caddy obtains origin TLS. Restate 8080/9070/5122
and the SDK endpoint remain on the private Compose network. Ansible and the
reboot acceptance step use the library's observed login user and SSH identity.

The desired `s-8vcpu-16gb` class leaves ample headroom above Restate 1.7's
approximately 4.75 GiB default memory pools for runtime overhead, RocksDB,
Node.js, Caddy, image builds and restart acceptance tests. It is deliberately
sized for reliable production-default operation rather than a tuned-down
development server.

Versions were discovered 2026-08-15 and pinned exactly:

- Restate 1.7.3: https://github.com/restatedev/restate/releases/tag/v1.7.3
- TypeScript SDK 1.16.6: https://registry.npmjs.org/@restatedev/restate-sdk/latest
- Production/self-hosting guidance: https://docs.restate.dev/server/overview.md
- Docker durability and stable node name: https://docs.restate.dev/server/deploy/docker.md
- Security boundaries: https://docs.restate.dev/server/security.md

## Lifecycle

```sh
./green build              # or ./red, ./blue
./green create --dry-run
./green create
```

`colors.yml` is the only deployment desired-state file. Credentials are
`COLORS_PAR_*` variables in ignored `.envrc.private`; never set
`COLORS_PAR_PROFILE`. `build` renders only, and dry-run skips every side effect;
neither reads `~/.ssh` or the state backend. Deletion remains protected by
`compute-prevent-destroy: true`, refuses when the state backend cannot be read,
and removes the `~/.ssh/config` block before the Droplet is destroyed and the
generated keypair only after it.

## API and acceptance

```sh
curl https://example.com/health
curl -X POST -H 'content-type: application/json' -d '{"value":7}' \
  https://example.com/workflows/my-id
curl https://example.com/workflows/my-id
```

The workflow durably sleeps, fails its activity twice, succeeds on attempt
three, and returns `value²` plus a deterministic SHA-256 verification string.
A duplicate start uses Restate's workflow-ID exactly-once boundary and returns
the same ID without a second execution. Real `create` starts a workflow,
repeats the start, reboots the Droplet during the sleep, waits for HTTPS to
recover and verifies the final status, result and retry count.

## Operations and recovery

```sh
ssh <profile> 'cd /opt/restate && docker compose ps'
ssh <profile> 'cd /opt/restate && docker compose logs --tail=200 restate app caddy'
ssh <profile> 'systemctl status restate-backup.timer'
```

Daily backups briefly stop the stateful services, archive `/var/lib/restate`
and `/var/lib/restate-app`, and upload to the configured R2 prefix. Restore on a
replacement node by stopping Compose, extracting a selected archive back under
`/var/lib`, preserving `restate-node-name`, and starting Compose. Test this
procedure on an isolated node before relying on it.

For upgrades, take and verify a backup, change the exact image/SDK pins, inspect
the golden diff, run tests/build/dry-run, then converge. Long-running workflows
must remain compatible with Restate's immutable deployment/versioning rules.

This is durable but not highly available: Droplet, region, disk or operator
loss causes downtime; backup RPO is the timer interval and restore is manual.
The prevent-destroy guard does not replace tested backups.
