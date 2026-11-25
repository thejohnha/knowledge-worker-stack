#!/usr/bin/env bash
# browse-start-chromium-with-port-macos.sh: start this Mac's own Chromium, on its normal profile, with the
# remote-control port browse drives (README.md). Run at login by the LaunchAgent local.agent-browser.chromium-port;
# installed to ~/agent-browser/.
# Idempotent: exits 0 when the port already answers.
# Chromium already running WITHOUT the port:
# - under REOPEN_WINDOW_S old (5 min): macOS "Reopen windows when logging back in" started it at this login,
#   before this script ran. Quit it cleanly (SIGTERM: Chromium saves its session) and start it again with the
#   port and --restore-last-session, which brings back exactly the windows the reopen did. Without that flag
#   the default "On startup" setting opens a bare New Tab and the windows are lost.
# - older: the owner has been using it, so it is left alone and browse falls back by its own rules.
# No front-app restore here: from launchd that needs a System Events automation grant, i.e. a pop-up.
# BROWSE_TEST_CHROMIUM_PROFILE and BROWSE_TEST_PORT point it at a throwaway profile for testing; leave them unset.
set -u
PORT=${BROWSE_TEST_PORT:-9222}
REOPEN_WINDOW_S=${REOPEN_WINDOW_S:-300}
PROFILE=${BROWSE_TEST_CHROMIUM_PROFILE:-"$HOME/Library/Application Support/Chromium"}
ARGS=(--remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1)
[ -n "${BROWSE_TEST_CHROMIUM_PROFILE:-}" ] && ARGS+=(--user-data-dir="$PROFILE")
up() { /usr/bin/curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/json/version"; }
up && exit 0
# Running = the profile's SingletonLock ("host-pid") names a live pid. Not `pgrep Chromium`: a headless
# throwaway Chromium would keep the owner's from ever starting.
pid=$(/usr/bin/readlink "$PROFILE/SingletonLock" 2>/dev/null | /usr/bin/sed 's/.*-//')
if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
  started=$(LC_ALL=C /bin/date -j -f '%a %b %d %T %Y' "$(LC_ALL=C /bin/ps -o lstart= -p "$pid")" +%s 2>/dev/null)
  age=$(( $(/bin/date +%s) - ${started:-0} ))
  if [ -z "$started" ] || [ "$age" -gt "$REOPEN_WINDOW_S" ]; then
    echo "Chromium is running without the remote-control port (up ${age}s); browse cannot reach it until Chromium is quit and this script runs again" >&2
    exit 1
  fi
  echo "$(/bin/date '+%F %T') Chromium up ${age}s without the port (reopened at login): restarting it with the port, windows restored" >&2
  /bin/kill -TERM "$pid"
  for _ in $(seq 1 60); do /bin/kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  if /bin/kill -0 "$pid" 2>/dev/null; then echo "Chromium did not quit within 30s of SIGTERM; left running" >&2; exit 1; fi
  ARGS+=(--restore-last-session)
fi
# -n: without it, LaunchServices hands the request to ANY running Chromium (a headless throwaway included) and
# nothing new starts. Safe, because the owner's own profile was proven idle above.
/usr/bin/open -n -g -a Chromium --args "${ARGS[@]}"
for _ in $(seq 1 60); do up && exit 0; sleep 0.5; done
echo "Chromium started but port $PORT did not answer within 30s" >&2
exit 1
