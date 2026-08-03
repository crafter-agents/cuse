#!/bin/bash
# Self-test of the cuse CLI on whatever OS this runner is. Same commands everywhere.
#
# This script used to pass green while doing nothing. It looked for the binary at
# ./bin/cu, a path that died when the repo was renamed to cuse, so `$CU os`
# expanded to an empty string, every action silently did nothing, and the script
# still exited 0. Dispatched across three runners on 2026-08-03 it printed
# CU-INCOMPLETE on all three and repro-farm reported success on all three,
# because the workflow reads the exit code and the exit code was fine.
#
# So: find the binary or die, and make the verdict decide the exit status. A
# green gate is spent. Nobody checks it twice, which is why a false green is
# worse than a red.
set -uo pipefail

# Run from the repo root, whatever the caller's directory is. repro-farm invokes
# this as `target/scenarios/cuse-selftest.sh` from the workspace root, so every
# relative path below (src/cli.ts, dist/cuse) resolved against the wrong
# directory and the build block never even ran: the three runners reported
# "could not build one" without printing a single line from inside it.
#
# A scenario that only works when invoked from one directory is not a scenario,
# it is a local script with a coincidence.
SCENARIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCENARIO_DIR")"
cd "$REPO_ROOT" || { echo "FAIL: cannot enter repo root $REPO_ROOT"; echo "=== VERDICT ==="; echo "CU-INCOMPLETE"; exit 1; }
echo "repo root: $REPO_ROOT"

# Build from source when there is no binary: a checkout has src/, not dist/.
CU=""
for candidate in ./dist/cuse ./bin/cuse ./bin/cu; do
  [ -x "$candidate" ] && { CU="$candidate"; break; }
done
if [ -z "$CU" ] && command -v cuse >/dev/null 2>&1; then CU="$(command -v cuse)"; fi
# A fresh checkout has src/ and no dist/: dist is gitignored, and the runner is
# not required to arrive with a toolchain. So build it here rather than assume
# somebody else did. Verified 2026-08-03: repro-farm clones the target and runs
# the scenario directly, with no setup step, so a scenario that only looks for a
# prebuilt binary can never work there.
if [ -z "$CU" ] && [ -f src/cli.ts ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "no bun on PATH; installing it (needed to build cuse from source)"
    curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
  fi
  if command -v bun >/dev/null 2>&1; then
    echo "building from source with $(bun --version)"
    if bun build --compile src/cli.ts --outfile dist/cuse >/dev/null 2>&1 && [ -x dist/cuse ]; then
      CU="./dist/cuse"
    else
      # Compiling can fail where running does not, so fall back rather than
      # give up: the point is to exercise cuse, not to prove the build works.
      echo "compile failed; running from source instead"
      CU="bun run src/cli.ts"
    fi
  fi
fi
if [ -z "$CU" ]; then
  echo "FAIL: no cuse binary found and could not build one (looked for dist/cuse, bin/cuse, bin/cu, cuse on PATH, and building src/cli.ts with bun)"
  echo "=== VERDICT ==="
  echo "CU-INCOMPLETE"
  exit 1
fi
echo "using: $CU"

# Every probe below asserts. A command that prints nothing and exits 0 is the
# failure mode this whole file exists to catch.
OS="$($CU os --json 2>/dev/null | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')"
[ -z "$OS" ] && OS="$($CU os 2>/dev/null | tr -d '\r\n')"
if [ -z "$OS" ]; then
  echo "FAIL: cuse os returned nothing, so the binary is not answering"
  echo "=== VERDICT ==="
  echo "CU-INCOMPLETE"
  exit 1
fi
echo "=== cuse self-test on $OS ==="

# Linux runners are headless: there is no X server, so capture returns nothing
# and every input action has nowhere to go. Dispatched on 2026-08-03 that showed
# up as six honest failures on ubuntu while macos and windows passed.
#
# The repo already knows the answer. .github/workflows/release.yml and
# scenarios/linux-local.sh both drive cuse through xvfb-run with the same
# server args, so this reuses that recipe rather than inventing a second one.
# Re-exec once under a virtual display, guarded so the second pass does not try
# again.
if [ "$OS" = "linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${CUSE_SELFTEST_XVFB:-}" ]; then
  # A display is necessary but not sufficient: cuse reaches X through xwd and
  # xdotool, and a bare runner has neither. Install what is missing before
  # re-execing, so the run does not fail six checks for a reason that one
  # apt-get line answers. Best effort: if apt is unavailable the checks below
  # will say exactly which tool was missing.
  missing=""
  for tool in xvfb-run xwd xdotool xterm; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  if [ -n "$missing" ] && command -v apt-get >/dev/null 2>&1; then
    echo "installing X tooling for headless linux:$missing"
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo apt-get install -y -qq xvfb x11-apps xdotool xterm >/dev/null 2>&1 || true
  fi
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "headless linux: re-running under xvfb-run"
    export CUSE_SELFTEST_XVFB=1
    # SCENARIO_DIR, not BASH_SOURCE: the script already cd'd to the repo root, so
    # the relative path it was invoked with no longer resolves. Observed on
    # ubuntu 2026-08-03, from the artifact: "bash:
    # target/scenarios/cuse-selftest.sh: No such file or directory" right after
    # the re-exec line.
    exec xvfb-run -a --server-args="-screen 0 1280x1024x24" bash "$SCENARIO_DIR/$(basename "${BASH_SOURCE[0]}")" "$@"
  fi
  # Say what is missing instead of failing six checks that all mean one thing.
  echo "SKIP-ALL: headless linux with no xvfb-run; cuse needs an X server here"
  echo "  install it with: apt-get install -y xvfb"
  echo "=== VERDICT ==="
  echo "CU-INCOMPLETE on linux: no display and no xvfb-run to provide one"
  exit 1
fi

fails=0
skipped=0
note() { echo "$1"; }
bad()  { echo "FAIL: $1"; fails=$((fails + 1)); }
# A locked session refuses input on purpose: keystrokes would reach the login
# window instead of the app. That is cuse working, not cuse broken, and calling
# it a failure would train whoever reads this to ignore a red run. It is still
# printed, because a run that could not test input is not a run that tested it.
skip() { echo "SKIP: $1"; skipped=$((skipped + 1)); }
locked() { printf '%s' "$1" | grep -qi "session is locked"; }
try_input() {
  local label="$1"; shift
  local out; out="$("$@" --json 2>&1)"
  if printf '%s' "$out" | grep -q '"ok":true'; then note "${label}-OK"; return 0; fi
  if locked "$out"; then skip "$label: the session is locked, input cannot be tested here"; return 0; fi
  bad "$label: $(printf '%s' "$out" | head -c 120)"
}

echo "--- capture ---"
if $CU capture before.png >/dev/null 2>&1 && [ -s before.png ]; then
  note "CAPTURE-OK ($(wc -c < before.png) bytes)"
else
  # A headless runner may genuinely have no display. That is a real answer about
  # where cuse can run, not a script bug, so it is reported rather than hidden.
  bad "capture produced no file (headless runner with no display?)"
fi

echo "--- launch app (OS picks the app) ---"
case "$OS" in
  macos)   $CU launch TextEdit >/dev/null 2>&1 || bad "launch TextEdit" ;;
  windows) $CU launch "C:\\Windows\\System32\\notepad.exe" >/dev/null 2>&1 || bad "launch notepad" ;;
  linux)   $CU launch xterm >/dev/null 2>&1 || bad "launch xterm" ;;
  *)       bad "unknown os '$OS'" ;;
esac
sleep 2
note "LAUNCH-DONE"

echo "--- type (agnostic verb) ---"
try_input TYPE $CU type "cuse made this cross-platform"

echo "--- batched actions in one process ---"
# Added 2026-08-03 with the run command: the batch path deserves the same
# cross-platform proof as the single actions.
$CU run '[["os"],["os"]]' >/dev/null 2>&1 && note "RUN-OK" || bad "run batch"

echo "--- key chord (agnostic, mapped per OS) ---"
case "$OS" in
  macos) try_input KEY $CU key "cmd+a" ;;
  *)     try_input KEY $CU key "ctrl+a" ;;
esac

echo "--- capture after ---"
sleep 1
if $CU capture after.png >/dev/null 2>&1 && [ -s after.png ]; then
  note "CAPTURE-OK ($(wc -c < after.png) bytes)"
else
  bad "second capture produced no file"
fi

echo "=== VERDICT ==="
if [ "$fails" -eq 0 ] && [ -s before.png ] && [ -s after.png ]; then
  if [ "$skipped" -gt 0 ]; then
    # Green, but say what was not covered. A verdict that hides its own gaps is
    # how a gate ends up passing while measuring nothing.
    echo "CU-GREEN on $OS: same commands, right primitives ($skipped check(s) skipped, see SKIP lines)"
  else
    echo "CU-GREEN on $OS: same commands, right primitives"
  fi
  exit 0
fi
echo "CU-INCOMPLETE on $OS: $fails check(s) failed, $skipped skipped"
exit 1
