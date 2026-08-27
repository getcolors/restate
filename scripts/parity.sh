#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed goldens; this is the net across colours:
# the fixture is rendered by green, red, and blue into separate work
# directories and the trees must be identical — and the template trees each
# colour carries must be identical too, because the copies are the mechanism
# (red/resources and blue's embedded resources are copies of green's tree, not
# references to it).
#
# One fixture, because the goldens have a single axis: restate renders one
# profile, and its committed tree already exercises the r2 state backend.
#
# Renders resolve each colour's package from this working tree (the
# RESTATE_LIB_ROOT overrides), while green, once, red, and blue stay on their
# pins — a change that lands here passes parity before it is pushed or pinned
# anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

for colour in green red blue; do
  sed "s#WORKDIR#$tmp/$colour#" "$root/test/fixtures/colors.yml" > "$tmp/$colour.yml"
done
(cd "$root/green" && RESTATE_LIB_ROOT="$root" ./green build -f "$tmp/green.yml" >/dev/null)
(cd "$root/red" && RESTATE_LIB_ROOT="$root/red" ./red build -f "$tmp/red.yml" >/dev/null)
(cd "$root/blue" && uv run python -m package_restate_blue build -f "$tmp/blue.yml" >/dev/null)
diff -r "$tmp/green" "$tmp/red"
diff -r "$tmp/green" "$tmp/blue"

diff -r "$root/green/src/resources/io/github/getcolors/restate" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/restate" "$root/blue/src/package_restate_blue/resources"

echo "green, red, and blue Restate artifacts are byte-identical"
