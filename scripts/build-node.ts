import { chmod, rm } from "node:fs/promises";

const output = "dist/cli.js";
await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  naming: "cli.js",
  target: "node",
  external: ["koffi"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bundle = await Bun.file(output).text();
if (!bundle.startsWith("#!/usr/bin/env bun\n")) {
  throw new Error(`Unexpected bundle header in ${output}`);
}

await Bun.write(output, bundle.replace("#!/usr/bin/env bun\n", "#!/usr/bin/env node\n"));
await chmod(output, 0o755);
