#!/bin/bash
# What happens to a tool that needs the system trust store when nobody is there
# to authenticate.
#
# The first version of this script assumed portless would start, serve TLS with
# an untrusted certificate, and let us prove the wall with `curl`. The runner
# said otherwise:
#
#     Ensuring TLS certificates...
#     Generated local CA certificate.
#     Adding CA to system trust store...
#     [killed at 90s]
#
# The wall is not behind startup, it *is* startup. macOS gates changes to
# SecTrustSettings behind SecurityAgent, and `sudo` does not avoid it - trust
# settings are orthogonal to keychain file permissions, so even root gets the
# prompt. On an unattended machine, portless does not come up at all.
#
# That is worth a standing gate, in both directions:
#
#   1. with TLS, an unattended start must NOT succeed, and must be blocked at
#      the trust step rather than failing for some unrelated reason
#   2. with --no-tls it must come up, which is what separates "this tool is
#      broken in CI" from "this one step needs a human"
set -uo pipefail

CUSE="${CUSE:-./cuse}"
PORTLESS="${PORTLESS:-portless}"
PORT="${PORT:-1355}"
HOST="${HOST:-cuserig.localhost}"
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
  cap 20 "$PORTLESS" proxy stop >/dev/null 2>&1 || true
  return 0
}
trap cleanup EXIT

echo "=== 1. unattended startup, with TLS ==="
cap 75 "$PORTLESS" proxy start -p "$PORT" > proxy-tls.log 2>&1
rc=$?
echo "exit=$rc"
cat proxy-tls.log || true

# Evidence, gathered while the machine is in that state: does the auth surface
# draw a window a driver could even see? A fact about the runner, not about
# cuse, so it is reported rather than required.
echo "--- what was on screen ---"
"$CUSE" windows --json > windows-during-trust.json 2>/dev/null || true
head -c 400 windows-during-trust.json; echo
if grep -qi "securityagent\|certificate trust\|authenticat" windows-during-trust.json; then
  echo "cuse perceived an authentication surface"
  "$CUSE" elements SecurityAgent --json > securityagent.json 2>/dev/null || true
  head -c 400 securityagent.json; echo
else
  echo "no authentication window was drawn: the prompt is headless here, and the call simply blocks"
fi

if [ "$rc" -eq 0 ] && grep -qi "proxy started" proxy-tls.log; then
  fail "portless started with TLS on an unattended machine - the trust wall documented here has moved, and the plan built on it (bake the root in with MDM at provisioning) needs revisiting"
fi
grep -qi "trust store" proxy-tls.log || {
  echo "it failed before reaching the trust step, which is a different problem:"
  cat proxy-tls.log
  fail "expected startup to reach 'Adding CA to system trust store'"
}
echo "confirmed: startup blocks at the trust store, exactly where a human would be asked"

echo "=== 2. the same proxy with the trust step skipped ==="
cap 20 "$PORTLESS" proxy stop >/dev/null 2>&1 || true
sleep 2
cap 90 "$PORTLESS" proxy start -p "$PORT" --no-tls > proxy-plain.log 2>&1
echo "exit=$?"
cat proxy-plain.log || true
sleep 3

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "http://$HOST:$PORT/" 2>/dev/null); rc=$?
echo "curl http://$HOST:$PORT/ -> rc=$rc http=$code"
[ "$rc" -eq 0 ] || {
  echo "--- proxy log ---"; cat proxy-plain.log
  fail "portless did not come up even with --no-tls: the problem is not only the trust wall"
}
echo "the proxy answers over plain HTTP: one step needs a human, the tool does not"

echo "VERDICT: PASS"
