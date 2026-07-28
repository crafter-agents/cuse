#!/bin/sh
# Prove the Linux semantic route against a toolkit that actually exports one.
#
# xterm publishes nothing to AT-SPI, so the earlier gate could only check that
# cuse names the missing package. zenity is GTK, which does export a tree - so
# here the tree is read, a button is chosen by name, and zenity's own exit is
# the proof it was pressed. Nothing in this asserts a pixel.
set -e
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0

zenity --entry --title=CU_TARGET --text="cuse is going to press Cancel" > zenity-out.txt 2>/dev/null &
zpid=$!
sleep 5

if ! kill -0 "$zpid" 2>/dev/null; then
  echo "zenity did not stay up; nothing to select"
  exit 1
fi

echo "--- the tree GTK exports ---"
./cuse elements zenity --json | tee gtk-elements.json

echo "--- press the button named Cancel, by name ---"
./cuse click --element=Cancel --app=zenity --json
sleep 3

if kill -0 "$zpid" 2>/dev/null; then
  echo "zenity is still running: clicking the control named Cancel did not press it"
  kill "$zpid" 2>/dev/null || true
  exit 1
fi
echo "zenity exited: the control named Cancel was pressed"
