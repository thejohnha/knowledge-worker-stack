#!/usr/bin/env bash
# Open URL(s) in Chromium without stealing focus.
# Chromium hardcodes [NSApp activateIgnoringOtherApps:YES] on URL/tab open,
# defeating `open -g`. Capture the frontmost app, open in background, then
# re-assert that app frontmost in a short loop to out-race Chromium's async activate.
# OPEN_NO_FOCUS_APP names another Chromium-family app (e.g. "Google Chrome", "Brave Browser").
set -euo pipefail

[ "$#" -ge 1 ] || { echo "usage: $(basename "$0") URL [URL...]" >&2; exit 1; }

app="${OPEN_NO_FOCUS_APP:-Chromium}"
prev_pid=$(osascript -e 'tell application "System Events" to unix id of first process whose frontmost is true')

open -g -a "$app" "$@"

osascript - "$prev_pid" <<'APPLESCRIPT'
on run argv
  set targetPid to (item 1 of argv) as integer
  repeat 8 times
    try
      tell application "System Events" to set frontmost of (first process whose unix id is targetPid) to true
    end try
    delay 0.06
  end repeat
end run
APPLESCRIPT
