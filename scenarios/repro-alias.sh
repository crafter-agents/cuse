#!/usr/bin/env bash
# Reproduce a real defect in shipped software, with cuse as the instrument.
#
# On Windows Server, `notepad` on the PATH is an App Execution Alias: a zero-byte
# file with reparse tag 0x8000001B naming a Store package that Server SKUs do not
# provision. Starting it succeeds - a process is created and every API agrees -
# and no editor window ever appears. Anything driving the desktop then works
# against nothing while its exit codes stay at zero.
#
# This job reproduces only that. Verifying the workaround happens on a separate
# runner, because the chooser this leaves behind cannot be closed and would
# contaminate anything that followed it.
set -uo pipefail
CUSE=${1:-./cuse}
say() { printf '\n== %s\n' "$1"; }

say "launching through the alias"
launch=$("$CUSE" launch notepad --timeout=20000 --json)
echo "  $launch"
echo "$launch" | grep -q '"ok":true' || {
  echo "expected the alias launch to report success - that is the defect"; exit 1; }

say "no editor window ever appears"
# Named exactly: matching on 'Notepad' alone also matches the chooser's own
# title, "Select an app to open 'notepad'".
waited=$("$CUSE" wait --window="Untitled - Notepad" --timeout=10000 --json || true)
echo "  $waited"
echo "$waited" | grep -q '"ok":false' || {
  echo "an editor window appeared: this runner provisions the package after all,"
  echo "so the defect no longer reproduces here and this gate should be revisited"; exit 1; }
echo "  reproduced: the launch reported success and no editor window existed"

say "what the user gets instead"
front=$("$CUSE" frontmost --json)
echo "  $front"
echo "$front" | grep -qi "Select an app" && {
  echo "  an app chooser holds the keyboard - the visible symptom, and the reason"
  echo "  anything typed next would have gone into it"; }
# Deliberately not dismissed: it cannot be, and this job ends here.
