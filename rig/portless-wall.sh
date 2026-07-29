#!/bin/bash
# The other kind of surface: one that cannot be automated at all, and how a
# verification rig should behave when it meets one.
#
# portless serves real HTTPS on <name>.localhost, which means putting a local CA
# into the system trust store. macOS gates that behind SecurityAgent - Touch ID
# or a password - and the finding this repo recorded is stronger than it sounds:
# `sudo` does not avoid it. Trust settings live under SecTrustSettings, which is
# orthogonal to file permissions on the keychain, so even root gets the prompt.
# The only headless path is a configuration profile pushed by MDM at provisioning
# time.
#
# So this gate does not try to automate the wall. It asserts the wall is where
# we say it is, and fails loudly if it moves:
#
#   1. TLS is presented, so the proxy really is doing HTTPS      (curl -k)
#   2. the certificate is refused without trust                  (curl, exit 60)
#   3. an unattended `portless trust` does NOT silently succeed   <- the claim
#
# Point 3 is the one worth gating. If a runner ever trusts that CA with nobody
# there to authenticate, the documented finding is wrong and every plan built on
# it - including "bake trust into the image with MDM" - needs revisiting.
set -uo pipefail

CUSE="${CUSE:-./cuse}"
PORTLESS="${PORTLESS:-portless}"
PORT="${PORT:-1355}"
HOSTNAME_="${HOSTNAME_:-cuserig.localhost}"
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

echo "--- start the proxy on an unprivileged port ---"
# -p keeps this off 443, which would need sudo and is a different wall than the
# one under test.
cap 90 "$PORTLESS" proxy start -p "$PORT" > proxy-start.log 2>&1
echo "exit=$? (a timeout here is itself the finding: trust blocked startup)"
cat proxy-start.log || true
sleep 3

echo "--- 1. is TLS being presented at all ---"
code=$(curl -k -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$HOSTNAME_:$PORT/" 2>/dev/null)
rc=$?
echo "curl -k: rc=$rc http=$code"
[ "$rc" -eq 0 ] || fail "the proxy is not serving TLS on $PORT (curl -k failed with $rc)"
echo "TLS is up: the proxy answers when certificate validation is skipped"

echo "--- 2. is the certificate refused without trust ---"
out=$(curl -s -o /dev/null --max-time 15 "https://$HOSTNAME_:$PORT/" 2>&1); rc=$?
echo "curl (validating): rc=$rc"
# 60 is CURLE_PEER_FAILED_VERIFICATION. 35 is a TLS handshake failure, which is
# the same wall reported one layer lower.
case "$rc" in
  60|35) echo "the CA is untrusted, as expected on a machine nobody authenticated on" ;;
  0) fail "the certificate validated with no human present: the trust wall documented here is not real, and the MDM plan needs revisiting" ;;
  *) fail "unexpected curl failure $rc - neither trusted nor refused for the documented reason" ;;
esac

echo "--- 3. can an unattended trust succeed ---"
# Bounded hard: with no one to authenticate, this either prompts and waits or
# fails. What must not happen is success.
cap 45 "$PORTLESS" trust > trust.log 2>&1
echo "exit=$?"
cat trust.log || true

echo "--- what cuse could see while that ran (evidence, not a gate) ---"
# Whether SecurityAgent draws a window on a CI runner is a fact about the
# runner, not about cuse, so this is reported rather than required - the same
# treatment the pixel delta gets in the input job.
"$CUSE" windows --json > windows-during-trust.json 2>/dev/null || true
head -c 400 windows-during-trust.json; echo
if grep -qi "securityagent\|certificate trust\|authenticat" windows-during-trust.json; then
  echo "cuse perceived the authentication surface"
  "$CUSE" elements SecurityAgent --json > securityagent.json 2>/dev/null || true
  head -c 400 securityagent.json; echo
else
  echo "no authentication window was on screen (headless auth, or it never drew one)"
fi

echo "--- the claim, re-checked after the attempt ---"
curl -s -o /dev/null --max-time 15 "https://$HOSTNAME_:$PORT/" 2>&1; rc=$?
[ "$rc" -eq 0 ] && fail "trust completed unattended - the wall moved, and that is a finding, not a pass"
echo "still untrusted after an unattended attempt: the wall is where it was documented"

echo "VERDICT: PASS"
