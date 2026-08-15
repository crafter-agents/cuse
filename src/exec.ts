// Running other people's programs, defensively.
//
// Every backend cuse shells out to can hang: osascript waits on an app that is
// not answering, xdotool blocks on an X server that stopped responding,
// PowerShell sits on a COM call. A computer-use tool that hangs is worse than
// one that fails - the agent driving it has no timeout of its own and simply
// stops. So nothing here runs without a deadline.
//
// Two things make that harder than it looks, and both were observed rather than
// imagined:
//
//   1. Killing the child is not enough. A wrapper script that spawns `sleep`
//      dies on SIGTERM while its own child keeps the stdout pipe open, so
//      reading the output never finishes and the deadline achieves nothing.
//      The whole descendant tree has to go.
//   2. Waiting for the output at all is a liability. Once the deadline passes,
//      cuse returns; it does not stay to collect what a wedged process might
//      still write.

export type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type BytesResult = { code: number; stdout: Uint8Array; stderr: string; timedOut: boolean };

/** Per-action deadlines. Generous enough for a cold app launch, short enough
 *  that a wedged backend is reported within seconds rather than never. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export const TIMEOUTS: Record<string, number> = {
  capture: 20_000,   // a first screencapture on a cold macOS session is slow
  "ocr-read": 30_000, // cold Swift and Vision module loading measured about 14s
  launch: 30_000,    // cold app start, and `open -a` waits for the app
  focus: 15_000,     // the Linux path polls for ten seconds by design
  type: 20_000,      // long strings are typed character by character
  // A browser window with a native panel over it is a big tree, and the walk is
  // depth-first: too little time here returns a partial tree rather than a slow
  // one, which reads as an app missing controls it has.
  elements: 30_000,
};

export function timeoutFor(action: string, override?: number): number {
  if (override !== undefined && override > 0) return override;
  return TIMEOUTS[action] ?? DEFAULT_TIMEOUT_MS;
}

/** Every descendant of pid, deepest last, via pgrep. Empty when pgrep is absent. */
async function descendants(pid: number): Promise<number[]> {
  const found: number[] = [];
  const walk = async (parent: number, depth: number): Promise<void> => {
    if (depth > 5) return; // a process tree this deep is a loop, not a backend
    try {
      const p = Bun.spawn(["pgrep", "-P", String(parent)], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      await p.exited;
      for (const line of out.trim().split("\n").filter(Boolean)) {
        const child = Number(line);
        if (Number.isFinite(child)) { found.push(child); await walk(child, depth + 1); }
      }
    } catch { /* no pgrep: the direct kill below is all we get */ }
  };
  await walk(pid, 0);
  return found;
}

/** Kill a process and everything it spawned, hard. */
async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // taskkill /T is the only thing that reaches a Windows process tree.
    try {
      const killer = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      const finished = await Promise.race([
        killer.exited.then(() => true),
        Bun.sleep(1500).then(() => false),
      ]);
      if (!finished) {
        try { killer.kill(); } catch { /* gone */ }
        try { process.kill(pid); } catch { /* gone */ }
      }
    } catch { /* gone */ }
    return;
  }
  const kids = await descendants(pid);
  for (const p of [...kids, pid]) {
    try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
  }
}

type PipeRead<T> = { value: Promise<T>; cancel: () => Promise<void> };

function readPipe<T>(stream: ReadableStream<Uint8Array>, convert: (chunks: Uint8Array[]) => T): PipeRead<T> {
  const reader = stream.getReader();
  const value = (async (): Promise<T> => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) return convert(chunks);
      chunks.push(next.value);
    }
  })();
  return {
    value,
    cancel: async () => { try { await reader.cancel(); } catch { /* already closed */ } },
  };
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

const asText = (chunks: Uint8Array[]): string => new TextDecoder().decode(joinBytes(chunks));

/**
 * Spawn argv and wait, but never longer than `ms`.
 *
 * The deadline is a hard promise: when it expires this returns, whatever the
 * child is doing. The kill happens in the background so that even a process
 * that ignores signals cannot hold cuse open.
 */
export async function runWithTimeout(argv: string[], ms: number): Promise<RunResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = readPipe(proc.stdout, asText);
  const stderr = readPipe(proc.stderr, asText);

  const collect = (async (): Promise<RunResult> => {
    const [out, err] = await Promise.all([stdout.value, stderr.value]);
    return { code: await proc.exited, stdout: out, stderr: err, timedOut: false };
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<RunResult>((res) => {
    timer = setTimeout(() => res({ code: -1, stdout: "", stderr: "", timedOut: true }), ms);
  });

  const result = await Promise.race([collect, expired]);
  clearTimeout(timer);
  if (result.timedOut) {
    await Promise.all([stdout.cancel(), stderr.cancel()]);
    // Clean up the tree, but bounded: reaping must not become the new way to
    // hang. Without waiting at all, cuse exits first and leaves the grandchild
    // running - observed with a wrapper script holding a sleep.
    await Promise.race([killTree(proc.pid), Bun.sleep(2000)]);
  }
  return result;
}

/** Same deadline, but keeping stdout as bytes - xwd writes a binary dump there,
 *  and reading it as text would quietly corrupt every pixel. */
export async function runBytes(argv: string[], ms: number): Promise<BytesResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stdout = readPipe(proc.stdout, joinBytes);
  const stderr = readPipe(proc.stderr, asText);
  const collect = (async (): Promise<BytesResult> => {
    const [out, err] = await Promise.all([stdout.value, stderr.value]);
    return { code: await proc.exited, stdout: out, stderr: err, timedOut: false };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<BytesResult>((res) => {
    timer = setTimeout(() => res({ code: -1, stdout: new Uint8Array(0), stderr: "", timedOut: true }), ms);
  });
  const result = await Promise.race([collect, expired]);
  clearTimeout(timer);
  if (result.timedOut) {
    await Promise.all([stdout.cancel(), stderr.cancel()]);
    await Promise.race([killTree(proc.pid), Bun.sleep(2000)]);
  }
  return result;
}

/** The first line of output is the message; the rest is the interpreter's trace. */
export function firstLine(stderr: string, stdout: string): string | undefined {
  return (stderr || stdout).trim().split("\n").map((l) => l.trim()).filter(Boolean)[0];
}

/** Turn a finished process into the error an agent can act on. */
export function explainFailure(argv: string[], r: { code: number; stderr: string; stdout: unknown; timedOut: boolean }, ms: number): string | null {
  if (r.timedOut) {
    return `${argv[0]} did not finish within ${ms}ms and was killed ` +
      `(the display or the app it drives is not responding)`;
  }
  if (r.code === 0) return null;
  const said = firstLine(r.stderr, typeof r.stdout === "string" ? r.stdout : "");
  return said ? `${argv[0]}: ${said}` : `${argv[0]} exited ${r.code}`;
}
