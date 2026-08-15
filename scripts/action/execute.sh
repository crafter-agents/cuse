#!/usr/bin/env bash
set -euo pipefail

executable=${1:?usage: execute.sh <executable> <scenario> <working-directory> <output-file>}
scenario=${2:?usage: execute.sh <executable> <scenario> <working-directory> <output-file>}
working_directory=${3:?usage: execute.sh <executable> <scenario> <working-directory> <output-file>}
output_file=${4:?usage: execute.sh <executable> <scenario> <working-directory> <output-file>}
result_file=$(mktemp "${TMPDIR:-/tmp}/cuse-result.XXXXXX")
trap 'rm -f "${result_file}"' EXIT

set +e
(cd "${working_directory}" && "${executable}" scenario "${scenario}" --json) >"${result_file}"
scenario_exit=$?
set -e

verdict=$(node -e '
  const fs = require("node:fs");
  const text = fs.readFileSync(process.argv[1], "utf8");
  let result;
  try { result = JSON.parse(text); } catch { process.exit(1); }
  const exitCode = Number(process.argv[2]);
  const fallback = { 0: "passed", 1: "failed", 2: "invalid", 3: "timed_out", 4: "refused" }[exitCode];
  const verdict = result?.action === "scenario" ? result?.data?.status ?? fallback : undefined;
  if (typeof verdict !== "string" || !/^[a-z][a-z_]*$/.test(verdict)) process.exit(1);
  process.stdout.write(verdict);
' "${result_file}" "${scenario_exit}") || {
  echo "cuse execution adapter expected one structured scenario result" >&2
  exit 4
}

delimiter="cuse_result_${RANDOM}_${RANDOM}"
while grep -Fqx "${delimiter}" "${result_file}"; do
  delimiter="cuse_result_${RANDOM}_${RANDOM}"
done
{
  echo "verdict=${verdict}"
  echo "result-json<<${delimiter}"
  cat "${result_file}"
  echo
  echo "${delimiter}"
  echo "exit-code=${scenario_exit}"
} >>"${output_file}"

exit "${scenario_exit}"
