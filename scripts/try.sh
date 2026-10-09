#!/bin/sh
# Adds this middleware to a magpie in a sandbox of its own (.sandbox/), so your
# real magpie, agents and sign-ins are never touched:
#   scripts/try.sh                    # add it and list what loaded
#   scripts/try.sh options image-slim '{"keep_last":0}'
#   scripts/try.sh off image-slim     # turn it off
# MAGPIE is the magpie binary (default: magpie on PATH).
#
# The sandbox is given HOME, and USERPROFILE too: on Windows magpie's home
# comes from USERPROFILE and HOME is not read.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
sb=$root/.sandbox
mkdir -p "$sb"
m=${MAGPIE:-magpie}
run() { env -i PATH="$PATH" HOME="$sb" USERPROFILE="$sb" XDG_CONFIG_HOME="$sb/.config" XDG_CACHE_HOME="$sb/.cache" "$m" "$@"; }
if [ ! -f "$sb/.added" ]; then
  run plugin add "$root" </dev/null
  touch "$sb/.added"
fi
if [ "$#" -eq 0 ]; then run plugin </dev/null; else run plugin "$@"; fi
