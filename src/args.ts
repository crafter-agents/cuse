// Turning a command line into an action, its arguments and its options.
//
// Pure and separate from the CLI because the agent loop needs exactly the same
// parsing: a line typed at a shell and a line fed to `cuse serve` should mean
// the same thing, and there is no reason for two implementations to drift.

import type { Options } from "./cli.ts";

export type Parsed = { action: string; args: string[]; opts: Options; json: boolean };

/**
 * Split a command line the way a shell would, but only as far as quoting.
 *
 * `type "hello world"` has to arrive as one argument, and a Windows path in a
 * flag must survive its backslashes - so a quote is honoured and nothing else
 * is interpreted.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === " " || c === "\t") {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

export function parseArgs(argv: string[]): Parsed {
  const flag = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : hit.slice(name.length + 3);
  };
  const atRaw = flag("at");

  const opts: Options = {
    force: argv.includes("--force"),
    gone: argv.includes("--gone"),
    sameUnder: flag("same-under") !== undefined ? Number(flag("same-under")) : 1,
    timeoutMs: num(flag("timeout")),
    window: flag("window"),
    find: flag("find"),
    minScore: num(flag("min-score")),
    display: num(flag("display")),
    depth: num(flag("depth")),
    limit: num(flag("limit")),
    video: argv.includes("--video"),
    out: flag("out"),
    expectFront: flag("expect-front"),
    element: flag("element"),
    role: flag("role"),
    app: flag("app"),
    button: flag("button"),
    modifiers: flag("modifiers"),
    at: atRaw ? (atRaw.split(",").map(Number) as [number, number]) : undefined,
  };

  const [action, ...args] = argv.filter((a) => !a.startsWith("--"));
  return { action: action ?? "", args, opts, json: argv.includes("--json") };
}

/** Options that outlive one command in a session, and how a line changes them. */
export type Session = Pick<Options, "app" | "window" | "timeoutMs" | "force">;

/**
 * Merge what the session remembers with what this line said.
 *
 * The line always wins. The point of remembering `--app` is that an agent
 * should not have to repeat it twenty times, not that it can never change.
 */
export function withSession(opts: Options, session: Session): Options {
  return {
    ...opts,
    app: opts.app ?? session.app,
    window: opts.window ?? session.window,
    timeoutMs: opts.timeoutMs ?? session.timeoutMs,
    force: opts.force || session.force || false,
  };
}
