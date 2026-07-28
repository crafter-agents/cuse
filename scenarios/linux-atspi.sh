#!/bin/sh
# What does AT-SPI actually give a headless runner, and does cuse tell the truth
# about it either way?
#
# Both outcomes are asserted, because the bring-up itself is not reliable here -
# one run saw zenity on the bus, the next saw nothing:
#
#   bus came up   -> the tree is readable, every rectangle is 0,0 because no
#                    window manager tells the toolkit where its window is, and
#                    cuse refuses to aim by it rather than clicking the corner.
#   bus did not   -> cuse reports no controls and refuses to aim, instead of
#                    returning a coordinate it has no basis for.
#
# What is asserted is cuse's behaviour. Which of the two happened is reported,
# not required, since that is a fact about the machine.
set -e
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0

for d in /usr/libexec /usr/lib/at-spi2-core /usr/lib/x86_64-linux-gnu/at-spi2-core; do
  [ -x "$d/at-spi-bus-launcher" ] && LAUNCHER="$d/at-spi-bus-launcher"
  [ -x "$d/at-spi2-registryd" ] && REGISTRYD="$d/at-spi2-registryd"
done
echo "launcher=${LAUNCHER:-none} registryd=${REGISTRYD:-none}"
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || \
  echo "(gsettings unavailable; relying on GTK_MODULES)"
if [ -n "$LAUNCHER" ]; then "$LAUNCHER" --launch-immediately & sleep 2; fi
if [ -n "$REGISTRYD" ]; then "$REGISTRYD" & sleep 2; fi

zenity --entry --title=CU_TARGET --text="a control named Cancel lives here" > zenity-out.txt 2>/dev/null &
zpid=$!
sleep 4
if ! kill -0 "$zpid" 2>/dev/null; then
  echo "zenity did not stay up; nothing to read"
  exit 1
fi
trap 'kill "$zpid" 2>/dev/null || true' EXIT

# Registering on the bus is a race between the registry daemon and the app, so
# wait for it rather than taking the first answer.
echo "--- waiting for the app to register ---"
apps=""
for i in $(seq 1 20); do
  apps=$(python3 -c 'import pyatspi; print(",".join(a.name for a in pyatspi.Registry.getDesktop(0) if a))' 2>/dev/null || true)
  case "$apps" in *zenity*) break ;; esac
  sleep 1
done
echo "apps on the bus: ${apps:-(none)}"

./cuse elements zenity --json | tee gtk-elements.json

if grep -q '"name":"Cancel"' gtk-elements.json; then
  echo "the bus came up: the tree is readable and names the control"
  out=$(./cuse click --element=Cancel --app=zenity --json || true)
  echo "$out"
  if echo "$out" | grep -q '"ok":true'; then
    echo "the tree was aimable after all - promote this gate from a refusal to a click"
    exit 1
  fi
  echo "$out" | grep -q 'places them all at 0,0' || {
    echo "expected the refusal to name the unusable geometry, got: $out"; exit 1; }
  echo "refused correctly: a tree that cannot place its controls is not aimed at"
else
  echo "the bus did not come up on this runner - asserting the other half"
  grep -q '"data":\[\]' gtk-elements.json || {
    echo "expected an empty tree when nothing registered"; exit 1; }
  out=$(./cuse click --element=Cancel --app=zenity --json || true)
  echo "$out"
  echo "$out" | grep -q '"ok":false' || {
    echo "expected a refusal with nothing to aim at, got: $out"; exit 1; }
  echo "refused correctly: nothing to aim at is not a coordinate"
fi

# The other half of waiting: noticing that something is gone.
echo "--- --gone, before and after ---"
./cuse wait --gone --window=CU_TARGET --timeout=3000 --json && {
  echo "the window was reported gone while it was still on screen"; exit 1; }
kill "$zpid" 2>/dev/null || true
./cuse wait --gone --window=CU_TARGET --timeout=15000 --json || {
  echo "the window closed and cuse never noticed"; exit 1; }
echo "noticed the window closing"
