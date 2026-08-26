#!/usr/bin/env bash
set -euo pipefail

runner_os=${1-}
runner_arch=${2-}
executable_override=${3-}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

json_string() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\b'/\\b}
  value=${value//$'\f'/\\f}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  printf '"%s"' "$value"
}

os_json=$(json_string "$runner_os")
arch_json=$(json_string "$runner_arch")

if [[ -n "$executable_override" ]]; then
  override_json=$(json_string "$executable_override")
  printf '{"schemaVersion":1,"supported":true,"runner":{"os":%s,"arch":%s},"strategy":"override","requestedArch":%s,"resolvedArch":null,"asset":null,"executablePath":%s,"remediation":null}\n' \
    "$os_json" "$arch_json" "$arch_json" "$override_json"
  exit 0
fi

asset=$(awk -F '\t' -v os="$runner_os" -v arch="$runner_arch" \
  '$1 == os && $2 == arch { print $3 }' "$script_dir/assets.tsv")

if [[ -n "$asset" ]]; then
  asset_json=$(json_string "$asset")
  printf '{"schemaVersion":1,"supported":true,"runner":{"os":%s,"arch":%s},"strategy":"native","requestedArch":%s,"resolvedArch":%s,"asset":%s,"executablePath":null,"remediation":null}\n' \
    "$os_json" "$arch_json" "$arch_json" "$arch_json" "$asset_json"
  exit 0
fi

printf '{"schemaVersion":1,"supported":false,"runner":{"os":%s,"arch":%s},"strategy":"unsupported","requestedArch":%s,"resolvedArch":null,"asset":null,"executablePath":null,"remediation":{"kind":"executable-path","message":"Provide a compatible cuse executable with the executable-path input."}}\n' \
  "$os_json" "$arch_json" "$arch_json"
