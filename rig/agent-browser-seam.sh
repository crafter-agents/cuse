#!/bin/bash
# Where a browser automation tool goes blind, and whether cuse can see there.
#
# agent-browser drives web content through CDP. When a page's file input is
# clicked, the browser hands the job to the operating system: macOS raises an
# NSOpenPanel that runs in another process entirely
# (com.apple.appkit.xpc.openAndSavePanelService). It is not in the DOM, so CDP
# cannot see it, cannot enumerate it and cannot dismiss it. agent-browser even
# ships an `upload` command that uses CDP's setFileInputFiles to bypass the
# panel, which is the clearest admission that the panel is a wall.
#
# This asserts three things in order, and each one can fail on its own:
#
#   1. clicking the input really does raise a native panel
#   2. agent-browser cannot see it        <- the gap
#   3. cuse can, and can press a button in it  <- the complement
#
# Deliberately not driving the whole file-picking flow: choosing a file means
# navigating a column browser whose rows answer to AXOpen rather than a click,
# and a gate that flaky proves less than these three facts do.
set -uo pipefail

CUSE="${CUSE:-./cuse}"
AB="${AB:-agent-browser}"
PORT="${PORT:-8731}"
fail() { echo "FAIL: $*"; exit 1; }

# Everything here talks to a browser and a window server, and both can hang.
cap() {
  local s="$1"; shift
  "$@" </dev/null & local p=$!
  ( sleep "$s"; kill -9 "$p" 2>/dev/null ) & local w=$!
  wait "$p" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null
  return "$rc"
}

cleanup() {
  cap 20 "$AB" close --all >/dev/null 2>&1 || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

# file:// gives Chrome for Testing a network error, so the page is served.
python3 -m http.server "$PORT" --directory rig >/dev/null 2>&1 &
SERVER_PID=$!
sleep 2

echo "--- open the page ---"
# Never gate on `open`'s exit code. It leaves a persistent daemon behind by
# design, so the command does not return the way a one-shot does; the first
# version of this script capped it at 60s, killed it, and called a browser that
# had in fact launched a failure. Whether a window exists is the question, and
# cuse is the one that can answer it without asking agent-browser.
cap 90 "$AB" open "http://localhost:$PORT/upload-page.html" --headed > open.log 2>&1
echo "open exit=$? (not the assertion)"
tail -5 open.log 2>/dev/null || true
sleep 3

echo "--- is there actually a browser window ---"
"$CUSE" windows --json > windows.json
head -c 400 windows.json; echo
grep -qi "chrome" windows.json || {
  echo "--- what open said ---"; cat open.log
  fail "no Chrome window on screen: the page never opened"
}
echo "a browser window is up"

echo "--- click the file input, which hands over to the OS ---"
# This blocks in some builds: the panel is modal to the page. Bounded, and its
# exit code is not the assertion - the panel appearing is.
cap 25 "$AB" click "#f" >/dev/null 2>&1 || true
sleep 3

# 1. The panel exists. Named by role rather than by title, because the panel's
#    window title differs across macOS versions.
echo "--- 1. did a native panel appear ---"
"$CUSE" elements "Google Chrome" --json > panel.json || fail "cuse could not read Chrome's tree"
head -c 400 panel.json; echo
grep -q '"name":"Cancel"' panel.json || {
  echo "controls cuse did see:"; grep -oE '"name":"[^"]{1,30}"' panel.json | sort -u | head -20
  fail "no Cancel button: the click did not raise a file panel"
}
echo "a native panel is up, and cuse names its controls"

# 2. CDP cannot see it. agent-browser's own snapshot is the witness.
echo "--- 2. can agent-browser see it ---"
cap 30 "$AB" snapshot > ab-snapshot.txt 2>&1 || true
head -c 300 ab-snapshot.txt; echo
if grep -qiE "\bCancel\b|openAndSavePanel|NSOpenPanel" ab-snapshot.txt; then
  fail "agent-browser reported the native panel - the premise of this gate is wrong, which is worth knowing"
fi
echo "agent-browser's snapshot does not contain the panel, as expected"

# 3. cuse can act on it. Pressing Cancel is the smallest real action, and the
#    panel going away is the oracle - nothing else makes it disappear.
echo "--- 3. press Cancel in the out-of-process panel ---"
"$CUSE" click --element=Cancel --role=button --app="Google Chrome" --json || fail "cuse could not press Cancel"
sleep 2
"$CUSE" elements "Google Chrome" --json > after.json || true
if grep -q '"name":"Cancel"' after.json; then
  fail "Cancel was pressed and the panel is still there"
fi
echo "the panel is gone: cuse acted on a surface agent-browser cannot reach"

echo "VERDICT: PASS"
