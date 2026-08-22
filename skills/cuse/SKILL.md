---
name: cuse
description: Cross-platform computer-use CLI for AI agents. Use when an agent needs to drive the desktop rather than a browser, on macOS, Linux or Windows, the same commands on all three. Triggers include "click that button", "type into the app", "take a screenshot of the screen", "what windows are open", "wait until the dialog appears", "find this image on screen", "automate this desktop app", "drag from here to there", or any task that needs the real desktop instead of a web page. Also use when a browser tool cannot reach the target: native dialogs, file pickers, menu bars, the login window, or an app with no web surface. Not for web pages inside a browser, where agent-browser is the better tool.
allowed-tools: Bash(cuse:*), Bash(./dist/cuse:*)
---

# cuse

One verb, the right OS primitive underneath: `osascript` and CoreGraphics on
macOS, `xdotool` and `xwd` on Linux, SendKeys and user32 on Windows. Every
command answers JSON with `--json`, so nothing has to be parsed out of prose.

Install: `bun add --global cuse`, or build from source with
`bun build --compile src/cli.ts --outfile dist/cuse`.

## The one thing to know first

**Every command can fail, and cuse tells you why rather than guessing.** A
locked session refuses input instead of typing into the login window. A blank
frame is reported as blank instead of returned as a screenshot. Read the
`error` field before assuming an action landed.

```console
$ cuse type "hello" --json
{"ok":false,"error":"the session is locked: input would go to the login window,
 not to your app (unlock the machine, or pass --force if you really mean it)"}
```

## Commands

**Screen**

| | |
|---|---|
| `capture [out.png]` | screenshot; warns when the frame is blank |
| `record [n] [gapMs]` | n captures in a row |
| `record <seconds> --video` | actual video, where the OS can (not Windows) |
| `settle [tries] [gapMs] [n]` | wait until the screen stops changing |
| `diff <a.png> <b.png>` | how much changed: SAME or CHANGED |
| `screen` | frame size, point size, scale, and every display |

**Windows and apps**

| | |
|---|---|
| `launch <app>` | start an app |
| `focus <name>` | bring a window to the front |
| `windows` | list visible windows with their rectangles |
| `frontmost` | which window has the keyboard |
| `wait [gapMs]` | until `--element` / `--window` shows up, or `--gone` |
| `elements [app]` | controls in the accessibility tree: role, name, rect |

**Finding things**

| | |
|---|---|
| `find <template.png> [in.png]` | where that picture is, on screen or in a frame |
| `crop <in.png> x y w h <out>` | cut a template out of a screenshot |

**Input**

| | |
|---|---|
| `type <text>` | send text to the focused window |
| `key <chord>` | `cmd+s`, `ctrl+shift+a`, `Return` |
| `move <x> <y>` | move the cursor |
| `click \| dblclick [x] [y]` | click, or aim with `--window` / `--find` |
| `drag <x1> <y1> <x2> <y2>` | hold the button between two points |
| `scroll <up\|down> [amount]` | scroll the view under the cursor |
| `select-all \| copy \| paste` | the platform's own chord for each |

**Batching**

| | |
|---|---|
| `run '<json>'` | several actions in one process, in order |
| `serve` | one command per line, one JSON per line, state kept |

## Aim without coordinates

Pixel coordinates break on the next window move. Prefer naming the thing:

```bash
cuse click --element="Save"        # by accessibility name
cuse click --window="Untitled"     # centre of a window
cuse click --find=button.png       # by template image
```

`cuse elements` lists what is nameable. When nothing is, fall back to
coordinates and expect them to be brittle.

## Batching: run or serve

Both exist and they are not the same tool.

**`run`** takes a list, runs it in one process, and exits. Each action is
independent. Use it for a short fixed sequence:

```bash
cuse run '[["move",100,100],["click"],["type","hello"]]'
```

It stops at the first failure and reports how many landed, so an agent that
clicked once and then missed can tell:

```json
{"ok": false, "error": "step 2 (click) failed: ...",
 "data": {"completed": 1, "total": 3}}
```

**`serve`** keeps a process open, reads one command per line, and **remembers
state between them**, so `use --app=TextEdit` applies to everything after:

```console
$ cuse serve
use --app=TextEdit
{"ok":true,"action":"use",...}
click --element=Save
{"ok":true,"action":"click",...}
```

Twenty actions cost 298 ms as separate processes and 21 ms through `serve`.
A failing line comes back as a failed Result and the loop continues, because an
agent recovers from a missing button and killing its tool over one is not help.

**Pick `serve`** for a session of many actions, or when later actions depend on
an app selected earlier. **Pick `run`** for a handful of independent actions
where a long-lived process is more machinery than the task needs.

## Wait for the thing, not for a duration

`sleep 2` is a guess that is either too short or wasted. cuse waits on the
condition:

```bash
cuse wait --element="Save"      # until it appears
cuse wait --window="Export" --gone
cuse settle                     # until the screen stops changing
```

`settle` starts checking at 60 ms and only backs off while frames keep coming
back CHANGED, capped at 500 ms. A quiet screen answers in about a second
instead of always paying the full interval.

## What works where

Not everything exists on every platform, and cuse says so rather than
pretending. `record --video` has no Windows path. The accessibility tree is
richest on macOS, present on Linux through AT-SPI, and thinner on Windows.
Run `cuse os` to know which platform you are on, and read the `error` when a
verb is unsupported there.

Headless Linux has no X server: run cuse under `xvfb-run -a --server-args=
"-screen 0 1280x1024x24"` and install `xvfb x11-apps xdotool` first.

## Nothing waits forever

Every backend cuse shells out to can hang: `osascript` waiting on an app that
stopped answering, `xdotool` on a wedged X server. Every action carries a
deadline and reports a timeout rather than blocking an agent that has no
timeout of its own.

## When not to use cuse

Use **agent-browser** for web pages inside a browser: it has the DOM,
accessibility snapshots with element refs, and network control that a desktop
tool cannot offer. cuse is for the desktop around the browser, or for apps with
no web surface at all.
