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
# The oracle is deliberately outside both tools: a local HTTP server logs the
# requests it receives. A uniquely named path can only appear in that log if a
# browser on the simulator really navigated there. agent-browser's own report of
# success is not consulted, and neither are pixels.
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
cap 90 "$AB" -p ios device list > devices.txt 2>&1
echo "exit=$?"
cat devices.txt
grep -qi "iphone" devices.txt || fail "agent-browser could not list the simulators that simctl reports"
echo "agent-browser lists the simulators"

echo "--- serve a page whose path is the oracle ---"
mkdir -p rig/served
echo "<!doctype html><title>cuse rig ios</title><h1>$SENTINEL</h1>" > "rig/served/$SENTINEL.html"
# http.server logs every request line to stderr; that log is the ground truth.
python3 -m http.server "$PORT" --directory rig/served > server.log 2>&1 &
SERVER_PID=$!
sleep 2
curl -fsS "http://localhost:$PORT/$SENTINEL.html" >/dev/null || fail "the local server is not serving"

echo "--- before ---"
xcrun simctl io booted screenshot ios-before.png 2>/dev/null || echo "(no booted device yet, expected)"

echo "--- drive the simulator ---"
# Booting a simulator and building WebDriverAgent on a cold runner is slow;
# bounded generously, because a timeout here is a real answer.
cap 420 "$AB" -p ios open "http://localhost:$PORT/$SENTINEL.html" > open.log 2>&1
echo "exit=$? (not the assertion)"
tail -20 open.log || true
sleep 5

echo "--- the oracle: did a request for that path reach the server ---"
grep -F "$SENTINEL" server.log > hits.txt 2>/dev/null
cat hits.txt || true
# The curl above also logged a hit, so the browser's request has to be a second
# one. Otherwise a server that only ever saw our own warm-up would pass.
hits=$(wc -l < hits.txt | tr -d ' ')
echo "requests for the sentinel: $hits (one of them is this script's own warm-up)"
[ "${hits:-0}" -ge 2 ] || {
  echo "--- server log ---"; cat server.log
  fail "no browser on the simulator requested the page: the iOS path did not drive anything"
}
echo "a browser on the simulator fetched the page"

echo "--- evidence: what the phone screen looks like ---"
xcrun simctl io booted screenshot ios-after.png 2>/dev/null || echo "(no screenshot)"
if [ -f ios-before.png ] && [ -f ios-after.png ]; then
  # Reported, not gated: a simulator's clock alone changes pixels.
  "$CUSE" diff ios-before.png ios-after.png --same-under=0 --json || true
fi

echo "VERDICT: PASS"
