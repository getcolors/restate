# Restate Package Skill

A tri-colour Package Skill (green, red, blue) that provisions Restate 1.7.3 and
a TypeScript reference workflow application on one DigitalOcean Droplet.

The same deployment can run through the canonical Clojure implementation
(`package-restate-green`), the TypeScript one (`package-restate-red`), or the
Python one (`package-restate-blue`) — all three render byte-identical artifacts
from one `colors.yml`, guarded by `scripts/parity.sh`.

## Architecture and sizing

OpenTofu discovers `default-<digitalocean-region>` at apply time and attaches an
Ubuntu 24.04 Droplet without creating or configuring a VPC. A DigitalOcean
firewall exposes SSH and HTTP(S) only. Cloudflare publishes the zone apex and
Caddy obtains origin TLS. Restate 8080/9070/5122 and the SDK endpoint remain on
the private Compose network.

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
`COLORS_PAR_PROFILE`. `build` renders only, and dry-run skips every side effect.
Deletion remains protected by `compute-prevent-destroy: true`.

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
ssh root@SERVER 'cd /opt/restate && docker compose ps'
ssh root@SERVER 'cd /opt/restate && docker compose logs --tail=200 restate app caddy'
ssh root@SERVER 'systemctl status restate-backup.timer'
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
