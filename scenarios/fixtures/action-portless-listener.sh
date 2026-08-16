#!/usr/bin/env bash
set -euo pipefail

state_dir=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
state_prefix="$state_dir/cuse-action-portless-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
supervisor_file="${state_prefix}.supervisor"
listener_file="${state_prefix}.listener"
port_file="${state_prefix}.port"

stop_fixture() {
  if [[ -f "$listener_file" ]]; then
    listener_pid=$(<"$listener_file")
    kill "$listener_pid" 2>/dev/null || true
  fi

  if [[ -f "$supervisor_file" ]]; then
    supervisor_pid=$(<"$supervisor_file")
    for _ in {1..50}; do
      kill -0 "$supervisor_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$supervisor_pid" 2>/dev/null; then
      kill "$supervisor_pid" 2>/dev/null || true
      echo "listener supervisor did not exit after cleanup" >&2
      return 1
    fi
  fi

  rm -f "$supervisor_file" "$listener_file" "$port_file"
}

case "${1-}" in
  supervise)
    requested_port=${2:?listener port is required}
    python3 - "$port_file" "$requested_port" <<'PY' &
import signal
import socket
import sys

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", int(sys.argv[2])))
listener.listen()
with open(sys.argv[1], "w", encoding="utf-8") as output:
    output.write(str(listener.getsockname()[1]))

def stop(_signum, _frame):
    listener.close()
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while True:
    connection, _address = listener.accept()
    connection.close()
PY
    listener_pid=$!
    printf '%s\n' "$listener_pid" > "$listener_file"
    wait "$listener_pid"
    ;;
  start)
    requested_port=${2:?listener port is required}
    stop_fixture
    "$0" supervise "$requested_port" >/dev/null 2>&1 &
    supervisor_pid=$!
    printf '%s\n' "$supervisor_pid" > "$supervisor_file"
    for _ in {1..50}; do
      [[ -s "$port_file" ]] && break
      kill -0 "$supervisor_pid" 2>/dev/null || {
        echo "listener supervisor exited before publishing a port" >&2
        exit 1
      }
      sleep 0.1
    done
    [[ -s "$port_file" ]] || {
      stop_fixture
      echo "listener did not publish a port within 5 seconds" >&2
      exit 1
    }
    printf '%s' "$(<"$port_file")"
    ;;
  stop)
    stop_fixture
    ;;
  *)
    echo "usage: action-portless-listener.sh start|stop" >&2
    exit 2
    ;;
esac
