#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error("usage: inspect-scenario.mjs SCENARIO");
  process.exit(2);
}

const DISPLAY_FREE_ACTIONS = new Set(["os", "diff", "ocr-read", "inspect"]);
const X11_APPS_ACTIONS = new Set(["capture", "record", "settle"]);
const XDOTOOL_ACTIONS = new Set([
  "type", "key", "move", "drag", "scroll", "click", "dblclick", "select-all",
  "copy", "paste", "fill", "focus",
]);

function fail(message) {
  console.error(`cannot inspect scenario ${scenarioPath}: ${message}`);
  process.exit(1);
}

let scenario;
try {
  scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
  fail("root must be an object");
}
if (scenario.version !== 1) fail("version must be 1");
if (!Array.isArray(scenario.steps)) fail("steps must be an array");
if (scenario.finally !== undefined && !Array.isArray(scenario.finally)) {
  fail("finally must be an array");
}

const actions = [];
function inspectStep(step, path) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    fail(`${path} must be an object`);
  }
  if (step.type === "wait") {
    inspectStep(step.step, `${path}.step`);
    return;
  }
  if (step.type === "cuse") {
    if (typeof step.action !== "string" || step.action.length === 0) {
      fail(`${path}.action must be a non-empty string`);
    }
    actions.push(step.action);
    return;
  }
  if (!new Set(["exec", "assert"]).has(step.type)) {
    fail(`${path}.type is unsupported`);
  }
}

for (const collection of ["steps", "finally"]) {
  for (const [index, step] of (scenario[collection] ?? []).entries()) {
    inspectStep(step, `${collection}[${index}]`);
  }
}

const displayActions = actions.filter((action) => !DISPLAY_FREE_ACTIONS.has(action));
const conservativeBatch = actions.includes("run");
process.stdout.write(JSON.stringify({
  displayRequired: displayActions.length > 0,
  displayActions: [...new Set(displayActions)],
  x11AppsRequired: conservativeBatch || actions.some((action) => X11_APPS_ACTIONS.has(action)),
  xdotoolRequired: conservativeBatch || actions.some((action) => XDOTOOL_ACTIONS.has(action)),
  accessibilityUsed: actions.includes("elements"),
}));
