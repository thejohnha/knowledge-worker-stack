#!/bin/sh
# keep_awake_watchdog.sh: while zz is on, puts the sleep block back if something turned it off.
# Run by LaunchAgent local.knowledge-worker-stack.keep-awake-watchdog at login, every 60 s, and whenever
# the power settings file changes. `pmset disablesleep` does not survive a restart, and other apps that
# write the same flag can leave it off; only this puts it back.
# Uses `sudo -n` only: it never asks for a password. Without the sudo rule it logs one line and waits.
# Prints only when it does something; launchd appends that to the log.
M="$HOME/.config/knowledge-worker-stack/keep-awake"
[ -e "$M" ] || exit 0                                                   # zz is off: nothing to do
[ "$(pmset -g | awk '/SleepDisabled/{print $2}')" = 1 ] && exit 0      # already blocked
if sudo -n /usr/bin/pmset -a disablesleep 1 2>/dev/null; then
  echo "$(date '+%F %T') sleep was allowed while zz was on; blocked it again"
  [ -s "$M" ] && : > "$M"
elif [ ! -s "$M" ]; then   # say it once, not every minute: the note in the marker means "already said"
  echo "$(date '+%F %T') sleep is allowed while zz is on, and without the sudo rule (keep-awake/README.md step 2) this cannot block it again; run zz"
  echo "no sudo rule; logged" > "$M"
fi
exit 0
