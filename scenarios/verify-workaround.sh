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

say "what the tree says about it"
"$CUSE" elements notepad-target --json | tee notepad-elements.json

say "type, save, and read the file back"
"$CUSE" focus notepad-target --json
"$CUSE" type "cuse typed into the classic notepad" --expect-front=notepad-target --json || {
  echo "refused to type; who had the keyboard:"; "$CUSE" frontmost --json; exit 1; }
"$CUSE" key ctrl+s --json
sleep 3
cat notepad-target.txt
grep -q "cuse typed into the classic notepad" notepad-target.txt || {
  echo "the keystrokes never reached the document"
  "$CUSE" frontmost --json || true
  "$CUSE" windows --json || true
  exit 1; }
echo "  the workaround works, proved by what the file contains"
