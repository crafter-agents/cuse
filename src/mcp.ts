import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Options, Result } from "./cli.ts";

type Act = (action: string, args: string[], opts: Options) => Promise<Result>;

const readOnly = { readOnlyHint: true } as const;

function toolResult(result: Result) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: { ...result },
    isError: !result.ok,
  };
}

export async function startMcpServer(act: Act, opts: { allowInput?: boolean } = {}): Promise<void> {
  const server = new McpServer({ name: "cuse", version: "0.2.1" });

  server.registerTool("windows", {
    description: "List visible windows and their bounds.",
    inputSchema: {
      timeoutMs: z.number().int().positive().optional(),
    },
    annotations: readOnly,
  }, async ({ timeoutMs }) => toolResult(await act("windows", [], { timeoutMs })));

  server.registerTool("elements", {
    description: "List accessibility elements for an application.",
    inputSchema: {
      app: z.string().optional(),
      depth: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
    annotations: readOnly,
  }, async ({ app, depth, limit, timeoutMs }) =>
    toolResult(await act("elements", app === undefined ? [] : [app], { depth, limit, timeoutMs })));

  server.registerTool("capture", {
    description: "Capture a display or window to a PNG file.",
    inputSchema: {
      path: z.string().optional(),
      window: z.string().optional(),
      display: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
    annotations: readOnly,
  }, async ({ path, window, display, timeoutMs }) =>
    toolResult(await act("capture", path === undefined ? [] : [path], { window, display, timeoutMs })));

  server.registerTool("os", {
    description: "Report the current operating system.",
    annotations: readOnly,
  }, async () => toolResult(await act("os", [], {})));

  server.registerTool("diff", {
    description: "Compare two PNG files and report how much changed.",
    inputSchema: {
      before: z.string(),
      after: z.string(),
      sameUnder: z.number().min(0).optional(),
    },
    annotations: readOnly,
  }, async ({ before, after, sameUnder }) =>
    toolResult(await act("diff", [before, after], { sameUnder })));

  if (opts.allowInput) {
    const inputInjecting = { readOnlyHint: false, destructiveHint: true } as const;

    server.registerTool("click", {
      description: "Click at coordinates or at a resolved target.",
      inputSchema: {
        x: z.number().optional(),
        y: z.number().optional(),
        window: z.string().optional(),
        find: z.string().optional(),
        element: z.string().optional(),
        role: z.string().optional(),
        button: z.enum(["left", "right", "middle"]).optional(),
        modifiers: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      },
      annotations: inputInjecting,
    }, async ({ x, y, window, find, element, role, button, modifiers, timeoutMs }) =>
      toolResult(await act("click", x === undefined ? [] : [String(x), String(y)], {
        window, find, element, role, button, modifiers, timeoutMs,
      })));

    server.registerTool("type", {
      description: "Type text using the operating system input mechanism.",
      inputSchema: { text: z.string() },
      annotations: inputInjecting,
    }, async ({ text }) => toolResult(await act("type", [text], {})));

    server.registerTool("key", {
      description: "Send a key chord such as cmd+c.",
      inputSchema: { chord: z.string() },
      annotations: inputInjecting,
    }, async ({ chord }) => toolResult(await act("key", [chord], {})));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
}
