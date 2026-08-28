import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "cli.ts");

describe("MCP server", () => {
  test("exposes exactly the safe read-only tools over stdio", async () => {
    const client = new Client({ name: "cuse-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      cwd: root,
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const response = await client.listTools();
      const names = response.tools.map((tool) => tool.name);

      expect(new Set(names)).toEqual(new Set(["windows", "elements", "capture", "os", "diff"]));
      for (const inputTool of [
        "click", "type", "key", "drag", "scroll", "launch", "focus", "wait", "fill", "run", "scenario",
      ]) {
        expect(names).not.toContain(inputTool);
      }
    } finally {
      await client.close();
    }
  });
});
