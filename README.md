# cuse

Cross-platform computer-use CLI. One verb, the right OS primitive.

The agent writes the same command on every OS; cuse detects the platform and
translates to the native primitive (osascript and CoreGraphics on macOS, xdotool
on Linux, SendKeys and GDI on Windows).

```sh
cuse capture out.png        # screencapture / xwd / GDI CopyFromScreen
cuse focus TextEdit         # put a window in front, so input has a target
cuse windows                # what is open, and where
cuse elements TextEdit      # the controls in it: role, name, rectangle
cuse type "hello"           # osascript / xdotool / SendKeys
cuse key cmd+a              # chord mapped to each OS input plane
cuse click --element=Save   # click the control that says Save
cuse click --find=btn.png   # or the one that looks like this
cuse click 400 300          # or a coordinate, if you have one
cuse select-all | copy | paste
cuse wait --element=Save    # until that control exists (or --gone)
cuse settle                 # wait until the screen stops changing
cuse diff a.png b.png       # how much changed, SAME or CHANGED
cuse record 5 500           # 5 frames, 500ms apart
cuse launch TextEdit
cuse serve                  # one process, a command per line, JSON per line
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

## Aiming without coordinates

An agent has a screenshot and an intention; it does not have coordinates. Two
routes turn one into the other, and the semantic one should be preferred
wherever it works.

**By name**, from the accessibility tree every OS already publishes - the same
one screen readers use. This survives a theme change, a different font, and a
window that moved, all of which defeat a picture.

```console
$ cuse elements Ghostty --json
{"ok":true,"action":"elements","os":"macos","detail":"56 controls, 26 named: tab 'tab bar', button 'Close tab', ...

$ cuse click --element="Close tab" --role=button --app=Ghostty --json
{"ok":true,"action":"click","os":"macos","detail":"click at button 'Close tab' (18x18 at 84,44)","data":{"x":93,"y":53}}
```

Roles are normalised to one small vocabulary, because AXButton, Button and
"push button" are the same thing to someone trying to press it. An exact name
beats a longer one containing it, and among equal matches the smallest control
wins: on macOS a button's name is often repeated on the group around it, and
clicking the group is clicking the wrong thing. A selector that matches nothing
lists what is there instead of failing blank.

**By picture**, when the tree is unavailable or the thing is not a control:

```console
$ cuse find button.png --json
{"ok":true,"action":"find","os":"macos","detail":"found button.png at 1030,460 in the frame (score 1.000) -> click 515,230"}
```

Searching a 3024x1964 frame takes about 0.4s. `find` refuses a template with no
structure in it rather than returning a confident wrong point - a blank stretch
of text box matches a hundred equally blank places, and the score cannot tell
you the answer is not unique, only that the pixels agree.

Where each route works, measured on the runners:

| | accessibility tree | template match |
| --- | --- | --- |
| macOS | AX via System Events, 11 controls for a TextEdit window | yes |
| Windows | UI Automation | yes |
| Linux | implemented against AT-SPI, but see below | yes |

On Linux the tree can be read but not aimed at, on a runner. With `at-spi2-core`
installed, `toolkit-accessibility` switched on and the bus started by hand, the
registry sees a GTK app and cuse reads its 17 controls with the right roles and
names - and every single rectangle comes back as 0,0. Without a window manager
the toolkit does not know where its own window is. A tree that names controls
but cannot place them is the confident-wrong-answer trap again, so cuse refuses
to aim by it and says why.

CI asserts exactly that, rather than hoping for better: the tree is readable,
its geometry is not, and the refusal happens. The day a runner reports real
coordinates that job goes red, which is the signal to promote the Linux route
from a refusal to a click.

Two caveats worth knowing. WinForms reports its controls to UI Automation as
plain panes rather than as buttons and text boxes, so on Windows the name is the
selector that means something and the role is not. And on Windows the first
click on an inactive window activates it and goes no further - CI resolves the
Save button and presses it with two clicks for exactly that reason.

## Waiting for a thing, not for a duration

Every desktop script is full of sleeps, and each one is a guess: too short on a
slow machine, wasted time on a fast one. `wait` polls for the thing itself.

```console
$ cuse wait --window=target.txt --json
{"ok":true,"action":"wait","detail":"a window matching 'target.txt' appeared after 1200ms (3 looks)"}

$ cuse wait --element=Save --role=button --app=TextEdit --timeout=5000 --json
{"ok":false,"action":"wait",
 "error":"a control role 'button' named 'Save' never appeared after 5000ms - what is there: button 'Cancel', label 'Done'"}
```

`--gone` inverts it, for closing a dialog and knowing it closed. A timeout says
what it was waiting for and what was there instead, because an agent that is
told only "timed out" has to go and look, which is the call it just made.

This verb exists because CI had a hand-rolled version of it - poll the window
list until the document shows up - and a loop like that in a caller is usually a
tool missing a verb.

## One process, many commands

An agent doing twenty things paid for twenty process starts and re-enumerated
the desktop each time. `serve` reads one command per line and answers with one
JSON Result per line, in a single process that remembers what it was told.

```console
$ cuse serve
use --app=TextEdit
{"ok":true,"action":"use","detail":"{\"app\":\"TextEdit\"}"}
click --element=Save
{"ok":true,"action":"click","detail":"click at button 'Save' (74x22 at 612,410)"}
type "done"
{"ok":true,"action":"type","detail":"typed"}
```

Twenty actions cost 298ms as separate processes and 21ms here. A line that fails
comes back as a failed Result and the loop continues, because an agent recovers
from a missing button and killing its tool over one is not help.

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
  functions. 202 tests, no machine side effects. The CLI only wires execution
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
- **Names before pixels.** `src/elements.ts` reads the platform's accessibility
  tree and `src/window.ts` its window list, so an agent can say what it wants
  instead of where it is. `src/match.ts` is the fallback for what has no name.
- **No image library.** `src/png.ts` decodes and encodes PNG and `src/xwd.ts`
  reads the dump format `xwd` writes, so `diff`, blank detection and the Linux
  capture path all work with nothing installed. That is what lets Linux take a
  screenshot with `x11-apps` instead of imagemagick.
- **Ships as a binary.** `bun build --compile` produces a standalone executable.

## Develop

```sh
bun test          # 202 tests, the agnostic core
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

## Known limits

- The similarity score in `find` is a mean pixel distance, so flat or sparse
  content scores high anywhere; that is why a template's own structure is
  checked first. A normalised correlation would judge better.
- Linux has no accessibility tree out of the box: AT-SPI has to be installed,
  and the toolkit has to export one. A GTK app does and CI proves it; an xterm
  never will.
- An empty view and a view of nothing are different: with the screen locked
  nothing can be enumerated at all, so `windows` and `elements` say which of the
  two it is rather than reporting an empty desktop.
- macOS raises a Screen Recording prompt once a process has taken a few
  screenshots. It floats above the frontmost app without becoming it, so the
  `--expect-front` guard cannot see it, and it swallows every keystroke after
  that. CI proves input before taking any screenshot for this reason.

## Status

v2 is a TypeScript rewrite of the original bash spike, kept as
`bin/cu-legacy.sh` under its original name. CI runs the unit tests, a capture gate and an input gate on
macOS, Linux and Windows, and a `recon` workflow that reports what each runner
actually provides — which is where the dependency and Windows decisions above
came from. Built by Kai.
