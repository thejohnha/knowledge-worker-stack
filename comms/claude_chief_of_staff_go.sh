#!/usr/bin/env bash
# claude_chief_of_staff_go.sh — a herdr key binding (comms/README.md): go to the chief of staff's tab.
# Found by claude_chief_of_staff_find.py, so the key follows the chief across /successor handovers.
# Live: focus its tab. Stopped: resume the newest one, then focus it — pressing the key is the ask,
# unlike the hourly wake, which never resumes a stopped chief.
# Prints nothing on success. A failure shows a macOS notification and goes to
# ~/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_go.log.

PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
LOG=$HOME/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_go.log
mkdir -p "${LOG%/*}"

fail() {  # <text>: log it, show it as a notification, stop
  echo "$(date '+%F %T') $1" >> "$LOG"
  /usr/bin/osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Chief of staff"' \
    -e 'end run' "$1" >/dev/null 2>&1
  exit 1
}

read -r state uuid _pane tab _rest < <(claude_chief_of_staff_find.py)
case "$state" in
  live) ;;
  stopped)
    out=$(herdr_session_manage.sh resume "$uuid" 2>&1) || fail "Could not resume the chief of staff (${uuid:0:8}): ${out##*$'\n'}"
    pane=$(sed -n 's/^pane=\([^ ]*\).*/\1/p' <<<"$out" | tail -1)
    tab=$(herdr pane list | jq -r --arg p "$pane" '(.result.panes // .result)[] | select(.pane_id==$p) | .tab_id') ;;
  many) fail "$uuid running sessions are titled Chief of staff. Rename or quit all but one, then press the key again." ;;
  *) fail "No chief of staff is running. Start one: open a herdr tab, run claude, then /rename Chief of staff." ;;
esac
herdr_session_manage.sh goto "$tab" >/dev/null 2>&1 || fail "Could not go to the chief of staff's tab ($tab)."
