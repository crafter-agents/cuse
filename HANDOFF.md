# Handoff

Written for whoever picks this up next. The README says what cuse does; this says
what was learned making it work, which is the part that does not survive in a
diff.

State at handoff: `main` at `f192248`, 234 tests, twelve CI gates green across
macOS, Linux and Windows.

## The one idea

Every interesting bug in this project was a case where something reported success
and nothing had happened. Not a crash, not an error code - a confident `ok` over
an empty screen, a keystroke delivered to no window, a coordinate computed from a
tree that did not know where anything was.

That is the failure mode a computer-use tool has to be built against, and it is
also the failure mode of the *tests* for such a tool. Two of the CI gates here
passed green while measuring nothing, and were only caught by looking at the
pixels. Assume the same about anything you add.

## Where things are

| file | what it holds |
| --- | --- |
| `src/cli.ts` | the verbs, the only place with side effects |
| `src/exec.ts` | running other people's programs under a deadline |
| `src/commands.ts`, `src/os.ts`, `src/keys.ts` | per-OS argv and chords |
| `src/plan.ts` | input actions, including the macOS ones that are not argv |
| `src/macos.ts` | CoreGraphics through FFI: the only native code |
| `src/preflight.ts`, `src/session.ts` | can this machine do it, and is anyone there |
| `src/png.ts`, `src/xwd.ts`, `src/match.ts` | pixels: decode, encode, locate |
| `src/window.ts`, `src/elements.ts` | what is on screen and what it is called |
| `src/wait.ts`, `src/args.ts` | waiting, and one parser shared with `serve` |
| `scenarios/` | what CI drives; the interesting ones are the repro pair |

Everything except `cli.ts` and `macos.ts` is pure and unit-tested. Keep it that
way: it is why the argv for three platforms can be asserted from one laptop.

## Findings worth keeping

### In cuse itself

**macOS mouse never existed.** `set the position of the mouse` is not a System
Events command; it failed with -2753 on every call. The unit tests passed because
they asserted the argv, not that the argv works. Now CoreGraphics through FFI.
*Lesson: a test that asserts a command string proves the string, nothing else.*

**A locked Mac accepts synthetic keystrokes** and routes them to the login
window's password field. Found by locking the machine mid-session and typing into
it. Input actions check the session first; when unlocked the key is absent
entirely rather than false, so "unknown" must never block.

**A blank frame is not detectable by size.** A black 3024x1964 macOS capture
compressed to 112 KB, well above any byte-per-pixel threshold. Only decoding and
checking pixel uniformity caught it.

**Named keys were broken on all three platforms.** `alt+F4` reached SendKeys as
`%F4`, which types the letters f and 4. Lowercasing a chord is right for letters
and wrong for everything with a name: System Events needs a key code for Escape,
xdotool keysyms are case-sensitive. Never exercised because every chord in CI was
a letter.

**A dialog can hold the keyboard without being in the window list.** UI Automation
does not enumerate Windows' "Select an app" chooser; `frontmost` sees it, the
window list does not. `wait` consults both now.

**`frontmost` reported a document's first line.** The focused element is usually a
control and a control's name is its content.

**Killing a hung child is not enough.** A wrapper whose own child holds the stdout
pipe keeps the read alive, so the deadline achieves nothing. `exec.ts` returns the
moment the deadline passes and kills the descendant tree, bounded.

**A template with no structure cannot be located.** A patch of blank text box was
found 65px from where it was cut, with a perfect score, because the score was a
mean pixel distance and every blank patch matches every other. Correlation plus a
variance floor.

**A pyramid step that is too big loses the answer.** Shrunk by 8, a 160x50 patch
becomes 20x6 and the correct position ranks 350th. Levels now need a usable
smallest side and enough pixels overall.

### About the runners

Gathered by the `recon` workflow; re-run it rather than trusting this.

- **Linux**: Xvfb is preinstalled; `xdotool`, `imagemagick` and `xwd` are not.
  `x11-apps` + `xdotool` install in about 7 seconds. No window manager, which is
  why `focus` must not depend on `_NET_ACTIVE_WINDOW`.
- **Linux accessibility**: AT-SPI can be brought up by hand (bus launcher,
  registry daemon, `toolkit-accessibility`) and a GTK app then exports a real
  tree - but every rectangle comes back 0,0, because nothing tells the toolkit
  where its window is. The tree is readable and unaimable. cuse refuses to aim by
  it; the day a runner reports real coordinates, `linux-accessibility` goes red on
  purpose.
- **macOS**: CoreGraphics event posting works with no permission prompt.
  `screencapture` works. But **macOS 26 raises a Screen Recording prompt after a
  few captures**, it floats above the frontmost app *without becoming it* - so
  `--expect-front` cannot see it - and it swallows every keystroke. The macOS
  input job types before taking any screenshot for exactly this reason.
- **Windows**: the job runs in the interactive session (session 2, real
  foreground window). Notepad is the Store build and does not start. WinForms
  reports every control as `Pane` to UI Automation; the Win32 class underneath is
  the real answer. The first click on an inactive window activates it and goes no
  further, so clicking a button takes two clicks.

### About testing this kind of thing

**A gate that can pass without the thing it tests is worse than none.** The input
check passed twice on a blinking text caret while no keystroke was landing, and
failed twice on a window still drawing while input was landing fine. It now gates
on ground truth - a file on disk, a command executed, a form that records its own
press - and reports the pixel delta as evidence only.

**Do not test a matcher against a live desktop.** The same commit gave 0px and
91px on consecutive runs, because between cutting a landmark and looking for it a
caret blinks or a dialog opens. Cut and search within one fixed frame.

**Synthetic screens are harder to get right than they look.** Two fixtures failed
to reproduce a real misalignment bug: one was periodic, so the patch genuinely
occurred in many places, the other so smooth that positions two pixels apart were
indistinguishable. Both would have asserted an arbitrary answer. The committed
fixture is a real runner frame (`test/fixtures/`), 147 KB, and pins the exact
offset.

**PyYAML is more permissive than Actions.** Duplicate keys are fine by PyYAML and
fatal to GitHub, which reports a run with zero jobs and a bare "failure" that says
nothing. Run `scenarios/check-workflows.py` before pushing; it is strict about
duplicates and also fails a job with no deadline.

**Bound everything.** A hang with no `timeout-minutes` cost 45 minutes of a
Windows runner.

**Never drive the developer's own machine.** Verifying input locally typed into a
lock screen's password field once, and later fought a human who was using the
mouse. CI runners are the environment; a laptop is for reading, not for input.

## What is left

**A. Ship it.** No releases, no npm, no binaries. `bun build --compile --target`
produces standalone executables per platform; a workflow that attaches them to a
tag is the single highest-return thing left. Today the only way to try cuse is to
clone and build, which excludes almost everyone.

**Then, roughly in order:**

- **Windows input beyond a self-made target.** Every Windows input proof uses a
  WinForms window this repo creates. A real third-party app would be better
  evidence.
- **`elements` on macOS is slow-ish** (1.3s for 56 controls) because every
  attribute is an Apple Event. Bulk queries already helped; a native AX binding
  through FFI would help more.
- **Multiple monitors** are not handled anywhere: `screen` reports one frame and
  one scale.
- **Wayland** is unsupported and will stay so until someone needs it.
- **`record` is stills, not video.** For a bug that only appears mid-animation, an
  actual capture would be better.
- **The Linux accessibility route** is one window manager away from working. Try
  starting a tiny WM (openbox) in that job and see whether the geometry becomes
  real; if it does, promote the gate from a refusal to a click.

## How to work on it

```sh
bun test                                        # 234, all pure
python3 scenarios/check-workflows.py .github/workflows/*.yml
bun run build && ./dist/cuse --help
```

Branch, push, watch the run, read the artifacts - every job uploads its frames.
The evidence is in the logs and the PNGs, not in the exit code; that habit is what
found most of the above. When a gate goes green, ask what would have to break for
it to go red, and check that it actually would.
