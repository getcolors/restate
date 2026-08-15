---
name: package-restate-green
description: Provisions and operates production-oriented single-node Restate with a durable TypeScript reference workflow on DigitalOcean.
license: MIT
---

# Restate with Green

Operate one Restate deployment from non-secret `colors.yml`. Read
[references/configuration.md](references/configuration.md) before changing
configuration or running a lifecycle operation.

## Safety

- Keep credentials in gitignored `.envrc.private` as `COLORS_PAR_*` variables.
- Never set `COLORS_PAR_PROFILE` or edit/commit `.colors/`.
- Keep `compute-prevent-destroy: true`; deletion requires separate explicit
  authorization and a one-run environment override.
- Build and dry-run before a real create.
- Never publish Restate ports 8080, 9070, or 5122.

```sh
./green build
./green create --dry-run
./green create
```

Real create includes public HTTPS and reboot-during-delay acceptance checks.
