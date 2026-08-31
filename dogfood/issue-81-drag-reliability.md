# Issue 81 Windows drag reliability

On 2026-08-31, GitHub Actions ran `./cuse run
scenarios/windows-drag-repeat.json --repeat=100 --json` against a live classic
Notepad window on a GitHub-hosted `windows-latest` runner. The scenario launched
a fresh process for every iteration, captured its window position, dragged its
title bar, captured the position again, and required an externally observed
position delta of at least 50 pixels.

The measured result was 100 passes out of 100 runs, with 0 failures. The
aggregate duration was 355211 ms, or 3552.11 ms per run on average. Every step
and cleanup record reported `"passed":100,"failed":0,"passRate":1,"flakeRate":0`
with one attempt per iteration.

The literal pass-count fields in the JSON summary line were:

```json
"runs":100,"passed":100,"failed":0
```

The source log and retained `windows-drag-reliability` artifact are attached to
[GitHub Actions run 33350295309](https://github.com/crafter-agents/cuse/actions/runs/33350295309).
The artifact contains the complete JSON aggregate and the Notepad target file.

Bullets 5 and 6 of issue #81, removing `crafter-station/petdex`'s workflow-level
drag retry and keeping its single-attempt gate green on main, are out of scope
for this repo and are Railly's to do in `crafter-station/petdex`.
