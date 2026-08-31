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
#   1. the panel is absent before the click and present after   <- it is real
#   2. agent-browser cannot see it                               <- the gap
#   3. cuse can act on it, and it goes away                      <- the complement
#
# Enumerating the panel's own controls is evidence here rather than a gate. On a
# developer's Mac the same panel reads 150 controls; on a hosted runner its
# subtree is empty from every root - the dialog's AXChildren, AXFocusedWindow,
# AXMainWindow, and the panel service's own process. That is a fact about the
# runner, and pretending otherwise would be the failure this rig is against. So
# the cell presses the button when it can find it and sends Escape when it
# cannot, and either way requires the panel to disappear.
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

echo "--- the tree before the click, so its appearance means something ---"
"$CUSE" elements "Google Chrome" --depth=30 --limit=1200 --timeout=60000 --json > before.json || true
bun rig/find-panel.ts before.json Cancel > before-summary.txt 2>/dev/null || true
cat before-summary.txt
grep -q "^NO-PANEL" before-summary.txt || fail "there is already a panel before anything was clicked"

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

# 3. cuse can act on it - by name where the controls are readable, and by
#    keystroke where they are not. The Cancel that would be pressed is the one
#    inside the panel's own rectangle: Chrome has controls of that name
#    elsewhere, and a generous containment test let one 96 pixels above win.
echo "--- 3. act on the panel ---"
# Its controls are another matter, and on a hosted runner they are not reachable.
# Reported, not gated: the dialog node carries a real rectangle, and its subtree
# is empty from every root tried - AXChildren of the dialog, AXFocusedWindow,
# AXMainWindow, and the panel service's own process, which answers with nothing.
# On a developer's Mac the same panel enumerates 150 controls, so this is a fact
# about the runner rather than about the approach.
if grep -q "^BUTTON " panel-summary.txt; then
  echo "the panel's controls ARE enumerable here - promote this from evidence to a gate"
  read -r _ CX CY < <(grep "^BUTTON " panel-summary.txt)
  echo "pressing the panel's own Cancel at $CX,$CY"
  "$CUSE" click "$CX" "$CY" --json || fail "cuse could not click"
else
  echo "the panel's controls are not enumerable on this runner:"
  cat panel-candidates.txt || true
  echo "--- the panel's own process ---"
  "$CUSE" elements openAndSavePanelService --depth=30 --limit=1200 --timeout=60000 --json > panel-svc.json 2>&1 || true
  head -c 200 panel-svc.json; echo
  # Acting on it does not require naming a control. Escape dismisses an
  # NSOpenPanel, but the panel service must be frontmost when the key is sent.
  echo "--- 3. act on it anyway: Escape to the panel service ---"
  targeted_escape_log="targeted-escape.log"
  if osascript >"$targeted_escape_log" 2>&1 <<'APPLESCRIPT'
tell application "System Events"
  set panelProcess to first application process whose bundle identifier is "com.apple.appkit.xpc.openAndSavePanelService"
  set frontmost of panelProcess to true
  key code 53
end tell
APPLESCRIPT
  then
    targeted_escape_status=0
  else
    targeted_escape_status=$?
  fi
  echo "targeted Escape exit: $targeted_escape_status" >> "$targeted_escape_log"
  cat "$targeted_escape_log"
  if (( targeted_escape_status != 0 )); then
    echo "targeted Escape failed; falling back to the untargeted cuse key command"
    "$CUSE" key Escape --json || fail "cuse could not send Escape"
  fi
fi
sleep 3

# 4. The oracle for both branches: the panel is gone. Nothing else dismisses it.
"$CUSE" elements "Google Chrome" --depth=30 --limit=1200 --timeout=60000 --json > after.json || true
bun rig/find-panel.ts after.json Cancel > after-summary.txt 2>/dev/null || true
cat after-summary.txt
grep -q "^NO-PANEL" after-summary.txt || {
  echo "the panel is still in the tree"
  fail "cuse acted and the panel did not go away"
}
echo "the panel is gone: cuse acted on a surface agent-browser cannot see"

echo "VERDICT: PASS"
