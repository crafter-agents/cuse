# Handoff

Written for whoever picks this up next. The README says what cuse does; this says
what was learned making it work, which is the part that does not survive in a
diff.

State at handoff: `main` at `f192248`, 234 tests, twelve CI gates green across
macOS, Linux and Windows. Since then: the Linux accessibility route went from a
refusal to a real click, and the test count moved with it.

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
| `src/macos.ts`, `src/macax.ts` | CoreGraphics and the accessibility API through FFI: the only native code |
| `src/apps.ts` | which running process is "TextEdit" |
| `src/preflight.ts`, `src/session.ts` | can this machine do it, and is anyone there |
| `src/png.ts`, `src/xwd.ts`, `src/match.ts` | pixels: decode, encode, locate |
| `src/window.ts`, `src/elements.ts` | what is on screen and what it is called |
| `src/wait.ts`, `src/args.ts` | waiting, and one parser shared with `serve` |
| `scenarios/` | what CI drives; the interesting ones are the repro pair |
| `scenarios/linux-local.sh` | the Linux a11y gate in a container, for iterating off CI |

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

**Finder's accessibility tree was unreadable, not slow.** Every attribute
through System Events is an Apple Event answered on another process's main
thread, so a 300-control window is over a thousand round trips and blew the
deadline. Read through the accessibility API in this process it takes about
350ms. *Lesson: "slow" and "impossible" are the same measurement until someone
puts a number on it.*

**`--role=text` could never select a text field.** `text` is an editable entry
to AT-SPI, whose captions are `label`, and a caption to UI Automation, whose
entries are `Edit`. One table mapped it to `label` for everybody, so the flag
matched the caption above the field and the only selector for filling in a form
was unusable. Role resolution takes the platform now, and a selector is read in
cuse's own vocabulary rather than a toolkit's.
*Lesson: the same word in two vocabularies needs to know which one it is in.*

**A template match was treated as an absolute coordinate.** Windows copies the
whole virtual screen starting at its own origin, which is negative when a
monitor sits left of or above the primary, so a hit 40px into the frame is at
x=-1880 and not x=40. The frame's origin is carried now instead of assumed.
*Lesson: two coordinate spaces that coincide on the developer's machine are
still two spaces.*

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
  tree. Every rectangle used to come back 0,0, and the guess written here - that
  a window manager would fix it - was wrong: openbox moves the dialog to
  485,396 by X's own account and AT-SPI still answers 0,0. `DESKTOP_COORDS` is
  simply not translated by the GTK bridge under Xvfb. `WINDOW_COORDS` is exact,
  so cuse composes: the window's place in X plus the control's place in the
  window. The route is a click now, not a refusal.
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

**A persistent daemon does not exit like a one-shot.** `agent-browser open`
launches a browser and leaves a daemon behind by design, so a wrapper that caps
it and reads the exit code calls a working launch a failure - the log had twelve
orphaned Chrome processes under the word FAIL. Gate on whether the window
exists, which is a question something else can answer.

**Bound everything.** A hang with no `timeout-minutes` cost 45 minutes of a
Windows runner.

**Never drive the developer's own machine.** Verifying input locally typed into a
lock screen's password field once, and later fought a human who was using the
mouse. CI runners are the environment; a laptop is for reading, not for input.

## What is left

**A. Ship it.** Done for GitHub Releases: pushing a `v*` tag builds five
standalone binaries, starts each one on the OS it was built for, and publishes
them with checksums. Nothing is published until a binary has run - the build
machine cannot tell a working cross-compile from a file the target cannot
execute. npm is still open: `bin` points at the TypeScript entry, which needs
Bun installed, so publishing that is a different promise from the binaries.

**Then, roughly in order:**

- ~~**Windows input beyond a self-made target.**~~ Done: `windows-third-party`
  drives Character Map, which Microsoft ships and this repo did not write. The
  clipboard is seeded with a sentinel and required to change, so the gate cannot
  pass on a button that resolved and never fired. It reads `button 'Select'` and
  `button 'Copy'` out of a `#32770` dialog and the clipboard comes back `!!`.
  Recon first: charmap, mspaint, regedit and osk are on the runner; `write` and
  `wordpad` are gone.
- **`elements` on macOS reads the tree directly now** (`src/macax.ts`), because
  slow-ish turned out to be too generous: Finder did not answer at all, it hit
  cuse's deadline and came back as a timeout. Through the C API it is 300
  controls in about a third of a second. Two things to know: CoreFoundation
  handles must be `u64` in bun:ffi, since a tagged pointer through the `ptr`
  type segfaults on the first string; and accessibility trust is per process,
  so a machine can refuse cuse while System Events works - the AppleScript
  route is kept for exactly that and nothing else.
- **Multiple monitors** are handled but unproven: no runner has two screens, so
  the layout maths is unit-tested and nothing more. Worth checking by hand on a
  real second monitor, especially the macOS flip (NSScreen measures up from the
  bottom-left of the main screen, clicks measure down from its top-left) and the
  Windows virtual-screen origin, which is negative with a monitor to the left.
- **Wayland** is unsupported and will stay so until someone needs it.
- **`record --video` records for real** where the platform can: `screencapture
  -v` on macOS, ffmpeg's x11grab on Linux (verified: a 2.000s mp4 by ffprobe).
  Windows refuses and says why - nothing ships with it that records a screen
  from a command line, and pulling in a recorder is a bigger promise than this
  tool makes. Not gated in CI: recording on the macOS runner would summon the
  Screen Recording prompt the input job is careful to avoid, and installing
  ffmpeg on the Linux job costs more than the check is worth.

## How to work on it

```sh
bun test                                        # 275, all pure
python3 scenarios/check-workflows.py .github/workflows/*.yml
bun run build && ./dist/cuse --help
```

Branch, push, watch the run, read the artifacts - every job uploads its frames.
The evidence is in the logs and the PNGs, not in the exit code; that habit is what
found most of the above. When a gate goes green, ask what would have to break for
it to go red, and check that it actually would.
