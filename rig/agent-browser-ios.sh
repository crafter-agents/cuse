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
# request with its User-Agent. That choice is what caught the actual defect:
# `-p ios open` exits 0, boots a simulator, and loads the page in desktop
# headless Chrome. Right exit code, wrong device, and no way to tell from the
# outside except by asking who fetched it.
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

# The daemon writes its stderr to <socket dir>/<session>.log, but only with this
# set. Three attempts failed with the CLI abandoning its own daemon read, and
# without the daemon's own account of that the report stops at the symptom.
export AGENT_BROWSER_DEBUG=1
export AGENT_BROWSER_SOCKET_DIR="$PWD/ab-sockets"
mkdir -p "$AGENT_BROWSER_SOCKET_DIR"

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

echo "--- was Appium ever reachable, and how many are there ---"
# Without this the report could only say the CLI gave up on its daemon, which is
# a symptom. Two `npm exec appium --port 4723` processes showed up in an earlier
# run, and an Appium that could not bind explains a daemon that never answers -
# is_appium_running(port) followed by launch_appium(port) is a race.
echo "processes on 4723:"
pgrep -fl "appium" | head -5 || echo "  (none)"
lsof -nP -iTCP:4723 -sTCP:LISTEN 2>/dev/null | head -5 || echo "  (nothing listening on 4723)"
echo "does it answer:"
curl -s -m 10 -o appium-status.json -w "  /status -> %{http_code}\n" \
  "http://127.0.0.1:4723/status" || echo "  no answer"
head -c 300 appium-status.json 2>/dev/null; echo
# The XCUITest driver builds WebDriverAgent on first use, which is where a cold
# runner most plausibly loses. Its log is under the derived data Appium uses.
echo "WebDriverAgent build traces:"
ls -t ~/Library/Developer/Xcode/DerivedData 2>/dev/null | head -3 || echo "  (none)"
find /tmp /var/folders -maxdepth 4 -name "*WebDriverAgent*" -newermt "-30 minutes" 2>/dev/null | head -3 || true

# The probe above changed the diagnosis. Appium answers /status with ready:true,
# the simulator boots, and xcodebuild is mid-flight compiling WebDriverAgent -
# the XCUITest driver builds it from source on first use. So the failure is not a
# broken backend, it is a cold start whose critical path includes an Xcode build,
# against a client that gives up after five reads. Waiting for that build and
# trying again is what tells the two apart.
echo "--- wait for WebDriverAgent to finish building, then try once more ---"
for i in $(seq 1 60); do
  pgrep -f "xcodebuild.*WebDriverAgent" >/dev/null 2>&1 || break
  [ $((i % 6)) -eq 0 ] && echo "  still building WebDriverAgent (${i}0s)"
  sleep 10
done
if pgrep -f "xcodebuild.*WebDriverAgent" >/dev/null 2>&1; then
  echo "  WebDriverAgent was still building after ten minutes"
else
  echo "  no xcodebuild running now"
fi
cap 300 "$AB" -p ios open "http://localhost:$PORT/$SENTINEL.html" > open-built.log 2>&1
pb=$?; echo "exit=$pb" > post-build-status.txt
echo "post-build open exit=$pb (this is the one that matters)"
tail -20 open-built.log || true
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

# It did not. Which of two very different things happened?
echo "no request carried an iPhone User-Agent. Requests seen:"
awk -F'\t' '{ printf "  %-42s %s\n", $1, substr($2, 1, 90) }' requests.tsv 2>/dev/null

# The daemon records which path it took, in its own state files. launch_ios sets
# engine="safari" and provider="ios"; the default CDP path sets engine="chrome".
# So `provider=ios` beside `engine=chrome` is the fallback, stated by the tool
# about itself - the most direct evidence there is, and it was sitting on disk
# for eight rounds while I inferred from User-Agents.
echo "--- which path the daemon says it took ---"
for f in "$AGENT_BROWSER_SOCKET_DIR"/*.engine "$AGENT_BROWSER_SOCKET_DIR"/*.provider; do
  [ -f "$f" ] || continue
  echo "  $(basename "$f") = $(cat "$f")"
done
cp "$AGENT_BROWSER_SOCKET_DIR"/*.engine "$AGENT_BROWSER_SOCKET_DIR"/*.provider . 2>/dev/null || true

echo "--- what the daemon itself said ---"
for f in "$AGENT_BROWSER_SOCKET_DIR"/*.log; do
  [ -f "$f" ] || continue
  echo "=== $f ==="; tail -40 "$f"
done
cp "$AGENT_BROWSER_SOCKET_DIR"/*.log . 2>/dev/null || true

echo "--- what is being reproduced ---"
cat open.log open-warm.log open-built.log 2>/dev/null | tail -30

# The simulator booting has to keep working, or this is about something else.
grep -qi "iphone" booted.txt || fail "no simulator booted at all: a different failure from the one documented"

# Case A, the serious one: the command reports success and a DESKTOP browser
# fetched the page. A simulator was booted and never used. An agent driving this
# would believe it had tested a phone. Asserting the desktop User-Agent is what
# stops this branch passing on an empty log.
engine="$(cat "$AGENT_BROWSER_SOCKET_DIR"/default.engine 2>/dev/null || echo unknown)"
provider="$(cat "$AGENT_BROWSER_SOCKET_DIR"/default.provider 2>/dev/null || echo unknown)"
echo "the daemon recorded engine=$engine provider=$provider"
if grep -qiE "Macintosh|HeadlessChrome|Windows NT|X11" requests.tsv && grep -q "exit=0" post-build-status.txt 2>/dev/null; then
  echo "reproduced: -p ios reported success and a desktop browser loaded the page."
  echo "  launch_ios sets engine=safari; this run recorded engine=$engine."
  echo "  A simulator was booted and never used; no request came from a phone."
  echo "  This is a silent fallback - right exit code, wrong device."
  echo "VERDICT: PASS (reproduced: -p ios falls back to a desktop browser and reports success)"
  exit 0
fi

# Case B: nothing loaded the page at all.
if grep -qiE "os error 35|daemon may be busy|unresponsive|Failed to read" open.log open-warm.log open-built.log; then
  echo "reproduced: no browser loaded the page, and the CLI gave up reading from its own daemon."
  echo "VERDICT: PASS (reproduced: -p ios never completes here)"
  exit 0
fi

echo "the failure is real but matches neither documented shape, so it needs a fresh diagnosis"
fail "uncharacterised iOS outcome"

