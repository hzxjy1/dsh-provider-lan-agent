#!/usr/bin/env bash
#
# Recreate the DEV-ONLY module-resolution anchor beside this package.
#
# WHY
# ---
# `subagent.js` imports `@deepseek-ai/dsh-subagent` and
# `@deepseek-ai/dsh-subprocess` at runtime. A profile install resolves those
# through dsh's own config-tree resolution anchor, so the shipped package needs
# no `node_modules` of its own (it declares them as peerDependencies instead,
# exactly like the installed `@mars-sea/dsh-commandcode-provider`).
#
# Running `test/subagent-harness.mjs` straight from this directory is a
# different story: nothing anchors the bare specifiers there, so the harness
# needs this link. It must NOT be committed or installed — a symlink into a
# versioned nix store path goes stale the moment dsh is upgraded.
#
# The offline `node --test` suite deliberately needs no anchor: the modules it
# imports carry no bare specifier.
#
# USAGE
#   test/make-anchor.sh            # derive the anchor from the `dsh` on PATH
#   test/make-anchor.sh <dir>      # or name a directory containing @deepseek-ai/*
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"

if [[ -z "$target" ]]; then
  install_js="$(grep -ohE '/[^"[:space:]]*lib/bin\.js' "$(command -v dsh)" | head -1 || true)"
  if [[ -z "$install_js" ]]; then
    echo "make-anchor: cannot derive the dsh install path from '$(command -v dsh)'; pass a directory instead" >&2
    exit 1
  fi
  target="$(cd "$(dirname "$install_js")/.." && pwd)/node_modules"
fi

if [[ ! -d "$target/@deepseek-ai" ]]; then
  echo "make-anchor: '$target' does not contain @deepseek-ai/* — wrong directory?" >&2
  exit 1
fi

ln -sfn "$target" "$here/node_modules"
echo "make-anchor: $here/node_modules -> $target"
echo "now run:  node $here/scripts/subagent-harness.mjs"
