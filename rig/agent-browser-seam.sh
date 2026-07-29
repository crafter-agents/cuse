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
"$CUSE" elements "Google Chrome" --json > panel.json || fail "cuse could not read Chrome's tree"
echo "--- windows on screen ---"
"$CUSE" windows --json > windows-after-click.json || true
head -c 500 windows-after-click.json; echo
echo "--- distinct controls cuse can see ---"
bun -e '
  const els = (await Bun.file("panel.json").json()).data ?? [];
  const seen = new Map();
  for (const e of els) {
    const k = `${e.role}|${e.name}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  console.log(`${els.length} controls, ${seen.size} distinct role+name`);
  for (const [k, e] of [...seen].slice(0, 60)) {
    console.log(`  ${e.role.padEnd(12)} ${JSON.stringify(e.name).padEnd(34)} ${e.width}x${e.height} at ${e.x},${e.y}`);
  }
  // An NSOpenPanel is identifiable by its structure, not by one common word:
  // a window titled Open, a sidebar outline, or a column browser.
  const panel = els.find((e) =>
    (e.role === "window" && /^open$/i.test(e.name)) ||
    (/outline|browser/.test(e.role) && /sidebar|column/i.test(e.name)) ||
    /column view/i.test(e.name));
  if (!panel) {
    console.log("NO-PANEL");
  } else {
    console.log(`PANEL ${panel.role} ${JSON.stringify(panel.name)} at ${panel.x},${panel.y}`);
  }
' | tee panel-summary.txt

grep -q "^PANEL " panel-summary.txt || {
  echo "clicking the file input did not produce a panel cuse can identify."
  echo "That is the finding: either the click never reached the input, or the"
  echo "panel is not in this process tree. The dump above is the evidence."
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
#    rectangle - Chrome has its own, and picking by name alone is what made the
#    first attempt click the corner of the window.
echo "--- 3. press the panel's own Cancel ---"
read -r CX CY < <(bun -e '
  const els = (await Bun.file("panel.json").json()).data ?? [];
  const panel = els.find((e) =>
    (e.role === "window" && /^open$/i.test(e.name)) ||
    (/outline|browser/.test(e.role) && /sidebar|column/i.test(e.name)) ||
    /column view/i.test(e.name));
  if (!panel) throw new Error("panel vanished between steps");
  const inside = (e) =>
    e.x >= panel.x - 400 && e.y >= panel.y - 200 &&
    e.x + e.width <= panel.x + panel.width + 400 &&
    e.y + e.height <= panel.y + panel.height + 200;
  const cancel = els.filter((e) => e.role === "button" && /^cancel$/i.test(e.name) && inside(e))
                    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  if (!cancel) throw new Error("no Cancel button inside the panel");
  console.log(`${Math.round(cancel.x + cancel.width / 2)} ${Math.round(cancel.y + cancel.height / 2)}`);
') || fail "could not locate the panel's Cancel button"
echo "clicking $CX,$CY"
"$CUSE" click "$CX" "$CY" --json || fail "cuse could not click"
sleep 3

"$CUSE" elements "Google Chrome" --json > after.json || true
bun -e '
  const els = (await Bun.file("after.json").json()).data ?? [];
  const panel = els.find((e) =>
    (e.role === "window" && /^open$/i.test(e.name)) ||
    (/outline|browser/.test(e.role) && /sidebar|column/i.test(e.name)) ||
    /column view/i.test(e.name));
  console.log(panel ? "STILL-THERE" : "GONE");
' | tee after-summary.txt

grep -q "^GONE" after-summary.txt || fail "Cancel was pressed and the panel is still there"
echo "the panel is gone: cuse acted on a surface agent-browser cannot reach"

echo "VERDICT: PASS"
