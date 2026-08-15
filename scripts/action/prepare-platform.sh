#!/usr/bin/env bash
set -euo pipefail

runner_os=${1:?usage: prepare-platform.sh OS SCENARIO DISPLAY_MODE ACCESSIBILITY GITHUB_ENV}
scenario=${2:?usage: prepare-platform.sh OS SCENARIO DISPLAY_MODE ACCESSIBILITY GITHUB_ENV}
display_mode=${3:?usage: prepare-platform.sh OS SCENARIO DISPLAY_MODE ACCESSIBILITY GITHUB_ENV}
accessibility=${4:?usage: prepare-platform.sh OS SCENARIO DISPLAY_MODE ACCESSIBILITY GITHUB_ENV}
github_env=${5:?usage: prepare-platform.sh OS SCENARIO DISPLAY_MODE ACCESSIBILITY GITHUB_ENV}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "$display_mode" in
  automatic|always|never) ;;
  *) echo "invalid linux-display '$display_mode': expected automatic, always, or never" >&2; exit 2 ;;
esac
case "$accessibility" in
  true|false) ;;
  *) echo "invalid linux-accessibility '$accessibility': expected true or false" >&2; exit 2 ;;
esac

if [[ "$runner_os" != "Linux" ]]; then
  echo "::notice::cuse platform preparation: ${runner_os} uses its current interactive session; no display service was changed"
  exit 0
fi

inspection=$(node "$script_dir/inspect-scenario.mjs" "$scenario")
read_json() {
  node -e 'const value=JSON.parse(process.argv[1]); const found=value[process.argv[2]]; process.stdout.write(typeof found === "boolean" ? String(found) : JSON.stringify(found))' "$inspection" "$1"
}

scenario_needs_display=$(read_json displayRequired)
case "$display_mode" in
  automatic) prepare_display=$scenario_needs_display ;;
  always) prepare_display=true ;;
  never) prepare_display=false ;;
esac

echo "::notice::cuse platform preparation: scenario display-required=${scenario_needs_display}, linux-display=${display_mode}, prepare-display=${prepare_display}, linux-accessibility=${accessibility}"
if [[ "$scenario_needs_display" == "true" && "$display_mode" == "never" ]]; then
  echo "::warning::scenario needs display actions but linux-display is never; no Xvfb will be started"
fi
if [[ "$(read_json accessibilityUsed)" == "true" && "$accessibility" == "false" ]]; then
  echo "::warning::scenario uses the elements action but linux-accessibility is false; AT-SPI will not be installed"
fi

packages=()
if [[ "$prepare_display" == "true" && -z "${DISPLAY:-}" ]]; then
  packages+=(xvfb)
fi
if [[ "$prepare_display" == "true" && "$(read_json x11AppsRequired)" == "true" ]]; then
  packages+=(x11-apps)
fi
if [[ "$prepare_display" == "true" && "$(read_json xdotoolRequired)" == "true" ]]; then
  packages+=(xdotool)
fi
if [[ "$accessibility" == "true" ]]; then
  packages+=(at-spi2-core python3-pyatspi dbus-x11)
fi

if [[ "${CUSE_ACTION_DRY_RUN:-false}" == "true" ]]; then
  echo "plan: packages=${packages[*]:-none} start-xvfb=$([[ "$prepare_display" == "true" && -z "${DISPLAY:-}" ]] && echo true || echo false)"
  exit 0
fi

if ((${#packages[@]})); then
  echo "::notice::cuse platform preparation: installing ${packages[*]} with 120 second bounds"
  sudo timeout 120s apt-get update -qq
  sudo timeout 120s apt-get install -y -qq --no-install-recommends "${packages[@]}"
fi

if [[ "$accessibility" == "true" ]]; then
  printf 'GTK_MODULES=gail:atk-bridge\nNO_AT_BRIDGE=0\n' >> "$github_env"
  echo "::notice::cuse platform preparation: AT-SPI packages installed and GTK accessibility enabled"
fi

if [[ "$prepare_display" != "true" ]]; then
  echo "::notice::cuse platform preparation: Xvfb not requested"
  exit 0
fi
if [[ -n "${DISPLAY:-}" ]]; then
  echo "::notice::cuse platform preparation: reusing DISPLAY=${DISPLAY}"
  exit 0
fi

display_number=
for candidate in $(seq 90 110); do
  if [[ ! -S "/tmp/.X11-unix/X${candidate}" ]]; then
    display_number=$candidate
    break
  fi
done
if [[ -z "$display_number" ]]; then
  echo "no free X display found in bounded range :90 through :110" >&2
  exit 1
fi

display=":${display_number}"
log_file="${RUNNER_TEMP:-/tmp}/cuse-xvfb-${display_number}.log"
Xvfb "$display" -screen 0 1280x1024x24 -nolisten tcp >"$log_file" 2>&1 &
xvfb_pid=$!
ready=false
for _ in $(seq 1 50); do
  if [[ -S "/tmp/.X11-unix/X${display_number}" ]]; then ready=true; break; fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ "$ready" != "true" ]]; then
  kill "$xvfb_pid" 2>/dev/null || true
  echo "Xvfb failed to become ready within 5 seconds; log: $log_file" >&2
  exit 1
fi

printf 'DISPLAY=%s\nCUSE_XVFB_PID=%s\n' "$display" "$xvfb_pid" >> "$github_env"
echo "::notice::cuse platform preparation: Xvfb ready on ${display}, pid=${xvfb_pid}, log=${log_file}"
