#!/bin/bash
# Does agent-browser's iOS path actually drive a phone?
#
# agent-browser ships a full iOS Simulator backend - `cli/src/native/webdriver/
# ios.rs` boots simulators through `xcrun simctl`, `appium.rs` asks for
# platformName iOS with the XCUITest driver, and the CLI exposes
# `-p ios open|tap|swipe|device list`. Nothing tests it. Its own CI runs every
# end-to-end check on ubuntu; the macOS runners only compile and run unit tests.
# An untested backend is not a backend, it is a hypothesis.
#
# The oracle is deliberately outside both tools: a local HTTP server logs every
# request with its User-Agent.
#
# Counting requests was not enough, and the first version of this gate passed
# while proving nothing. The host and the simulator share a loopback, so every
# hit arrives as ::1 - a fetch from desktop Chrome, from curl, or from a phone
# are indistinguishable by address. If `-p ios` were to fall back to a desktop
# browser, the log would fill up and the cell would go green with no simulator
# involved. What is required now is a request for the sentinel path carrying an
# iPhone User-Agent, plus a booted simulator to have produced it.
set -uo pipefail

CUSE="${CUSE:-./cuse}"
AB="${AB:-agent-browser}"
PORT="${PORT:-8741}"
# Unique per run, so a stale log from an earlier attempt cannot pass this.
SENTINEL="reached-${GITHUB_RUN_ID:-local}-${RANDOM}"
fail() { echo "FAIL: $*"; exit 1; }

cap() {
  local s="$1"; shift
  "$@" </dev/null & local p=$!
  ( sleep "$s"; kill -9 "$p" 2>/dev/null ) & local w=$!
  wait "$p" 2>/dev/null; local rc=$?
  kill "$w" 2>/dev/null
  return "$rc"
}

cleanup() {
  cap 30 "$AB" close --all >/dev/null 2>&1 || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

echo "--- what simulators does this machine have ---"
xcrun simctl list devices available | grep -iE "iphone" | head -5
xcrun simctl list devices available | grep -qi iphone || fail "no iPhone simulator on this runner"

echo "--- does agent-browser see them (this is ios.rs list_simulators) ---"
# Reported, not gated. On the first run this hung and was killed at 90s while
# simctl listed five iPhones instantly, which is a finding in its own right -
# but making the whole cell depend on it means never reaching the part that
# matters, which is whether the backend can drive a phone at all.
cap 90 "$AB" -p ios device list > devices.txt 2>&1
rc=$?
echo "exit=$rc"
cat devices.txt || true
if [ "$rc" -ne 0 ]; then
  echo "NOTE: \`-p ios device list\` did not return within 90s while simctl answered instantly"
  # Which part is slow? `device_list` is marked skip_launch_action in
  # actions.rs, so it should not boot a simulator, and Appium's own startup
  # timeout is 30s - neither explains 90. The remaining suspect is the daemon
  # spawn, and a second call tells the two apart: if a daemon is now up and the
  # repeat is fast, the cost is in starting it, not in listing devices.
  echo "--- probe: is a daemon up now, and is the second call faster ---"
  t0=$(date +%s)
  cap 60 "$AB" -p ios device list > devices-2nd.txt 2>&1
  rc2=$?
  echo "second call: exit=$rc2 after $(( $(date +%s) - t0 ))s"
  head -5 devices-2nd.txt 2>/dev/null || true
  pgrep -fl "agent-browser" | head -5 || echo "(no agent-browser process is left running)"
fi

echo "--- serve a page whose log is the oracle ---"
rm -f requests.tsv
REQLOG=requests.tsv PORT="$PORT" SENTINEL="$SENTINEL" bun rig/oracle-server.ts > server.log 2>&1 &
SERVER_PID=$!
# Wait for readiness rather than guessing. An earlier version slept two seconds
# and failed on a runner that had just installed Appium and spent 90s on a hung
# command; the server had not finished starting.
ready=""
for i in $(seq 1 30); do
  curl -fsS -m 3 "http://localhost:$PORT/$SENTINEL.html" >/dev/null 2>&1 && { ready=y; break; }
  sleep 1
done
[ -n "$ready" ] || {
  echo "--- server log ---"; cat server.log 2>/dev/null
  echo "--- who holds the port ---"; lsof -i ":$PORT" 2>/dev/null | head
  fail "the local server never came up on $PORT"
}
echo "server is up; the warm-up request is in the log under curl's own User-Agent"

echo "--- before ---"
xcrun simctl io booted screenshot ios-before.png 2>/dev/null || echo "(no booted device yet, expected)"

echo "--- drive the simulator, cold ---"
# Booting a simulator and building WebDriverAgent on a cold runner is slow;
# bounded generously, because a timeout here is a real answer.
cap 420 "$AB" -p ios open "http://localhost:$PORT/$SENTINEL.html" > open.log 2>&1
echo "cold open exit=$? (not the assertion, but read it)"
tail -25 open.log || true
sleep 5

echo "--- drive it again, warm ---"
# Fair chance for the tool: the first attempt may have spent its budget booting
# the device. If the second works, the report is "fails cold, works warm", which
# is a different bug from "does not work".
cap 300 "$AB" -p ios open "http://localhost:$PORT/$SENTINEL.html" > open-warm.log 2>&1
echo "warm open exit=$? (not the assertion either)"
tail -25 open-warm.log || true
sleep 5

echo "--- is a simulator even booted ---"
xcrun simctl list devices booted | tee booted.txt
grep -qi "iphone" booted.txt || {
  echo "--- what open said ---"; cat open.log
  fail "no simulator is booted: nothing could have run a mobile browser"
}

echo "--- evidence: what the phone screen looks like ---"
xcrun simctl io booted screenshot ios-after.png 2>/dev/null || echo "(no screenshot)"
if [ -f ios-before.png ] && [ -f ios-after.png ]; then
  # Reported, not gated: a simulator's clock alone changes pixels.
  "$CUSE" diff ios-before.png ios-after.png --same-under=0 --json || true
fi

echo "--- the oracle: did a phone fetch that path ---"
cat requests.tsv 2>/dev/null || true
if awk -F'\t' -v p="/$SENTINEL.html" '$1 == p && $2 ~ /iPhone/ { n++ } END { exit(n ? 0 : 1) }' requests.tsv; then
  echo "a mobile browser on the simulator fetched the page:"
  awk -F'\t' -v p="/$SENTINEL.html" '$1 == p && $2 ~ /iPhone/ { print "  " substr($2, 1, 100) }' requests.tsv | head -3
  echo "VERDICT: PASS (the iOS path drives a phone)"
  exit 0
fi

# It did not. That is a defect in the tool under test, and this repo already has
# a pattern for those: reproduce it and assert its signature, so the job goes red
# the day it changes. A permanently red job is indistinguishable from a broken
# one, and a silent one proves nothing.
echo "no request carried an iPhone User-Agent. Requests seen:"
awk -F'\t' '{ printf "  %-42s %s\n", $1, substr($2, 1, 80) }' requests.tsv 2>/dev/null

echo "--- what is being reproduced ---"
cat open.log open-warm.log 2>/dev/null | tail -30

# The simulator booting is the part that works, and it has to keep working or
# this reproduction is about something else.
grep -qi "iphone" booted.txt || fail "the simulator never booted either: this is a different failure from the one documented"

# The signature: the CLI cannot read from its own daemon. os error 35 is EAGAIN,
# so the client's retry budget expires while the daemon is still busy with the
# iOS launch - a budget tuned for CDP latency, not for booting a phone.
if grep -qiE "os error 35|daemon may be busy|unresponsive|Failed to read" open.log open-warm.log; then
  echo "reproduced: the simulator boots, and the CLI then gives up reading from its own daemon"
  echo "  (os error 35 is EAGAIN: five retries expire while the daemon is still launching iOS)"
  echo "VERDICT: PASS (reproduced: the iOS path boots a device and never drives it)"
else
  echo "the failure is real but does not match the documented signature, so it needs a fresh diagnosis"
  fail "uncharacterised iOS failure"
fi
exit 0

