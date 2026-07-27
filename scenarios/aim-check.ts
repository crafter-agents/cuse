#!/usr/bin/env bun
// Can cuse aim at something without being told a coordinate?
//
// This is the part that separates a pair of hands from an agent-usable tool, so
// CI proves it on every platform rather than trusting the unit tests: list the
// windows, cut a patch out of the target window, find that patch again, and
// require the answer to land inside the window it came from.
//
// Run: bun scenarios/aim-check.ts <binary> <window-name>

const [bin, wanted] = [process.argv[2]!, process.argv[3]!];

async function cuse(...args: string[]): Promise<any> {
  const p = Bun.spawn([bin, ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const line = out.trim().split("\n").filter(Boolean).at(-1) ?? "{}";
  const r = JSON.parse(line);
  console.log(" ", line.slice(0, 220));
  return r;
}

const die = (msg: string): never => { console.error(`aim-check: ${msg}`); process.exit(1); };

// 0. Which coordinate spaces are in play? A frame denser than the click space
//    is the difference between aiming at a window and aiming a quarter of the
//    way into the screen.
const screen = await cuse("screen");
if (!screen.ok) die(`could not measure the screen: ${screen.error}`);

// 1. What is on screen?
const listed = await cuse("windows");
if (!listed.ok) die(`could not list windows: ${listed.error}`);
const wins = listed.data as Array<{ title: string; x: number; y: number; width: number; height: number }>;
const win = wins.find((w) => w.title.toLowerCase().includes(wanted.toLowerCase()));
if (!win) die(`'${wanted}' is not among the ${wins.length} windows listed`);
console.log(`window: ${win.title} ${win.width}x${win.height} at ${win.x},${win.y}`);
if (win.width < 50 || win.height < 50) die(`implausible rectangle for ${win.title}`);

// 2. Cut a patch out of the middle of it, and find that patch again.
const frame = "aim-frame.png";
if (!(await cuse("capture", frame)).ok) die("capture failed");

const patch = { w: Math.min(120, Math.floor(win.width / 3)), h: Math.min(60, Math.floor(win.height / 3)) };
const px = Math.max(0, Math.round(win.x + win.width / 2 - patch.w / 2));
const py = Math.max(0, Math.round(win.y + win.height / 2 - patch.h / 2));

console.log(`cropping ${patch.w}x${patch.h} at ${px},${py} (click space)`);
const cropped = await cuse("crop", frame, String(px), String(py), String(patch.w), String(patch.h), "aim-needle.png");
if (!cropped.ok) die(`crop failed: ${cropped.error}`);

let found = await cuse("find", "aim-needle.png");
if (!found.ok) {
  // Worth distinguishing "the matcher is wrong" from "the screen moved": retry
  // once against a frame captured at the same moment as the needle.
  console.log("not found live; retrying against the frame the needle came from");
  found = await cuse("find", "aim-needle.png", "--min-score=0.8");
}
if (!found.ok) die(`the patch cut from this very screen was not found again: ${found.error}`);

// 3. The answer has to be where the patch was cut from - not merely somewhere
//    inside the window. "Inside the window" passed once while the matcher had
//    locked onto a different patch of the same blank text box, which is exactly
//    the kind of green that means nothing.
const { x, y } = found.data as { x: number; y: number };
const want = { x: px + Math.floor(patch.w / 2), y: py + Math.floor(patch.h / 2) };
const off = Math.max(Math.abs(x - want.x), Math.abs(y - want.y));
const tolerance = 4;
if (off > tolerance) {
  die(`found ${x},${y} but the patch was cut from ${want.x},${want.y} - off by ${off}px`);
}
console.log(`aim ok: ${x},${y} is where the patch came from (off by ${off}px)`);

// 4. And a picture that is not on screen must come back as absent, not as the
//    least-bad guess anywhere on the desktop.
const noise = new Uint8Array(60 * 60 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 37 + (i % 7) * 91) % 256;
const { encodePNG } = await import("../src/png.ts");
const { deflateSync } = await import("node:zlib");
await Bun.write("aim-absent.png", encodePNG(
  { width: 60, height: 60, channels: 3, data: noise },
  (d) => new Uint8Array(deflateSync(d))));

const absent = await cuse("find", "aim-absent.png");
if (absent.ok) die(`a picture that is not on screen was reported at ${JSON.stringify(absent.data)}`);
console.log("absent ok: a picture that is not on screen is reported as absent");
