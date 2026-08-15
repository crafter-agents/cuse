#!/usr/bin/env bash
set -euo pipefail

override=${1-}
installed=${2-}
workspace=${3:?usage: select-executable.sh OVERRIDE INSTALLED WORKSPACE}
candidate=$installed
source=downloaded

if [[ -n "$override" ]]; then
  candidate=$override
  source=override
  if [[ "$candidate" != /* ]]; then
    candidate="$workspace/$candidate"
  fi
fi

if [[ -z "$candidate" ]]; then
  echo "no cuse executable was selected" >&2
  exit 1
fi
if [[ ! -e "$candidate" ]]; then
  echo "cuse executable $source does not exist: $candidate" >&2
  exit 1
fi
if [[ ! -f "$candidate" ]]; then
  echo "cuse executable $source is not a file: $candidate" >&2
  exit 1
fi
if [[ ! -x "$candidate" ]]; then
  echo "cuse executable $source is not executable: $candidate" >&2
  exit 1
fi

directory=$(cd "$(dirname "$candidate")" && pwd -P)
printf '%s/%s\n' "$directory" "$(basename "$candidate")"
