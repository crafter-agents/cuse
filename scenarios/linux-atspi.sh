#!/bin/sh
# What does AT-SPI actually give a headless runner?
#
# Three things are asserted here, and all three are true today:
#
#   1. With the bus started by hand, a GTK app does export a tree, and cuse
#      reads it - roles and names included.
#   2. Every rectangle in that tree is 0,0, because without a window manager the
#      toolkit does not know where its own window is.
#   3. cuse therefore refuses to aim by it, instead of clicking the corner of
#      the screen with complete confidence.
#
# The day a runner reports real geometry, assertion 2 fails and this script says
# so - which is the signal to promote the Linux route from a refusal to a click.
set -e
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0

# The accessibility bus does not exist until something starts it. On a desktop
# the session does; under xvfb-run nothing has, so GTK exports its tree to
# nobody and the registry comes back empty - which looks exactly like an app
# with no controls, and is why the first attempt reported zero.
for d in /usr/libexec /usr/lib/at-spi2-core /usr/lib/x86_64-linux-gnu/at-spi2-core; do
  [ -x "$d/at-spi-bus-launcher" ] && LAUNCHER="$d/at-spi-bus-launcher"
  [ -x "$d/at-spi2-registryd" ] && REGISTRYD="$d/at-spi2-registryd"
done
echo "launcher=${LAUNCHER:-none} registryd=${REGISTRYD:-none}"
# GTK also consults this before it bothers exporting anything.
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || \
  echo "(gsettings unavailable; relying on GTK_MODULES)"
if [ -n "$LAUNCHER" ]; then "$LAUNCHER" --launch-immediately & sleep 2; fi
if [ -n "$REGISTRYD" ]; then "$REGISTRYD" & sleep 2; fi

zenity --entry --title=CU_TARGET --text="a control named Cancel lives here" > zenity-out.txt 2>/dev/null &
zpid=$!
sleep 5
if ! kill -0 "$zpid" 2>/dev/null; then
  echo "zenity did not stay up; nothing to read"
  exit 1
fi
trap 'kill "$zpid" 2>/dev/null || true' EXIT

echo "--- which applications the bus can see ---"
python3 -c 'import pyatspi; print("apps on the bus:", [a.name for a in pyatspi.Registry.getDesktop(0) if a] or "(none)")' || true

# 1. The tree is readable, and it names the control.
echo "--- the tree GTK exports ---"
./cuse elements zenity --json | tee gtk-elements.json
grep -q '"name":"Cancel"' gtk-elements.json || {
  echo "expected a control named Cancel in the tree"; exit 1; }
echo "readable: the tree names the control"

# 2 and 3. The geometry is unusable, and cuse says so rather than aiming at it.
echo "--- try to aim by that tree ---"
out=$(./cuse click --element=Cancel --app=zenity --json || true)
echo "$out"
if echo "$out" | grep -q '"ok":true'; then
  echo "the tree was aimable after all - promote this gate from a refusal to a click"
  exit 1
fi
echo "$out" | grep -q 'places them all at 0,0' || {
  echo "expected the refusal to name the unusable geometry, got: $out"; exit 1; }
echo "refused correctly: a tree that cannot place its controls is not aimed at"

# 4. And the other half of waiting: noticing that something is gone. zenity is
#    still up, so this has to be false first and true after it is closed.
echo "--- --gone, before and after ---"
./cuse wait --gone --window=CU_TARGET --timeout=3000 --json && {
  echo "the window was reported gone while it was still on screen"; exit 1; }
kill "$zpid" 2>/dev/null || true
./cuse wait --gone --window=CU_TARGET --timeout=15000 --json || {
  echo "the window closed and cuse never noticed"; exit 1; }
echo "noticed the window closing"
