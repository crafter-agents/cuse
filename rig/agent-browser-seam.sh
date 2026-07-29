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

# 1. The panel exists, and is identifiable as a panel.
#    The first version grepped for a control named Cancel and passed on Chrome's
#    own chrome: 217 controls came back, one of them matched, and the click
#    landed on an 81x18 box at 81,18 - the top-left corner of the window. A name
#    that common is not an identification.
echo "--- 1. did a native panel appear ---"
# The panel's buttons nest deeper than the default twelve levels inside
# Chrome's tree, and Chrome's own chrome uses up the default node budget,
# so the panel was identified while its Cancel was never in the dump.
"$CUSE" elements "Google Chrome" --depth=30 --limit=1200 --timeout=60000 --json > panel.json \
  || fail "cuse could not read Chrome's tree"
# If the walk stopped early it says so, and a missing button then means the
# clock rather than the app.
grep -o '"warn":"[^"]*"' panel.json || echo "(the walk was not truncated)"
echo "--- windows on screen ---"
"$CUSE" windows --json > windows-after-click.json || true
head -c 500 windows-after-click.json; echo
echo "--- distinct controls cuse can see ---"
bun -e '
  const els = (await Bun.file("panel.json").json()).data ?? [];
  const seen = new Map();
  for (const e of els) { const k = `${e.role}|${e.name}`; if (!seen.has(k)) seen.set(k, e); }
  console.log(`${els.length} controls, ${seen.size} distinct role+name`);
  for (const [, e] of [...seen].slice(0, 60)) {
    console.log(`  ${e.role.padEnd(12)} ${JSON.stringify(e.name).slice(0, 40).padEnd(42)} ${e.width}x${e.height} at ${e.x},${e.y}`);
  }
'
# One place decides what the panel is, used by this step and the click below.
# Two copies of this logic is what pressed a control in the tab strip.
bun rig/find-panel.ts panel.json Cancel > panel-summary.txt 2> panel-candidates.txt
cat panel-summary.txt; cat panel-candidates.txt || true

grep -q "^PANEL " panel-summary.txt || {
  echo "clicking the file input did not produce a panel cuse can identify."
  echo "Either the click never reached the input, or the panel is not in this"
  echo "process tree. The dump above is the evidence."
  fail "no identifiable file panel"
}
echo "a native panel is up, and cuse can pick it out of the tree"

# 2. CDP cannot see it. agent-browser's own snapshot is the witness.
echo "--- 2. can agent-browser see it ---"
cap 30 "$AB" snapshot > ab-snapshot.txt 2>&1 || true
head -c 300 ab-snapshot.txt; echo
if grep -qiE "\bCancel\b|openAndSavePanel|NSOpenPanel" ab-snapshot.txt; then
  fail "agent-browser reported the native panel - the premise of this gate is wrong, which is worth knowing"
fi
echo "agent-browser's snapshot does not contain the panel, as expected"

# 3. cuse can act on it. The Cancel that matters is the one inside the panel's
#    own rectangle - Chrome has controls of that name elsewhere, and a generous
#    containment test let one 96 pixels above the panel win.
echo "--- 3. press the panel's own Cancel ---"
if ! grep -q "^BUTTON " panel-summary.txt; then
  echo "candidates considered from Chrome's tree:"; cat panel-candidates.txt
  # Second hypothesis, tested in the same run rather than costing another: the
  # panel is a separate process, and although its dialog shows up in Chrome's
  # tree, its controls may only be enumerable from the process that owns them.
  # That process has no .app bundle, which is why it is reachable at all.
  echo "--- trying the panel's own process ---"
  "$CUSE" elements openAndSavePanelService --depth=30 --limit=1200 --timeout=60000 --json > panel-svc.json 2>&1 || true
  head -c 300 panel-svc.json; echo
  bun rig/find-panel.ts panel-svc.json Cancel > svc-summary.txt 2> svc-candidates.txt || true
  cat svc-summary.txt; cat svc-candidates.txt || true
  if grep -q "^BUTTON " svc-summary.txt; then
    echo "the panel's controls live in its own process, not in Chrome's tree"
    cp svc-summary.txt panel-summary.txt
  else
    fail "no Cancel button inside the panel, in either process"
  fi
fi
read -r _ CX CY < <(grep "^BUTTON " panel-summary.txt)
echo "clicking $CX,$CY"
"$CUSE" click "$CX" "$CY" --json || fail "cuse could not click"
sleep 3

"$CUSE" elements "Google Chrome" --depth=30 --limit=1200 --timeout=60000 --json > after.json || true
bun rig/find-panel.ts after.json Cancel > after-summary.txt 2>/dev/null || true
cat after-summary.txt
grep -q "^NO-PANEL" after-summary.txt || {
  echo "the panel is still in the tree after pressing Cancel"
  fail "Cancel was pressed and the panel is still there"
}
echo "the panel is gone: cuse acted on a surface agent-browser cannot reach"

echo "VERDICT: PASS"
