#!/usr/bin/env bash
set -euo pipefail

version=${1:?usage: install.sh VERSION OS ARCH INSTALL_DIR}
runner_os=${2:?usage: install.sh VERSION OS ARCH INSTALL_DIR}
runner_arch=${3:?usage: install.sh VERSION OS ARCH INSTALL_DIR}
install_dir=${4:?usage: install.sh VERSION OS ARCH INSTALL_DIR}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

case "$version" in
  *[!A-Za-z0-9._-]*|'') echo "unsupported release version: $version" >&2; exit 1 ;;
esac

install_plan=$("$script_dir/resolve-install-plan.sh" "$runner_os" "$runner_arch")
supported=$(jq -r '.supported' <<<"$install_plan")
if [[ "$supported" == "false" ]]; then
  echo "unsupported runner: ${runner_os}/${runner_arch}" >&2
  exit 1
fi
asset=$(jq -r '.asset' <<<"$install_plan")

base_url=${CUSE_RELEASE_BASE_URL:-"https://github.com/crafter-agents/cuse/releases/download/${version}"}
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

curl --fail --silent --show-error --location "$base_url/$asset" --output "$work_dir/$asset"
curl --fail --silent --show-error --location "$base_url/SHA256SUMS" --output "$work_dir/SHA256SUMS"

expected=$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' "$work_dir/SHA256SUMS")
if [[ ! "$expected" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "SHA256SUMS has no valid entry for $asset" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work_dir/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$work_dir/$asset" | awk '{ print $1 }')
fi
actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')
expected=$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')
if [[ "$actual" != "$expected" ]]; then
  echo "checksum mismatch for $asset" >&2
  exit 1
fi

mkdir -p "$install_dir"
destination="$install_dir/cuse"
mv "$work_dir/$asset" "$destination"
chmod +x "$destination"
cd "$install_dir"
printf '%s\n' "$PWD/cuse"
