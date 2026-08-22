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
cuse record 5 --video       # actual video, where the OS can
cuse launch TextEdit
cuse serve                  # one process, a command per line, JSON per line
cuse os                     # which platform
cuse <action> --json        # structured Result for agents
```

## Install

With Bun, install the npm package or run it without a global install:

```sh
bun add --global cuse-cli
cuse os

bunx cuse os
```

The npm package runs from TypeScript and requires Bun. For a standalone binary
with no runtime dependency, use a release asset below.

Download the binary for your platform from
[Releases](https://github.com/crafter-agents/cuse/releases) — one file, nothing
to install alongside it, no runtime.

```sh
curl -fsSLo cuse https://github.com/crafter-agents/cuse/releases/latest/download/cuse-macos-arm64
chmod +x cuse && ./cuse os
```

Swap the name for `cuse-macos-x64`, `cuse-linux-x64`, `cuse-linux-arm64` or
`cuse-windows-x64.exe`. Every release publishes `SHA256SUMS`, and each binary is
started on the OS it was built for before the release exists — a cross-compiled
executable that cannot run is not something the build machine can notice.

Or from source:

```sh
bun install
bun run build          # standalone binary at dist/cuse, no runtime needed
```

## GitHub Action

Run a checked-in scenario, then upload the prepared evidence in a companion
step. The upload uses `if: always()` so failed and timed-out scenarios still
retain their result bundle. Keep the scenario step's default failure behavior:
its original nonzero exit code remains the job result.

```yaml
- id: cuse
  uses: crafter-agents/cuse@main
  with:
    scenario: scenarios/smoke.json
    evidence-name: smoke-${{ runner.os }}

- name: Upload cuse evidence
  if: always()
  uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
  with:
    name: cuse-smoke-${{ runner.os }}
    path: ${{ steps.cuse.outputs.evidence-path }}
    if-no-files-found: error
```

Do not provide repository secrets to scenarios that can be changed by
untrusted pull requests. The Action prepares evidence and writes the job
summary; artifact upload stays at workflow level so its failure behavior is
visible to the consumer.

Complete consumer workflows are available for each supported setup:

- [`examples/workflows/minimal.yml`](examples/workflows/minimal.yml) demonstrates default usage on Ubuntu.
- [`examples/workflows/windows.yml`](examples/workflows/windows.yml) demonstrates the same scenario on a Windows runner.
- [`examples/workflows/linux-accessibility.yml`](examples/workflows/linux-accessibility.yml) demonstrates opt-in Linux AT-SPI accessibility support.

By default, the Action downloads the requested release and verifies its
checksum. Repository CI may set `executable-path` to an executable built from
the checked-out source; this explicit test seam skips the release download.

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

Searching a 3024x1964 frame takes about 0.4s. The score is a normalised
correlation, which matters for two reasons: the same control found on a dimmer
screen or under a different theme scores the same, so a threshold means one
thing everywhere; and a template with no structure has nothing to correlate, so
it is declined rather than located confidently in the wrong place - a blank
stretch of text box matches a hundred equally blank places.

Where each route works, measured on the runners:

| | accessibility tree | template match |
| --- | --- | --- |
| macOS | AX through the accessibility API, 300 controls of Finder in ~0.35s | yes |
| Windows | UI Automation | yes |
| Linux | AT-SPI, composed against X - 17 controls for a GTK dialog | yes |

Linux took the longest to get right, and the reason is worth writing down. With
`at-spi2-core` installed, `toolkit-accessibility` switched on and the bus
started by hand, the registry sees a GTK app and cuse reads its 17 controls with
the right roles and names - and every single rectangle used to come back as 0,0.
A tree that names controls but cannot place them is the confident-wrong-answer
trap, so cuse refused to aim by it.

That looked like a missing window manager and was not. Start openbox and the
dialog moves to 485,396 by X's own account, while AT-SPI carries on answering
0,0: the GTK bridge does not translate `DESKTOP_COORDS` under Xvfb.
`WINDOW_COORDS` is exact, though, so the answer is composed instead of asked
for - X says where the window is, the tree says where the control is inside it,
and the sum is a coordinate that can be clicked. It is right with a window
manager and without one, and it does not depend on the translation that was
broken.

CI presses a real GTK button by name and lets zenity report what it received;
the job runs a window manager so the window is *not* at the origin, which is
what would make a dropped offset visible instead of harmless. To work on this
without waiting for CI, `sh scenarios/linux-local.sh` runs the same scenario in
a container.

One thing still missing there: an X window whose title cuse cannot match to an
accessible frame is skipped rather than guessed at, and it says so on stderr.

One caveat worth knowing: on Windows the first click on an inactive window
activates it and goes no further, so CI resolves the Save button and presses it
with two clicks for exactly that reason.

The Windows gates drive Character Map as well as a window this repo builds, on
the grounds that a target you wrote answers the way you expected. It is a
classic Win32 dialog Microsoft ships; cuse reads `button 'Select'` and `button
'Copy'` out of it, presses them, and the clipboard - seeded with a sentinel
first, so the check cannot pass on a stale one - comes back holding characters.

WinForms answers `Pane` for every control through UI Automation, which used to
make `--role` useless there. The same controls describe themselves properly
through the older IAccessible interface, so cuse asks both and prefers whichever
says something - `Pane|43` becomes `button`.

## Waiting for a thing, not for a duration

`settle` used to sleep a fixed interval before every check, so a screen that was
already quiet paid the full wait three times over: 2452 ms of which 1500 ms was
sleeping. It now starts at 60 ms and doubles only while frames keep coming back
CHANGED, capped at the same ceiling. A quiet screen answers in about 968 ms, and
a repainting app gets exactly the room it had before.

Passing an explicit gap keeps its old meaning as a fixed wait.

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

Two shapes, and they are not the same tool. `run` takes a list, executes it in
one process and exits, each action independent:

```console
$ cuse run '[["move",100,100],["click"],["type","hello"]]'
{"ok":true,"action":"run","detail":"3 actions in one process"}
```

It stops at the first failure and says how many landed, because an agent that
clicked once and then missed needs that distinction:

```json
{"ok": false, "error": "step 2 (click) failed: ...",
 "data": {"completed": 1, "total": 3}}
```

`serve` keeps the process open and remembers state between lines, so an app
selected once applies to everything after.

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

## Declarative scenarios

`run` and `serve` still need a script to own assertions, variables and
cleanup. `cuse scenario <path>` reads a JSON document instead: one portable
file that mixes cuse actions, raw commands, assertions and waits, with its own
timeout and `finally` cleanup, so a reproduction case is data instead of a
bash script.

```json
{
  "version": 1,
  "name": "readme example",
  "vars": {},
  "defaultTimeoutMs": 5000,
  "steps": [
    { "type": "exec", "argv": ["echo", "ok"], "saveAs": "echoed" },
    { "type": "assert", "actual": "${steps.echoed.stdout}", "operator": "contains", "expected": "ok" }
  ]
}
```

```console
$ cuse scenario example.json
scenario: scenario readme example: passed in 2ms
$ echo $?
0
```

Four step types:

- `cuse`: an existing cuse action, `{"type":"cuse","action":"click","args":["--element=Save"]}`.
- `exec`: an argv array run without a shell in between, so a value that came
  from an earlier step's output cannot smuggle in a `;` or `$(...)`,
  `{"type":"exec","argv":["ls","-la"]}`.
- `assert`: compares two values with `eq`, `ne`, `contains`, `exists`, `gt`,
  `gte`, `lt` or `lte`, and reports both sides when it fails.
- `wait`: retries a nested `cuse`, `exec` or `assert` step every
  `intervalMs` (100ms by default) until it passes or the step's own timeout
  runs out. A `wait` cannot nest another `wait`.

`saveAs` on any step stores its result under `steps.<name>` for later steps.
`${vars.x}` and `${steps.name.path}` interpolate into any string field of a
later step, in a string, array or object; `${steps.echoed.stdout}` above
reaches into the `exec` step's captured stdout. A whole-string reference like
`"${steps.echoed}"` resolves to the referenced value itself, not a
stringified copy; embedding it inside a longer string coerces it to text.

### Assert an element's observed state

The singular `element` action selects exactly one control by `--element` or
`--role`. Unlike the plural `elements` action, it returns that control with
every accessibility property the platform backend actually reported, plus a
human-readable summary in `detail`. Save the result and assert a reported
property through `steps.<name>.data`:

```json
{
  "version": 1,
  "name": "remember preference",
  "vars": {},
  "defaultTimeoutMs": 5000,
  "steps": [
    { "type": "cuse", "action": "element", "args": ["--element=Remember me"], "saveAs": "target" },
    { "type": "assert", "actual": "${steps.target.data.checked}", "operator": "eq", "expected": true }
  ]
}
```

This `element` plus `assert` pattern is covered by a unit test with a stubbed
cuse invocation. The `value` property is also exercised against a live control
on every supported platform, with a matching negative scenario that forces the
assertion red once. macOS runs `mac-element-assert.json` and
`mac-element-assert-negative.json` from `.github/workflows/ci.yml`; Linux runs
`linux-element-assert.json` and `linux-element-assert-negative.json` from
`scenarios/linux-atspi.sh`; Windows runs `windows-element-assert.json` and
`windows-element-assert-negative.json` from
`scenarios/verify-workaround.sh`.

All eight normalized properties are extracted on all three platforms. A cell
marked **Extracted + live gate** additionally has the forced-red live CI
coverage described above; **Extracted** does not yet have that live gate.

| Property | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `value` | Extracted + live gate | Extracted + live gate | Extracted + live gate |
| `enabled` | Extracted | Extracted | Extracted |
| `selected` | Extracted | Extracted | Extracted |
| `checked` | Extracted | Extracted | Extracted |
| `expanded` | Extracted | Extracted | Extracted |
| `focused` | Extracted | Extracted | Extracted |
| `automationId` | Extracted | Extracted | Extracted |
| `processId` | Extracted | Extracted | Extracted |

Steps 4 and 5 of issue #35 Plan 006 are therefore covered by real live gates
for `value`, and this matrix covers Step 6. Extending those live gates to the
other seven properties is future work and is not claimed here.

Every step needs a `timeoutMs`, its own or the scenario's
`defaultTimeoutMs`; there is no unbounded step. `platforms` restricts a
scenario to `macos`, `linux` or `windows`, and a mismatched platform reports
`skipped`, not a failure. `finally` steps always run, whether the main steps
passed, failed or timed out, and a failure there reports `cleanup_failed`
even when every main step passed.

```json
{
  "version": 1,
  "name": "readme fail example",
  "vars": {},
  "defaultTimeoutMs": 5000,
  "steps": [
    { "type": "assert", "actual": "no", "operator": "eq", "expected": "ok" }
  ]
}
```

```console
$ cuse scenario fail-example.json --json
{"ok":false,"action":"scenario","os":"macos","detail":"scenario readme fail example: failed in 0ms", ...}
$ echo $?
1
```

`--json` returns the full result: `status`
(`passed`/`failed`/`timed_out`/`skipped`/`cleanup_failed`), `platform`,
`durationMs` and every attempted step with its own status, so a failure
mid-run still shows what ran before it. Exit codes: `0` passed, `3` timed
out, `2` for a malformed scenario file or a missing path, `1` for every other
non-passing status, including a skipped or cleanup-failed run.

`scenarios/cuse-selftest.json` is the reference: it launches TextEdit, types
into it and captures before/after screenshots, the same coverage
`scenarios/cuse-selftest.sh` provides today. The shell script stays until the
JSON scenario has a green run on macOS, Windows and Linux CI.

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
  functions. 275 tests, no machine side effects. The CLI only wires execution
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
bun test          # 275 tests, the agnostic core
bun run build     # compile a standalone binary to dist/cuse
```

## Reproducing an issue in someone else's tool

The `rig` workflow installs published tools and drives them where the operating
system takes over. On demand it takes the version, the cell, or a pull request
number - which makes it usable for the question a bug report actually asks.

```sh
gh workflow run rig.yml -f cells=ios -f agent_browser_version=0.32.3
gh workflow run rig.yml -f cells=seam -f agent_browser_pr=1451
```

Each cell asserts with an oracle outside the tool under test: a server that logs
who fetched a page, a certificate the system either trusts or does not, a panel
that is in the accessibility tree or is not. That is the difference between
asking a tool whether it worked and finding out.

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
- Multi-monitor is handled but not gated: every CI runner has one screen. What
  cuse does is report the layout (`screen` lists each display and where the
  frame starts), shift template matches by the frame's origin - the Windows
  virtual screen starts at a negative x with a monitor to the left - and warn
  when a capture does not cover every display. macOS captures one screen per
  file, so `capture --display=2` is how the second one is reached.
- Linux needs `x11-apps` and `xdotool`, and an X display. Both install in about
  seven seconds on a runner; Wayland is not supported.
- The binary name collides with `cuse(1)` from UUCP, which ships with macOS and
  many Linux distributions. Install it under another name or call it by path
  until that is settled.
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

## A real defect, reproduced

Everything else here is gated against a target built for the purpose, which is
the bias this project keeps finding elsewhere. This one is not.

On Windows Server, `notepad` on the PATH is an [App Execution
Alias](https://trainsec.net/library/windows-internals/how-windows-app-execution-aliases-work-and-how-to-read-them-in-c/):
a zero-byte file with reparse tag `0x8000001B` naming a Store package that Server
SKUs do not provision. Starting it succeeds - a process is created, every API
agrees - and no editor window ever appears. What the user gets instead is an app
chooser that holds the keyboard, so anything driving the desktop types into that.

CI reproduces it and asserts each half on its own runner: the alias launch
reports success while no editor window appears, and the [documented
workaround](https://learn.microsoft.com/en-us/answers/questions/2109069/createprocess-on-notepad-exe-fails-due-to-a-crash)
- the classic binary in System32, by full path - lands a keystroke that is read
back off disk.

Chasing it found four bugs in cuse, which is the argument for doing it at all:

- **Named keys were broken on every platform.** `alt+F4` was sent to SendKeys as
  `%F4`, which types the letters f and 4, so an app chooser sat through five
  attempts to close it. Lowercasing a chord is right for letters and wrong for
  everything with a name: System Events needs a key code for Escape, and xdotool
  keysyms are case-sensitive. Every chord CI had sent until then was a letter.
- **A dialog can hold the keyboard without being in the window list.** UI
  Automation does not enumerate that chooser, so `wait --window` never ended
  while `frontmost` reported it plainly. `wait` now consults both, and `windows`
  warns when something it cannot see has focus.
- **`frontmost` reported a document's first line.** The focused element is
  usually a control, and a control's name is its content, so `--expect-front`
  refused to type into the window it had just focused.
- **The workflow was invalid and the local check could not see it.** PyYAML
  accepts duplicate keys; Actions rejects them, producing a run with zero jobs
  and a bare "failure". A strict checker now runs before pushing, and every job
  has a deadline - learning that cost 45 minutes of a hung runner.

## Handing this over

`HANDOFF.md` has what a diff cannot carry: every real bug found and its root
cause, what each runner actually provides, the traps that cost time, and what is
left to do.

## Status

**0.1.0 is the first public release.** The code called itself 2.x for a while -
it is a TypeScript rewrite of the original bash spike, kept as
`bin/cu-legacy.sh` under its original name - but nothing was ever published
under those numbers, and the two files carrying them had drifted apart. A first
release that claims 2.3.0 with no history behind it says the numbers were
invented, which is exactly what happened, so it starts at 0.1.0 instead.

CI runs the unit tests and nine gates on macOS, Linux and Windows; a `rig`
workflow drives published third-party tools where the operating system takes
over; and a `recon` workflow reports what each runner actually provides, which
is where the dependency and Windows decisions above came from. Built by Kai.
