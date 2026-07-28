#!/usr/bin/env bash
# Reproduce a real defect, and verify its documented workaround, using cuse.
#
# The defect: on Windows Server, `notepad` on the PATH is an App Execution Alias
# whose Store package is not provisioned. Starting it succeeds - a process is
# created and every API says so - and no window ever appears. Anything driving
# the desktop then types into nothing while its exit codes stay at zero, which is
# the failure mode this tool is built around.
#
# The workaround, from Microsoft's own guidance: call the classic binary in
# System32 by full path.
#
# Both halves are asserted here: the broken path must fail *and say why*, and the
# working path must land a keystroke provably, on disk.
set -uo pipefail

CUSE=${1:-./cuse}
say() { printf '\n== %s\n' "$1"; }

say "the defect: launching through the alias"
launch=$("$CUSE" launch notepad --json)
echo "  $launch"
# The launch itself succeeds - that is the whole problem.
echo "$launch" | grep -q '"ok":true' || {
  echo "expected the alias launch to report success (that is the defect)"; exit 1; }

waited=$("$CUSE" wait --window=Notepad --timeout=8000 --json || true)
echo "  $waited"
echo "$waited" | grep -q '"ok":false' || {
  echo "a Notepad window appeared: this runner does provision the package, so the"
  echo "defect no longer reproduces here and this gate should be revisited"; exit 1; }
echo "$waited" | grep -q 'never appeared' || {
  echo "expected the wait to say the window never appeared, got: $waited"; exit 1; }
echo "  reproduced: launch reported success and no window ever existed"

say "the workaround: the classic binary, by full path"
target="$(pwd -W 2>/dev/null || pwd)/notepad-target.txt"
printf 'initial line\r\n' > notepad-target.txt
powershell -NoProfile -Command "Start-Process \"\$env:SystemRoot\System32\notepad.exe\" -ArgumentList '$target'" || {
  echo "the classic binary would not start either"; exit 1; }

"$CUSE" wait --window=notepad-target --timeout=25000 --json || {
  echo "the classic binary started but never presented a window"; exit 1; }
"$CUSE" focus notepad-target --json
"$CUSE" elements notepad-target --json | tee notepad-elements.json

say "type into it, and prove it on disk"
"$CUSE" type "cuse typed into the classic notepad" --expect-front=notepad-target --json
"$CUSE" key ctrl+s --json
sleep 3
cat notepad-target.txt
grep -q "cuse typed into the classic notepad" notepad-target.txt || {
  echo "the keystrokes never reached the document"
  "$CUSE" frontmost --json || true
  "$CUSE" windows --json || true
  exit 1; }
echo "  the workaround works, and cuse proved it by what the file contains"
