#!/bin/bash
# Deliberately OS-conditional scenario. repro-farm has only ever dispatched
# cuse-selftest.sh, and every run has landed all-green on every runner, so
# its captured domain-state has never been checked against a real
# cross-runner divergence. This script manufactures one on purpose: it
# exits 0 on Linux and exits 1 on macOS, so a single dispatch across both
# runners produces a genuine pass/fail split to test the capture against.
set -uo pipefail

echo "RUNNER_OS=${RUNNER_OS:-<unset>}"
uname -a

case "${RUNNER_OS:-}" in
  Linux)
    echo "VERDICT: OS-MARKER-PASS (deliberately passes on Linux)"
    exit 0
    ;;
  macOS)
    echo "VERDICT: OS-MARKER-FAIL (deliberately fails on macOS)"
    exit 1
    ;;
  *)
    echo "VERDICT: OS-MARKER-UNKNOWN (unrecognized RUNNER_OS=${RUNNER_OS:-<unset>})"
    exit 1
    ;;
esac
