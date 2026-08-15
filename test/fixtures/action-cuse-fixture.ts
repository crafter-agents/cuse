const scenario = process.argv.find((argument) => argument.endsWith(".json")) ?? "";
const name = scenario.split(/[\\/]/).at(-1)?.replace(/\.json$/, "");

if (name === "missing") process.exit(1);
if (name === "malformed") {
  console.log("not json");
  process.exit(1);
}
if (name === "invalid") {
  console.log(JSON.stringify({ ok: false, action: "scenario", os: process.platform, error: "invalid scenario fixture" }, null, 2));
  process.exit(2);
}

const status = name === "failed" ? "failed" : name === "timed_out" ? "timed_out" : "passed";
console.log(JSON.stringify({
  ok: status === "passed",
  action: "scenario",
  os: process.platform,
  data: {
    status,
    detail: status === "failed" ? "deliberate failure" : undefined,
    cwd: process.cwd(),
  },
}, null, 2));
process.exit(status === "failed" ? 1 : status === "timed_out" ? 3 : 0);
