# CLAUDE.md

## Repository

`restate` is a tri-colour Package Skill (green, red, blue) for a
production-oriented, single-node Restate deployment on one DigitalOcean
Droplet. OpenTofu discovers the configured
Amsterdam region's default VPC at runtime, manages the Droplet, firewall and
Cloudflare apex record, and Ansible converges a private Docker Compose stack.
Only Caddy ports 80/443 and key-only SSH are public. Restate ingress, admin and
fabric ports remain on the Compose network.

The reference TypeScript application demonstrates workflow IDs, durable sleep,
retrying `ctx.run` activity, duplicate-safe starts, status/result retrieval and
recovery after a full Droplet reboot. Persistent Restate and activity state live
under `/var/lib`; a timer takes consistent stopped-service backups to R2.

## Commands

The three implementations live in the tri-colour layout, matching `clickhouse`:
canonical Clojure in `green/` (`green/bb.edn`, `green/deps.edn`, `green/src/`,
`green/tasks/`, tests under `green/test/clj`), TypeScript/Bun in `red/`, and
Python/uv in `blue/`. Each colour has five namespaces: `validate` (the
registry, the spec and the package's own checks), `ssh` (the keypair, wrapping
ONCE's), `ssh-config` (the `~/.ssh/config` block's alias, markers and the two
local refusals — this package's own, not ONCE's), `tools` (the stages and
acceptance) and `workflow` (the graph and `start-step`); red also carries
`once.ts`, the path-resolution shim for ONCE's unexported `ssh.ts`. The
templates live under `tools/infrastructure/digitalocean/`, `tools/dns/`,
`tools/ansible/` (the converge) and `tools/ansible-local/` (the three-file
local stage that writes the `~/.ssh/config` block). Green is canonical: a
behavioural change lands in all three colours in the same commit and passes
`scripts/parity.sh`, which renders both fixtures through every colour and
diffs the trees — and the colour template trees (`red/resources`, blue's
embedded `resources/`) — byte for byte. The fixtures and the goldens are
shared across colours at the repository root — `test/fixtures/` and
`test/resources/golden/` — with `green/test/fixtures` and
`green/test/resources` symlinks pointing at them. Each colour dir holds a
launcher symlink to its skill payload (`green/green`, `red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # regenerate after an intended change — read the diff first
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two keypair modes, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create     # requires explicit authorization
cd green && ./green delete     # guarded and destructive
```

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
never read `~/.ssh` or the state backend. A real create/delete requires
explicit authorization.

## The Compute Provider Standard, and what is delegated

The package conforms to the workspace Compute Provider Standard
(`../workspace/standards/compute-provider.md`) by **delegation**: the
operations — the `:provider-compute must be one of digitalocean` refusal, the
required keys, secrets and OpenTofu environment of the selected entry, the
CIDR grammar and the source rules (`digitalocean-ssh-sources` must list a
CIDR, `digitalocean-http-sources` may be empty), the per-provider checks (the
name rules and DigitalOcean's VPC refusal, whose wording is unchanged), the
provider-switch and legacy-state refusals, the one up-front state read,
`fallback-params`, `resolved-compute` and `adopt-state` — live in ONCE's
`compute` namespace, called with `validate/spec`. What stays here is the data
and the wiring: the one-entry registry, the default provider, the `:sources`
map, the template, `state-output`, `start-step`, and the graph. The
three-colour matrix of those operations is tested in ONCE; this package's
tests keep one wiring test per safety boundary and one spec-content test per
colour.

**The spec default is `digitalocean`**, the one provider this package ever
offered: the default is what a legacy state — `params` without `provider` —
is taken to be, and `restate-digitalocean`'s R2 state may still hold one.
Such a state is accepted on DigitalOcean and passes straight to the credential
check.

Three things this package used to do differently, and no longer does.
`state-output` swallowed every exception and delete merged `(or nil {})`, so
a stale backend credential would have pointed the cleanup playbook at
`192.0.2.10`; now an unreadable backend counts as no state on a real create
(a fresh clone has none) and fails a real delete closed with ONCE's wording,
`could not read the infrastructure state for the delete cleanup: <reason>`.
A real converge whose compute output carries no `ip` now refuses instead of
converging against the documentation address. And there is **no
`COLORS_PAR_IP` override**: ONCE's `adopt-state` applies none and this package
adds no wrapper, so the recorded address always wins on a delete.

## The keypair and the `~/.ssh/config` block

The package adopts keygen mode of the SSH Keypair Standard
(`../workspace/standards/ssh-keypair.md`): `digitalocean-ssh-keys` and
`digitalocean-name` are optional; absence of the key means the deployment
generates and owns `~/.ssh/<profile>` (ONCE's `ssh`, wrapped by `restate.ssh`
with a build-time placeholder home so the goldens name no workstation), the
compute template carries the `<% if ssh-keygen %>` branches whose opt-out side
contributes no byte, `ansible.cfg` names the private key in keygen mode, the
acceptance step's reboot `ssh` threads `identity-args`, and the delete graph
removes the key strictly **after** the compute destroy (`:restate/ssh-cleanup`).
The Droplet, the firewall and `params.name` derive from one resolved name
(`compute-name`, the Compute Name Standard): `digitalocean-name` when present,
else the profile.

The `~/.ssh/config` block follows the SSH Config Standard
(`../workspace/standards/ssh-config.md`) by copying its reference
implementation, born conforming: the marker is
`# BEGIN <profile> ANSIBLE MANAGED BLOCK` with no package prefix, so
`owned-markers` is a one-element set and no migration window exists. The
`restate-ansible-local` stage is one `blockinfile` task against
`~/.ssh/config`, run on `localhost` with `connection: local`, giving the
operator `ssh <profile>`. Two rules there are easy to undo by accident.

The play is **this package's own copy**, deliberately not shared with ONCE's,
which is the opposite choice from `ssh` above: the local play writes into a
file the operator shares with every host they reach, so sharing it would let
an unrelated upstream change rewrite that file at pin-bump time (standard §7).
`workspace/scripts/package-copies.py` is the net that keeps the copies in
step.

Address, user, alias and `block_state` arrive as **Ansible extra-vars, never
through Selmer**, which is what keeps `build` byte-identical across
workstations; the one Selmer conditional is the `IdentityFile`/`IdentitiesOnly`
pair, rendered in keygen mode only. `scripts/golden.sh` fails if a dotted quad
ever appears under `restate-ansible-local`.

Create writes the block after compute and before DNS and convergence
(`:restate/infrastructure → :restate/ssh-config → :restate/dns`). Delete
removes it *before* the destroy, which is the reverse of the keypair. The two
orders disagree on purpose and must not be tidied into agreement.

The block is inserted with `insertbefore: BOF`. Two local checks therefore run
on a real create only, after the keypair preflight and the credential check,
never on `build` or `--dry-run`: a `Host <profile>` stanza outside this
package's markers is an error naming the file and the line, never overwritten;
and an option standing above the first `Host` or `Match` line is an error too.
For a deployment this means a hand-written `Host restate-digitalocean` stanza
in the operator's `~/.ssh/config` makes a real create **refuse by design**:
remove or rename it if it is stale, or change `profile` if it belongs to
something else. That refusal is the standard working, not a bug to work
around.

## The two-fixture golden and parity axis

There are two fixtures under `test/fixtures/`: `colors.yml` (opt-out, profile
`restate-fixture`, an explicit key id and a name equal to the profile — the
shape of `restate-digitalocean`) and `keygen.yml` (`restate-keygen-fixture`,
neither key). Both say `provider-backend: r2` while the goldens live under
`golden/local/`; that path is historical and deliberately unchanged. One
committed golden tree per profile lives under `test/resources/golden/local/`.
**Adopting the standard changed the opt-out golden by the `params.provider`
line alone**: every resource address and attribute is untouched, the firewall
keeps its three unconditional inbound rules, and any further change there is a
plan against whatever the deployment's state holds. Adopting the SSH Config
Standard added one `restate-ansible-local/` tree to both goldens and changed
no other byte. `scripts/golden.sh` checks green against both and asserts the
keypair standard on each (a keygen tree declares the profile-named key
resource and references it by attribute; an opt-out tree creates none and
keeps the literal id; no rendered tree names `$HOME/.ssh`) and the config
standard's §6 (no dotted quad under `restate-ansible-local`).

## Coupling

The package pins Green and ONCE in `green/deps.edn`, the Red SDK and
`package-once-red` in `red/package.json`, and the Blue SDK and
`package-once-blue` in `blue/pyproject.toml`. All three colours pin ONCE at the
**same rev** (`38e3cd6`) — ONCE's own parity is what guarantees its colours
agree per commit. The green pin (`3f33f5d`) is a floor coupled to that ONCE
rev: ONCE 38e3cd6 trusts the SDK's step error alone when it reads state, and
green 3f33f5d is where the SDK reports a tofu launch failure (a missing stage
directory or binary) as that step error, the way red and blue always did; an
older green under this ONCE would crash a fresh-clone create instead of
reporting its credentials, so the two pins move together. ONCE supplies the
backend provider registry, the `compute` namespace (the Compute Provider
Standard's operations over this package's own registry) and the `ssh`
namespace (the SSH Keypair Standard); the red launcher's `PINS`, the blue
launcher's PEP 723 block and `green/tasks/pin.clj` carry the same rev. A pin
bump is read through `scripts/golden.sh`: the opt-out golden renders the
historical shape byte for byte whatever ONCE's keypair default is, because
presence of `digitalocean-ssh-keys` in that fixture is what selects opt-out.
`blue/pyproject.toml` carries a `[tool.uv] override-dependencies` block, now
redundant because `package-once-blue` at `38e3cd6` pins the same Blue rev, and
kept because it is harmless and would make this package's Blue pin win were
ONCE ever to pin an older one again. Between a commit that moves the ONCE pin
and the `bb pin` that re-stamps the launchers, the blue launcher's inline
metadata pins `package-restate-blue` at the previous commit — whose
`pyproject.toml` pins the previous ONCE — and `uv run --script` refuses the
conflicting URLs before `RESTATE_LIB_ROOT` is consulted; run blue through the
project meanwhile (`cd blue && uv run python -m package_restate_blue …`).

Use `RESTATE_LIB_ROOT` (the repository root, for every colour; red also
accepts the `red/` dir directly), `GREEN_LIB_ROOT`, and `ONCE_LIB_ROOT` for
working-tree development. Final launchers use a pushed SHA managed by `bb pin`
(in `green/`), which stamps all three payloads from their unpinned birth forms;
deployment launchers are copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
The launcher pins are managed only by `bb pin` (in `green/`) after a clean
pushed commit; never invent a SHA.
