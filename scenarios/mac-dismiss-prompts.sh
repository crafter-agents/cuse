#!/bin/sh
# Dismiss any system prompt sitting in front of the app under test.
#
# macOS 26 raises a Screen Recording approval dialog after enough captures. It
# floats above the frontmost app without becoming the frontmost app, so a focus
# check cannot see it, and it swallows every keystroke that follows. Clicking
# Allow is the difference between a run that measures input and a run that
# measures a dialog.
osascript <<'AS' 2>/dev/null || true
tell application "System Events"
  repeat with p in (every process whose background only is false)
    repeat with w in (every window of p)
      try
        click (first button of w whose name is "Allow")
      end try
      try
        click (first button of w whose name is "Continue")
      end try
    end repeat
  end repeat
end tell
AS
