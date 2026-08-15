#!/usr/bin/env node

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

const [runnerTemp, requestedName, resultText, exitCodeText, outputFile, summaryFile] = process.argv.slice(2);
if (![runnerTemp, requestedName, resultText, exitCodeText, outputFile, summaryFile].every((value) => value !== undefined)) {
  console.error("usage: prepare-evidence.mjs <runner-temp> <evidence-name> <result-json> <exit-code> <output-file> <summary-file>");
  process.exit(4);
}

function portableName(value) {
  const normalized = value.normalize("NFKC")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80);
  return normalized || "cuse-evidence";
}

function sanitize(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value === null || typeof value !== "object") return value;
  if (/^(?:env|environment)$/i.test(key)) {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, "[REDACTED]"]));
  }
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [
    name,
    /(?:token|secret|password|credential|(?:api|access|client|private|public|signing|encryption)[_-]?key)/i.test(name)
      ? "[REDACTED]"
      : sanitize(child, name),
  ]));
}

const evidenceName = portableName(requestedName);
const evidenceRoot = join(runnerTemp, "cuse-evidence");
const evidencePath = join(evidenceRoot, evidenceName);
const contained = relative(evidenceRoot, evidencePath);
if (contained.startsWith("..") || isAbsolute(contained)) {
  console.error("evidence path escaped the runner temporary directory");
  process.exit(4);
}

const exitCode = /^\d+$/.test(exitCodeText) ? Number(exitCodeText) : undefined;
let result;
try {
  result = JSON.parse(resultText);
} catch {
  result = undefined;
}
const verdict = result?.action === "scenario" && typeof result?.data?.status === "string"
  ? result.data.status
  : undefined;
const status = verdict && exitCode !== undefined ? verdict : "adapter_failure";

await rm(evidencePath, { recursive: true, force: true });
await mkdir(evidencePath, { recursive: true });
if (result !== undefined) {
  await writeFile(join(evidencePath, "result.json"), `${JSON.stringify(sanitize(result), null, 2)}\n`, "utf8");
} else {
  await writeFile(join(evidencePath, "adapter-error.txt"), "The execution adapter did not produce a valid structured scenario result.\n", "utf8");
}

await appendFile(outputFile, `evidence-path=${evidencePath}\n`, "utf8");
const exitDisplay = exitCode === undefined ? "not reported" : String(exitCode);
const gap = status === "adapter_failure"
  ? "\n> Gap: The execution adapter did not provide a valid scenario result and exit code.\n"
  : "";
await appendFile(summaryFile, [
  "## cuse scenario result",
  "",
  "| Field | Value |",
  "| --- | --- |",
  `| Status | \`${status}\` |`,
  `| Exit code | \`${exitDisplay}\` |`,
  `| Evidence | \`${evidencePath}\` |`,
  gap,
].join("\n"), "utf8");
