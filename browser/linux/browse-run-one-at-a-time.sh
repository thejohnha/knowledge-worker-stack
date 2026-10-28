#!/usr/bin/env bash
# browse-run-one-at-a-time.sh: installed AS /root/agent-browser/browse on the browser box (README.md). The
# entry point for every call: ALWAYS invoke this, never `node browse.js` directly.
# One call at a time: flock serializes concurrent callers. Each session drives its OWN tab (keyed on
# BROWSE_SESSION), so per-call locking is enough; a multi-step flow cannot be clobbered between its steps.
# Hard 240s cap per call: a stuck call would otherwise hold the lock and block every other session. On the cap,
# SIGTERM kills node and releases the lock (exit 124); the `-k 10` SIGKILL is a backstop (exit 137).

# The box's settings. `:=` defers to the caller, so a test can point one elsewhere.
: "${BROWSE_DISPLAY:=:99}"                          # the display Chrome draws on
: "${BROWSE_DOWNLOADS:=/home/browser/Downloads}"    # Chrome's own download folder, where save-page looks
# BROWSE_SESSION names the caller's tab. A Claude Code session on this box gets its own tab from its session
# id; no name at all = a throwaway tab closed after the call.
: "${BROWSE_SESSION:=${CLAUDE_CODE_SESSION_ID:-}}"
# Forced, not deferred: Chrome runs as `browser`, and a pop-up read as root comes back EMPTY with exit 0,
# a false all-clear. The shim reads it as the browser's own user.
BROWSE_ATSPI_PROBE=/root/agent-browser/browse-atspi-as-browser-user.py
export BROWSE_DISPLAY BROWSE_DOWNLOADS BROWSE_SESSION BROWSE_ATSPI_PROBE

flock /run/browse.lock timeout -k 10 240 node /root/agent-browser/browse.js "$@"
rc=$?
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  echo "ERR browse: hard-capped at 240s (exit $rc) — the call was killed and the lock released" >&2
  echo "call timed out — if a tab is frozen by an orphaned native dialog, run: browse dismiss-dialog --probe-only" >&2
fi
exit $rc
