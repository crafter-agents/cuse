#!/bin/sh
# Can cuse name a GTK control and press it, on a headless Linux runner?
#
# It could not, for one reason: every rectangle AT-SPI reported was 0,0. That
# looked like a missing window manager and was not. Starting openbox moves the
# dialog to 485,396 by X's own account and AT-SPI still answers 0,0 - the GTK
# bridge does not translate DESKTOP_COORDS here, while WINDOW_COORDS is exact.
# So cuse composes the answer: X says where the window is, the tree says where
# the control is inside it. This asserts the result of that, end to end.
#
# A window manager runs anyway, and it is what gives this gate teeth. Without
# one every window sits at 0,0, so code that dropped the window origin entirely
# would still click the right pixel and the job would stay green while measuring
# nothing. Openbox places the dialog away from the origin, which is what makes a
# wrong composition land somewhere visibly wrong.
#
# The proof is not a pixel delta: zenity writes what it received to a file when
# OK is pressed. Nothing but a real click on a real button produces that.
set -e
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
CUSE=${CUSE:-./cuse}
SENTINEL=CUSE_PRESSED_THE_REAL_BUTTON

for d in /usr/libexec /usr/lib/at-spi2-core /usr/lib/x86_64-linux-gnu/at-spi2-core; do
  [ -x "$d/at-spi-bus-launcher" ] && LAUNCHER="$d/at-spi-bus-launcher"
  [ -x "$d/at-spi2-registryd" ] && REGISTRYD="$d/at-spi2-registryd"
done
echo "launcher=${LAUNCHER:-none} registryd=${REGISTRYD:-none}"
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || \
  echo "(gsettings unavailable; relying on GTK_MODULES)"
if [ -n "$LAUNCHER" ]; then "$LAUNCHER" --launch-immediately & sleep 2; fi
if [ -n "$REGISTRYD" ]; then "$REGISTRYD" & sleep 2; fi

# A window manager, so that the window is not at the origin and this gate can
# tell a composed coordinate from a forgotten one.
openbox >openbox.log 2>&1 &
sleep 2

rm -f zenity-out.txt
zenity --entry --title=CU_TARGET --text="type here" > zenity-out.txt 2>/dev/null &
zpid=$!
trap 'kill "$zpid" 2>/dev/null || true' EXIT
"$CUSE" wait --window=CU_TARGET --timeout=25000 --json

# Registering on the bus is a race between the registry daemon and the app, so
# wait for the tree rather than taking the first answer.
echo "--- waiting for the app to register ---"
for i in $(seq 1 20); do
  "$CUSE" elements zenity --json > gtk-elements.json 2>/dev/null || true
  grep -q '"name":"Cancel"' gtk-elements.json && break
  sleep 1
done
cat gtk-elements.json
grep -q '"name":"Cancel"' gtk-elements.json || {
  echo "the tree never named the control; nothing to aim at"; exit 1; }

# The window is not at the origin, and the tree agrees with X about where it is.
# Both halves matter: the first is what makes the rest of this job meaningful,
# the second is the composition itself.
"$CUSE" windows --json > windows.json
bun -e '
  const wins = (await Bun.file("windows.json").json()).data;
  const els = (await Bun.file("gtk-elements.json").json()).data;
  const w = wins.find((v) => v.title.includes("CU_TARGET"));
  if (!w) throw new Error("X does not report the target window");
  if (w.x === 0 && w.y === 0)
    throw new Error("the window is at the origin: no window manager placed it, so this check proves nothing");
  const dialog = els.find((e) => e.role === "dialog");
  if (!dialog) throw new Error("no dialog in the accessibility tree");
  if (Math.abs(dialog.x - w.x) > 2 || Math.abs(dialog.y - w.y) > 2)
    throw new Error(`the tree places the dialog at ${dialog.x},${dialog.y} and X at ${w.x},${w.y}`);
  // Not "are they at 0,0" but "are they anywhere at all": a backend that gave
  // every control the window origin would clear that older check and still be
  // aiming seventeen controls at one point.
  const spots = new Set(els.map((e) => `${e.x},${e.y}`));
  if (spots.size < 3)
    throw new Error(`${els.length} controls share ${spots.size} position(s): this is not a layout`);
  console.log(`window at ${w.x},${w.y}; ${els.length} controls composed against it`);
'

# The semantic loop, with no coordinate anywhere in it: name the field, type,
# name the button, press. What zenity writes is the only thing being trusted.
"$CUSE" focus CU_TARGET --json
"$CUSE" click --element="type here" --role=text --app=zenity --json
"$CUSE" type "$SENTINEL" --json
"$CUSE" scenario scenarios/linux-element-assert.json --json | tee assert-pass.json
grep -q '"ok":true' assert-pass.json || {
  echo "the correct-value assertion did not pass against a live control"; exit 1; }
"$CUSE" scenario scenarios/linux-element-assert-negative.json --json | tee assert-fail.json
grep -q '"ok":false' assert-fail.json || {
  echo "the wrong-value assertion did not fail; the assert step is not discriminating real state"
  exit 1; }
echo "asserted a live control's observed value, and forced the assertion red once"
"$CUSE" click --element=OK --role=button --app=zenity --json
sleep 2

echo "--- what zenity received ---"
cat zenity-out.txt || true
grep -q "$SENTINEL" zenity-out.txt || {
  echo "the control was named and resolved, but pressing it did nothing"
  echo "where cuse thought things were:"; cat gtk-elements.json
  exit 1; }
echo "pressed a GTK button by name, and the app says so itself"

# The other half of waiting: noticing that something is gone. Pressing OK
# already closed it, so this is the after state.
"$CUSE" wait --gone --window=CU_TARGET --timeout=15000 --json || {
  echo "the window closed and cuse never noticed"; exit 1; }
echo "noticed the window closing"
