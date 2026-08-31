#!/usr/bin/env bash
# Can cuse drive a full GTK application by semantic control names and observe
# the value it computes, on a headless Linux runner?
set -uo pipefail
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
CUSE=${CUSE:-./cuse}
CALCULATOR_BIN=${CALCULATOR_BIN:-gnome-calculator}

say() {
  printf '%s\n' "$*" | tee -a calc.log
}

for d in /usr/libexec /usr/lib/at-spi2-core /usr/lib/x86_64-linux-gnu/at-spi2-core; do
  [ -x "$d/at-spi-bus-launcher" ] && LAUNCHER="$d/at-spi-bus-launcher"
  [ -x "$d/at-spi2-registryd" ] && REGISTRYD="$d/at-spi2-registryd"
done
say "calculator=$CALCULATOR_BIN launcher=${LAUNCHER:-none} registryd=${REGISTRYD:-none}"
gsettings set org.gnome.desktop.interface toolkit-accessibility true 2>/dev/null || \
  say "gsettings unavailable; relying on GTK_MODULES"
if [ -n "${LAUNCHER:-}" ]; then "$LAUNCHER" --launch-immediately & sleep 2; fi
if [ -n "${REGISTRYD:-}" ]; then "$REGISTRYD" & sleep 2; fi

openbox >openbox.log 2>&1 &
wm_pid=$!
"$CALCULATOR_BIN" >calculator.stdout.log 2>calculator.stderr.log &
calc_pid=$!
trap 'kill "$calc_pid" "$wm_pid" 2>/dev/null || true' EXIT

window_pattern=Calculator
[ "$CALCULATOR_BIN" = mate-calc ] && window_pattern=Calculator
"$CUSE" wait --window="$window_pattern" --timeout=30000 --json | tee calc-wait.json

say "waiting for the calculator accessibility tree"
for _ in $(seq 1 30); do
  "$CUSE" elements "$CALCULATOR_BIN" --json > calc-elements-initial.json 2>/dev/null || true
  if grep -Eq '"name":"(5|Five)"' calc-elements-initial.json && \
     grep -Eq '"name":"(=|Calculate|Equals)"' calc-elements-initial.json; then
    break
  fi
  sleep 1
done
cat calc-elements-initial.json
grep -Eq '"name":"(5|Five)"' calc-elements-initial.json || {
  say "the accessibility tree never exposed the 5 button"; exit 1; }
grep -Eq '"name":"(=|Calculate|Equals)"' calc-elements-initial.json || {
  say "the accessibility tree never exposed the equals button"; exit 1; }

click_named() {
  label=$1
  shift
  for candidate in "$label" "$@"; do
    if "$CUSE" click --element="$candidate" --role=button --app="$CALCULATOR_BIN" --json \
      | tee -a calc-clicks.jsonl && \
      tail -n 1 calc-clicks.jsonl | grep -q '"ok":true'; then
      say "clicked button named $candidate"
      return 0
    fi
  done
  say "no accessible button matched: $label $*"
  return 1
}

"$CUSE" focus "$window_pattern" --json | tee calc-focus.json
click_named 5 Five || exit 1
click_named + Add Plus || exit 1
click_named 3 Three || exit 1
click_named = Calculate Equals || exit 1
sleep 2
"$CUSE" elements "$CALCULATOR_BIN" --json | tee calc-elements-result.json

# Build two scenario documents around the live result control that AT-SPI
# exposed. The selector must identify the same control without using its value.
bun -e '
  const app = process.env.CALCULATOR_BIN;
  const els = (await Bun.file("calc-elements-result.json").json()).data;
  const target = els.find((e) => String(e.value ?? "").trim() === "8");
  if (!target) throw new Error("no accessible control reports the computed value 8");
  const selected = els.find((e) => e.role === target.role && e.name === target.name);
  if (selected !== target)
    throw new Error(`the available ${target.role}/${target.name} selector does not resolve to the result control`);
  const options = { role: target.role };
  if (target.name) options.element = target.name;
  const scenario = (expected, suffix) => ({
    version: 1,
    name: `assert a live Linux calculator value${suffix}`,
    platforms: ["linux"],
    vars: {},
    defaultTimeoutMs: 20000,
    steps: [
      { type: "cuse", action: "element", args: [app], options, saveAs: "target" },
      { type: "assert", actual: "${steps.target.data.value}", operator: "eq", expected },
    ],
  });
  await Bun.write("calc-assert.json", JSON.stringify(scenario("8", ""), null, 2));
  await Bun.write("calc-assert-negative.json", JSON.stringify(scenario("9", " (forced red)"), null, 2));
  console.log(`result selector: role=${target.role} name=${JSON.stringify(target.name)} value=${JSON.stringify(target.value)}`);
' | tee calc-result-selector.log

"$CUSE" scenario calc-assert.json --json | tee calc-assert-pass.json
grep -q '"ok":true' calc-assert-pass.json || {
  say "the correct-value assertion did not pass against the live calculator display"; exit 1; }
"$CUSE" scenario calc-assert-negative.json --json | tee calc-assert-fail.json
grep -q '"ok":false' calc-assert-fail.json || {
  say "the wrong-value assertion did not fail; the assertion is not discriminating live state"; exit 1; }
say "computed 5 + 3 through named buttons, observed 8, and forced the same assertion red with 9"
