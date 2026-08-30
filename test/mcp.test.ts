import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "cli.ts");

type CuseResult = {
  ok: boolean;
  action: string;
  error?: string;
  data?: unknown;
};

async function runCli(...args: string[]): Promise<CuseResult> {
  const child = Bun.spawn([process.execPath, cli, ...args, "--json"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 8_000);
  try {
    const output = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(output) as CuseResult;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopTextEdit(): Promise<void> {
  const child = Bun.spawn(["pkill", "-9", "-x", "TextEdit"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
}

async function liveTestBlocker(): Promise<string | undefined> {
  if (process.platform !== "darwin") return "TextEdit is only available on macOS";
  await stopTextEdit();
  const launched = await runCli("launch", "TextEdit", "--timeout=5000");
  if (!launched.ok) return launched.error ?? "TextEdit did not launch";
  const focused = await runCli("focus", "TextEdit", "--timeout=5000");
  if (!focused.ok) return focused.error ?? "TextEdit did not focus";
  const windows = await runCli("windows", "--timeout=5000");
  await stopTextEdit();
  return windows.ok ? undefined : windows.error ?? "the window list is unavailable";
}

const blocker = await liveTestBlocker();
if (blocker) console.warn(`MCP TextEdit end-to-end test skipped: ${blocker}`);

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
        "click", "type", "key", "paste", "drag", "scroll", "launch", "focus", "wait", "fill", "run", "scenario",
      ]) {
        expect(names).not.toContain(inputTool);
      }
    } finally {
      await client.close();
    }
  });

  test("exposes annotated input tools only when explicitly allowed", async () => {
    const client = new Client({ name: "cuse-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--allow-input"],
      cwd: root,
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const response = await client.listTools();
      const names = response.tools.map((tool) => tool.name);

      expect(new Set(names)).toEqual(new Set([
        "windows", "elements", "capture", "os", "diff", "click", "type", "key", "paste",
      ]));
      for (const tool of response.tools) {
        if (["click", "type", "key", "paste"].includes(tool.name)) {
          expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
        } else {
          expect(tool.annotations).toMatchObject({ readOnlyHint: true });
        }
      }
    } finally {
      await client.close();
    }
  });

  test.skipIf(blocker !== undefined)("drives TextEdit end to end over a live MCP connection", async () => {
    const client = new Client({ name: "cuse-e2e-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp", "--allow-input"],
      cwd: root,
      stderr: "pipe",
    });
    const evidence = await mkdtemp(join(tmpdir(), "cuse-mcp-e2e-"));
    const before = join(evidence, "before.png");
    const after = join(evidence, "after.png");

    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: args });
      const result = response.structuredContent as CuseResult | undefined;
      expect(result, `${name} returned no structured result`).toBeDefined();
      expect(result?.ok, result?.error ?? `${name} failed`).toBe(true);
      return result!;
    };

    try {
      await stopTextEdit();
      expect((await runCli("launch", "TextEdit", "--timeout=5000")).ok).toBe(true);
      expect((await runCli("focus", "TextEdit", "--timeout=5000")).ok).toBe(true);
      await client.connect(transport);

      const windows = await call("windows", { timeoutMs: 5_000 });
      expect(windows.data).toBeArray();
      expect((windows.data as Array<{ title: string }>).some((window) =>
        window.title.toLowerCase().includes("textedit") || window.title.toLowerCase().includes("untitled")
      )).toBe(true);

      const elements = await call("elements", { app: "TextEdit", depth: 8, limit: 200, timeoutMs: 5_000 });
      const textBody = (elements.data as Array<{ role: string; name: string }>).find((element) =>
        element.role === "text"
      );
      expect(textBody).toBeDefined();

      const seed = `cuse-mcp-${crypto.randomUUID()}`;
      await call("click", { role: "text", timeoutMs: 5_000 });
      await call("type", { text: seed });

      const namedElements = await call("elements", {
        app: "TextEdit", depth: 8, limit: 200, timeoutMs: 5_000,
      });
      const namedTextBody = (namedElements.data as Array<{ role: string; name: string }>).find((element) =>
        element.role === "text" && element.name.includes(seed)
      );
      expect(namedTextBody).toBeDefined();

      await call("capture", { path: before, window: "TextEdit", timeoutMs: 5_000 });
      await call("click", { element: seed, role: "text", timeoutMs: 5_000 });
      await call("type", { text: " visible change" });
      await call("capture", { path: after, window: "TextEdit", timeoutMs: 5_000 });

      const diff = await call("diff", { before, after, sameUnder: 0 });
      expect(diff.data).toMatchObject({ verdict: "CHANGED" });
    } finally {
      await client.close().catch(() => {});
      await stopTextEdit();
      await rm(evidence, { recursive: true, force: true });
    }
  }, 45_000);
});
