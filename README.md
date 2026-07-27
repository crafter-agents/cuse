# cu

Cross-platform computer-use CLI. One verb, the right OS primitive.

The agent writes the same command on every OS; cu detects the platform and
translates to the native primitive (osascript on macOS, SendKeys on Windows,
xdotool on Linux).

```sh
cu capture out.png        # screencapture / import / GDI CopyFromScreen
cu type "hello"           # osascript / xdotool / SendKeys
cu key cmd+a              # chord mapped to each OS input plane
cu launch TextEdit
cu move 200 200
cu scroll down 3
cu select-all | copy | paste
cu os                     # which platform
cu <action> --json        # structured Result for agents
```

## Why

Computer-use agents are usually written against one machine, and the failures
that matter only show up on the others. The interesting part of this repo is not
the verb list, it is what running the same binary on a macOS laptop, a Windows
runner and a headless Linux container forces you to admit:

- **Every OS exposes input on a different plane.** There is no portable "press
  cmd+a". macOS wants an AppleScript keystroke with a `using` clause, Linux wants
  an X keysym through xdotool, Windows wants a SendKeys escape string (`^a`).
  Keeping that mapping as pure functions is what makes it testable at all - the
  argv for all three platforms can be asserted from any one of them.
- **"Headless" has three distinct failure modes,** and only one of them is loud:
  the tool is missing, the display is missing, or the display exists with nothing
  drawn on it. The third one is the dangerous one, because capture succeeds.
- **A screenshot that succeeds can still be empty.** A blank 1280x1024 frame is a
  valid PNG of the right dimensions. An agent that checks only the exit code will
  happily keep clicking against a black screen.

So cu refuses before it acts when it can name the reason, and warns after it acts
when the result is suspicious.

## What actually works where

Observed in CI, not asserted from memory. Every row is a hard gate that decodes
the PNG's IHDR and uploads the frame as a build artifact:

| Runner | capture | Observed frame |
| --- | --- | --- |
| macos-latest | works on the runner's own session | 1024x768, 80 KB |
| windows-latest | works on the runner's own session | 1024x768, 268 KB |
| ubuntu-latest, as-is | refused, with the fix in the message | `import not found: apt-get install -y imagemagick` |
| ubuntu-latest, under `xvfb-run` | succeeds, but the frame is blank | 1280x1024, **295 bytes** - warned |

That last row is the whole point. The capture is real and correctly sized; there
is simply no desktop on the display. cu reports it:

```console
$ cu capture out.png --json
{"ok":true,"action":"capture","os":"linux","detail":"295B -> out.png",
 "warn":"frame looks blank (295B for 1280x1024): the display is on but nothing is drawn on it"}
```

The check is bytes-per-pixel, because a uniform image compresses to almost
nothing: 0.0002 B/px on a bare Xvfb against 0.10 and 0.34 on real macOS and
Windows sessions, three orders of magnitude apart. It is a heuristic, so it
warns - it never turns a successful capture into a failure.

## Design

- **Pure core, tested.** Command mapping (`src/commands.ts`, `src/os.ts`) and the
  capability reasoning (`src/preflight.ts`) are pure functions: which argv each
  action becomes per OS, and whether this machine can run it. Fully unit-tested
  with no machine side effects. The CLI (`src/cli.ts`) only wires execution
  around them.
- **Structured output.** Every action returns a typed `Result` ({ok, action, os,
  detail?, error?, warn?}); `--json` emits it for agents. Failures are
  structured and actionable - a missing dependency comes back with its install
  line, not an opaque exit code.
- **Fails before touching the machine.** Preflight runs first, so a missing tool
  or an absent `DISPLAY` is a clean refusal rather than a half-performed action.
- **Ships as a binary.** `bun build --compile` produces a standalone executable,
  no runtime to install (kills the node-shebang problem for good).

## Develop

```sh
bun test          # 28 tests, the agnostic core
bun run build     # compile a standalone binary to dist/cu
```

## Known limits

- macOS needs Screen Recording permission for the calling terminal. Without it
  `screencapture` yields a desktop-only frame; that one is not detectable from
  file size alone.
- Input actions (`type`, `key`, `click`) need a focused window to receive them. On
  a bare Xvfb they are delivered to nothing and report success.

## Status

v2 is a TypeScript rewrite of the original bash spike (kept as
`bin/cu-legacy.sh`). Tested on macOS, Windows and Linux via CI matrix, with
capture gated separately on all three. Built by Kai.
