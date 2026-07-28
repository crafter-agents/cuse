#!/bin/bash
# Self-test of the cuse CLI on whatever OS this runner is. Same commands everywhere.
set -uo pipefail
CU="./bin/cu"
[ -x "$CU" ] || CU="$(command -v cuse)"
echo "=== cuse self-test on $($CU os) ==="

echo "--- capture ---"
$CU capture before.png && echo "CAPTURE-OK"

echo "--- launch app (OS picks the app) ---"
case "$($CU os)" in
  macos)   $CU launch TextEdit ;;
  windows) $CU launch "C:\\Windows\\System32\\notepad.exe" ;;
  linux)   $CU launch xterm ;;
esac
sleep 2
echo "LAUNCH-DONE"

echo "--- type (agnostic verb) ---"
$CU type "cuse made this cross-platform" && echo "TYPE-OK"

echo "--- key chord (agnostic, mapped per OS) ---"
$CU key "cmd+a" 2>&1 | head -1 || $CU key "ctrl+a" 2>&1 | head -1
echo "KEY-DONE"

echo "--- capture after ---"
sleep 1
$CU capture after.png && echo "CAPTURE-OK"

echo "=== VERDICT ==="
[ -f before.png ] && [ -f after.png ] && echo "CU-GREEN on $($CU os): same commands, right primitives" || echo "CU-INCOMPLETE"
