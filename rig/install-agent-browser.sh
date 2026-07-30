#!/bin/bash
# Put one specific agent-browser on PATH: a published version, or the build of a
# pull request.
#
# The rig started as a nightly gate against one pinned version, which is the
# wrong shape for reproducing an issue. A report says "0.32.3 does this and
# 0.33.1 does not", and answering that needs the version to be an input. The
# other half is "does PR 1451 fix it", which needs a build from source.
#
#   AB_VERSION=0.33.1  rig/install-agent-browser.sh
#   AB_PR=1451         rig/install-agent-browser.sh
#
# Read-only against the upstream repository: clone and fetch a PR head, never
# push. Nothing here writes anywhere but this workspace.
set -euo pipefail

AB_VERSION="${AB_VERSION:-0.33.1}"
AB_PR="${AB_PR:-}"
UPSTREAM="${UPSTREAM:-https://github.com/vercel-labs/agent-browser.git}"

if [ -z "$AB_PR" ]; then
  echo "installing agent-browser@$AB_VERSION from npm"
  bun add -g "agent-browser@$AB_VERSION"
  # bun's global bin, which is not on PATH in a fresh runner.
  echo "$HOME/.bun/bin" >> "${GITHUB_PATH:-/dev/null}"
  export PATH="$HOME/.bun/bin:$PATH"
  agent-browser --version || true
  exit 0
fi

echo "building agent-browser from pull request #$AB_PR"
rm -rf ab
# Blobless clone: the history is not needed, only one commit's trees.
git clone --filter=blob:none --no-checkout "$UPSTREAM" ab
git -C ab fetch --depth 1 origin "refs/pull/$AB_PR/head:pr"
git -C ab checkout pr
echo "head: $(git -C ab log --oneline -1)"

# Debug rather than release: minutes matter more than milliseconds when the
# question is whether a behaviour changed.
cargo build --manifest-path ab/cli/Cargo.toml

BIN="$PWD/ab/cli/target/debug/agent-browser"
[ -x "$BIN" ] || { echo "the build produced no binary at $BIN"; exit 1; }

# The scenarios call `agent-browser` by name, so the patched build is shimmed
# onto PATH under that name rather than every script learning about this.
mkdir -p .bin
ln -sf "$BIN" .bin/agent-browser
echo "$PWD/.bin" >> "${GITHUB_PATH:-/dev/null}"
export PATH="$PWD/.bin:$PATH"
agent-browser --version || true
