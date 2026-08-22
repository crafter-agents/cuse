#!/usr/bin/env bash
# The documented workaround for the alias defect: call the classic binary in
# System32 by full path. Verified the only way that counts - a keystroke read
# back off disk.
#
# On a clean runner, with no alias launch anywhere near it, so nothing else holds
# the keyboard.
set -uo pipefail
CUSE=${1:-./cuse}
say() { printf '\n== %s\n' "$1"; }

target="$(pwd -W 2>/dev/null || pwd)/notepad-target.txt"
printf 'initial line\r\n' > notepad-target.txt

say "start the classic binary by full path"
powershell -NoProfile -Command \
  "Start-Process \"\$env:SystemRoot\System32\notepad.exe\" -ArgumentList '$target'" || {
  echo "the classic binary would not start"; exit 1; }

"$CUSE" wait --window=notepad-target --timeout=25000 --json || {
  echo "it started but never presented a window"; exit 1; }

say "drag the live window by its title bar"
"$CUSE" windows --json | tee windows-before-drag.json >/dev/null || {
  echo "could not capture windows before the drag"; exit 1; }
before_window=$(jq -er \
  '[.data[] | select(.title | test("notepad-target"; "i"))][0] | select(. != null) | [.x, .y, .width] | @tsv' \
  windows-before-drag.json) || {
  echo "could not find notepad-target before the drag"; exit 1; }
read -r before_x before_y window_width <<< "$before_window"

# The hosted Windows display has ample room for this fixed offset. Starting at
# the horizontal center and 10 pixels below the top keeps the pointer on the
# classic Notepad title bar.
from_x=$((before_x + window_width / 2))
from_y=$((before_y + 10))
to_x=$((from_x + 150))
to_y=$((from_y + 120))
"$CUSE" drag "$from_x" "$from_y" "$to_x" "$to_y" --duration=250 --steps=6 --json || {
  echo "the interpolated drag command failed against the live window"; exit 1; }

"$CUSE" windows --json | tee windows-after-drag.json >/dev/null || {
  echo "could not capture windows after the drag"; exit 1; }
after_window=$(jq -er \
  '[.data[] | select(.title | test("notepad-target"; "i"))][0] | select(. != null) | [.x, .y] | @tsv' \
  windows-after-drag.json) || {
  echo "could not find notepad-target after the drag"; exit 1; }
read -r after_x after_y <<< "$after_window"
delta_x=$((after_x - before_x))
delta_y=$((after_y - before_y))
abs_delta_x=${delta_x#-}
abs_delta_y=${delta_y#-}
if ((abs_delta_x < 50 && abs_delta_y < 50)); then
  echo "live window did not move far enough: before=($before_x,$before_y) after=($after_x,$after_y) delta=($delta_x,$delta_y)"
  exit 1
fi
echo "dragged a live Windows window by ($delta_x,$delta_y), proving the interpolated drag path moves a real target"

say "what the tree says about it"
"$CUSE" elements notepad-target --json | tee notepad-elements.json

say "type, save, and read the file back"
"$CUSE" focus notepad-target --json
"$CUSE" type "cuse typed into the classic notepad" --expect-front=notepad-target --json || {
  echo "refused to type; who had the keyboard:"; "$CUSE" frontmost --json; exit 1; }
"$CUSE" scenario scenarios/windows-element-assert.json --json | tee assert-pass.json
grep -q '"ok":true' assert-pass.json || {
  echo "the correct-value assertion did not pass against a live control"; exit 1; }
"$CUSE" scenario scenarios/windows-element-assert-negative.json --json | tee assert-fail.json
grep -q '"ok":false' assert-fail.json || {
  echo "the wrong-value assertion did not fail; the assert step is not discriminating real state"
  exit 1; }
echo "asserted a live control's observed value, and forced the assertion red once"
"$CUSE" key ctrl+s --json
sleep 3
cat notepad-target.txt
grep -q "cuse typed into the classic notepad" notepad-target.txt || {
  echo "the keystrokes never reached the document"
  "$CUSE" frontmost --json || true
  "$CUSE" windows --json || true
  exit 1; }
echo "  the workaround works, proved by what the file contains"
