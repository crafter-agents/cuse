# Real-app compatibility matrix

This matrix records repeated observations from real external applications on
GitHub-hosted runners. A row describes only the capabilities exercised by its
fixture.

| OS | External target | Scenario | Runner | Measured | Not measured | Repeats | Observed result | CI run |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| macOS | Electron | `assert real Electron runtime and geometry evidence` (`scenarios/electron-probe.json`) | `macos-latest`, GitHub-hosted | Process launch, Electron version assertion, Chromium version assertion, device pixel ratio (DPR), scroll geometry, and window ownership | Capture, focus, typing, click, drag, and window lookup | 20 | `"runs":20,"passed":20,"failed":0`; all seven emitted step records report `"passRate":1,"flakeRate":0` | [run 33338721787](https://github.com/crafter-agents/cuse/actions/runs/33338721787) |
| macOS | macOS `osascript` dialog (native AppleScript UI, not Electron) | Dialog click and live-value checks (`scenarios/mac-element-assert.json`) | `macos-latest`, GitHub-hosted | Element wait, accessibility tree read, semantic click by accessible name and role, coordinate click resolved from the same element tree, and live-value assertion proven to discriminate via its negative counterpart | Capture, focus, typing, drag, window lookup, latency, and flake rate | 1 | Passed once: the named Allow button was pressed, a bare coordinate click pressed the same control, the positive assertion passed, and the negative assertion failed as expected. Flake rate has not yet been measured. | [run 33343732467](https://github.com/crafter-agents/cuse/actions/runs/33343732467) |
| Windows | Classic Notepad (`C:\Windows\System32\notepad.exe`), launched by full path | Documented workaround (`scenarios/verify-workaround.sh`) | `windows-latest`, GitHub-hosted | Window wait, window enumeration, interpolated drag with observed position delta, elements/accessibility read, focus, typing, live-value assertion proven to discriminate via its negative counterpart, and file-based save verification | Capture, click, latency, and flake rate | 1 | Passed once: the live window moved, the positive assertion passed, the negative assertion failed as expected, and the saved file contained the typed text. Flake rate has not yet been measured. | [run 33341329405](https://github.com/crafter-agents/cuse/actions/runs/33341329405) |
| Linux | GTK `zenity` dialog via AT-SPI | Linux accessibility flow (`scenarios/linux-atspi.sh`) | `ubuntu-latest`, GitHub-hosted | Window wait and enumeration, AT-SPI accessibility tree read cross-checked against X window geometry, focus, semantic clicks by accessible name and role, typing, live-value assertion proven to discriminate via its negative counterpart, file-based button-press verification, and window-gone wait | Capture, drag, latency, and flake rate | 1 | Passed once: the off-origin dialog geometry composed correctly, the positive assertion passed, the negative assertion failed as expected, zenity wrote the typed sentinel after the named OK button was pressed, and the closed window was observed as gone. Flake rate has not yet been measured. | [run 33342410623](https://github.com/crafter-agents/cuse/actions/runs/33342410623) |
| Linux | GTK `gnome-calculator` via AT-SPI | Linux calculator flow (`scenarios/linux-calc.sh`) | `ubuntu-latest`, GitHub-hosted | Window wait, AT-SPI accessibility tree read, focus, semantic clicks on digit and operator buttons by accessible name and role, and focused-display live-value assertion proven to discriminate via its negative counterpart | Capture, typing, drag, latency, and flake rate | 1 | Passed once: named buttons computed 5 + 3, the focused accessible display reported `8`, the positive assertion passed, and the negative assertion failed with expected `9` versus observed `8`. Flake rate has not yet been measured. | [run 33345819117](https://github.com/crafter-agents/cuse/actions/runs/33345819117) |

The structured artifact emitted the following aggregate fields literally:

```json
{"status":"passed","name":"assert real Electron runtime and geometry evidence","platform":"macos","durationMs":10078,"runs":20,"passed":20,"failed":0}
```

Flake rate is emitted per step, not as a scenario-level field. Step indices 0
through 6 each emitted `"passed":20,"failed":0,"passRate":1,"flakeRate":0`.
The artifact does not emit per-run latency, so this matrix makes no latency
claim.
