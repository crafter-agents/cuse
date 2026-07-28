# cuse

Cross-platform computer-use CLI. One verb, the right OS primitive.

The agent writes the same command on every OS; cuse detects the platform and
translates to the native primitive (osascript and CoreGraphics on macOS, xdotool
on Linux, SendKeys and GDI on Windows).

```sh
cuse capture out.png        # screencapture / xwd / GDI CopyFromScreen
cuse focus TextEdit         # put a window in front, so input has a target
cuse type "hello"           # osascript / xdotool / SendKeys
cuse key cmd+a              # chord mapped to each OS input plane
cuse click 400 300          # also dblclick, move, scroll
cuse select-all | copy | paste
cuse settle                 # wait until the screen stops changing
cuse diff a.png b.png       # how much changed, SAME or CHANGED
cuse record 5 500           # 5 frames, 500ms apart
cuse launch TextEdit
cuse os                     # which platform
cuse <action> --json        # structured Result for agents
```

## Install

```sh
bun install
bun run build          # standalone binary at dist/cuse, no runtime needed
```

Named `cuse` rather than `cu` because `cu(1)` from UUCP already ships with macOS
and most Linux distributions, and shadowing it would be a nasty surprise for
anyone who actually uses it.

## Why

Computer-use agents are usually written against one machine, and the failures
that matter only show up on the others. The interesting part of this repo is not
the verb list, it is what running the same binary on a macOS laptop, a Windows
runner and a headless Linux container forces you to admit.

**Every OS exposes input on a different plane.** There is no portable "press
cmd+a". macOS wants an AppleScript keystroke with a `using` clause, Linux wants
an X keysym through xdotool, Windows wants a SendKeys escape string (`^a`).
Keeping that mapping as pure functions is what makes it testable at all: the
argv for all three platforms can be asserted from any one of them.

**Success is the most common way this fails.** Every interesting bug found while
building this was a case where the tool reported `ok` and nothing had happened:

- a screenshot of a screen with nothing on it
- a keystroke sent while no window was focused
- a mouse command that was never a real API to begin with
- a locked machine quietly accepting keystrokes into its password field

None of these produce an error. They produce a confident agent acting on
nothing. So cuse refuses before it acts when it can name the reason, and warns
after it acts when the result is suspicious.

## What actually works where

Observed in CI, not asserted from memory. Each row is a hard gate that decodes
the resulting PNG and uploads it as a build artifact.

| | macOS | Linux (Xvfb) | Windows |
| --- | --- | --- | --- |
| capture | `screencapture`, 1024x768 | `xwd` + cuse's own encoder, 1280x1024 | GDI CopyFromScreen, 1024x768 |
| keyboard input | verified | verified | verified |
| mouse | CoreGraphics, no install | xdotool | user32 `mouse_event` |
| focus | `open -a` | `windowfocus`, no WM needed | `AppActivate` |
| needs installing | nothing | `x11-apps`, `xdotool` (~7 s) | nothing |

**Keyboard input is verified by what the app received**, not by the exit code
and not by pixels. CI opens a real window, focuses it, types, and then checks
something only delivered input can produce:

- macOS types into a file open in TextEdit, saves with `cuse key cmd+s`, and greps
  the file on disk.
- Linux types a command into a shell in an xterm, presses Return with
  `cuse key Return`, and requires the file that command creates to exist.
- Windows types into a window whose text box writes every change to disk, and
  greps that.

It measures the pixel change too — idle 0 px against 837 typed on Linux, and
prints both — but does not gate on it. That check was tried and it was wrong in
both directions: it passed twice on a blinking text caret while no keystroke was
landing, and failed twice on a window still drawing while input was landing
fine. A gate that can pass without the thing it tests is worse than none, so the
pixel delta is reported as evidence and the file on disk is what has to be true.

**Windows took two readings to get right.** The first conclusion was that a
hosted runner cannot receive input at all, because Notepad never appeared. A
recon job disproved it: the job runs in the interactive session, session 2, with
a real foreground window and input desktop. What fails is Notepad specifically —
on Windows Server it is the Store build and `Start-Process` returns nothing.
Given a window that does exist, SendKeys lands: 2386 pixels changed and the text
arrived in the box.

## The blank frame

A display with nothing drawn on it still yields a correctly sized PNG. An agent
reading only `ok: true` will keep clicking against it.

```console
$ cuse capture out.png --json
{"ok":true,"action":"capture","os":"linux","detail":"295B -> out.png",
 "warn":"frame is blank: the display is on but nothing is drawn on it - input actions will be delivered to no window"}
```

cuse decodes the frame and checks whether every pixel is identical, which is
exact. It first shipped as a bytes-per-pixel heuristic, and that was not enough:
a black 3024x1964 macOS frame compressed to 112 KB, comfortably above any
size threshold, and only the decode caught it. The heuristic remains as a
fallback for images the decoder refuses.

## Nothing waits forever

Every backend cuse shells out to can hang — osascript on an app that stopped
answering, xdotool on a wedged X server, PowerShell on a COM call — and the
agent driving cuse has no timeout of its own. So no command runs without a
deadline, tuned per action and overridable with `--timeout=<ms>`.

Getting that right took one more step than it looks. Killing the child is not
enough: a wrapper's own child keeps the stdout pipe open, so the read never
finishes and the deadline achieves nothing. cuse returns the moment the deadline
passes and then kills the whole descendant tree, bounded so that cleanup cannot
become the new way to hang.

```console
$ cuse capture out.png --timeout=3000 --json     # with a backend that never returns
{"ok":false,"action":"capture","os":"macos",
 "error":"screencapture did not finish within 3000ms and was killed (the display or the app it drives is not responding)"}
$ echo $?
3
```

Exit codes are meant to be branched on without parsing prose: `0` ok, `1`
failed, `2` bad usage, `3` timed out, `4` refused because the machine cannot do
it (missing dependency, no display, locked session).

## Design

- **Pure core, tested.** Command mapping (`src/commands.ts`, `src/os.ts`), input
  plans (`src/plan.ts`), capability reasoning (`src/preflight.ts`), lock-state
  parsing (`src/session.ts`) and image comparison (`src/png.ts`) are pure
  functions. 95 tests, no machine side effects. The CLI only wires execution
  around them.
- **Structured output.** Every action returns a typed `Result` ({ok, action, os,
  detail?, error?, warn?, data?}); `--json` emits it. A missing dependency comes
  back with its install line, and a failing command reports what the OS actually
  said rather than an exit code.
- **Fails before touching the machine.** Preflight runs first, so a missing tool
  or an absent `DISPLAY` is a clean refusal, not a half-performed action.
- **Refuses to type at a login window.** A locked Mac accepts synthetic
  keystrokes and routes them to the password field. Input actions check the
  session first; a definite lock blocks, an unreadable state never does, and
  `--force` overrides.
- **No image library.** `src/png.ts` decodes and encodes PNG and `src/xwd.ts`
  reads the dump format `xwd` writes, so `diff`, blank detection and the Linux
  capture path all work with nothing installed. That is what lets Linux take a
  screenshot with `x11-apps` instead of imagemagick.
- **Ships as a binary.** `bun build --compile` produces a standalone executable.

## Develop

```sh
bun test          # 95 tests, the agnostic core
bun run build     # compile a standalone binary to dist/cuse
```

## Known limits

- macOS needs Screen Recording permission for the calling terminal. Without it
  `screencapture` yields a frame without windows, which is not detectable from
  the file alone.
- macOS keystrokes go to the frontmost app, so `focus` before `type`. CI hit
  exactly this: after waiting for the screen to settle, TextEdit was no longer
  frontmost and the keystroke moved 126 pixels, the size of the caret.
- `settle` waits for three quiet intervals in a row, which is a heuristic, not a
  guarantee. An app that has been launched but has not drawn yet is perfectly
  still, and one quiet interval used to be enough to fool it.
- `scroll` on Windows sends Page Up/Down rather than a wheel event.
- Linux needs `x11-apps` and `xdotool`, and an X display. Both install in about
  seven seconds on a runner; Wayland is not supported.
- The binary name collides with `cuse(1)` from UUCP, which ships with macOS and
  many Linux distributions. Install it under another name or call it by path
  until that is settled.

## Status

v2 is a TypeScript rewrite of the original bash spike, kept as
`bin/cu-legacy.sh` under its original name. CI runs the unit tests, a capture gate and an input gate on
macOS, Linux and Windows, and a `recon` workflow that reports what each runner
actually provides — which is where the dependency and Windows decisions above
came from. Built by Kai.
