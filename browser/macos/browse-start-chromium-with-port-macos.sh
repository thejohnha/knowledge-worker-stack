#!/usr/bin/env bash
# browse-start-chromium-with-port-macos.sh: start this Mac's own Chromium, on its normal profile, with the
# remote-control port browse drives (README.md). Run at login by the LaunchAgent local.agent-browser.chromium-port;
# installed to ~/agent-browser/.
# Idempotent: exits 0 when the port already answers. Chromium already running WITHOUT the port is left alone,
# because restarting it would close the owner's windows.
# No front-app restore here: from launchd that needs a System Events automation grant, i.e. a pop-up.
set -u
PORT=9222
up() { /usr/bin/curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/json/version"; }
up && exit 0
# Running = the normal profile's SingletonLock ("host-pid") names a live pid. Not `pgrep Chromium`: a headless
# throwaway Chromium would keep the owner's from ever starting.
pid=$(/usr/bin/readlink "$HOME/Library/Application Support/Chromium/SingletonLock" 2>/dev/null | /usr/bin/sed 's/.*-//')
if [ -n "$pid" ] && /bin/kill -0 "$pid" 2>/dev/null; then
  echo "Chromium is running without the remote-control port; browse cannot reach it until Chromium is quit and this script runs again" >&2
  exit 1
fi
# -n: without it, LaunchServices hands the request to ANY running Chromium (a headless throwaway included) and
# nothing new starts. Safe, because the owner's own profile was proven idle above.
/usr/bin/open -n -g -a Chromium --args --remote-debugging-port="$PORT" --remote-debugging-address=127.0.0.1
for _ in $(seq 1 60); do up && exit 0; sleep 0.5; done
echo "Chromium started but port $PORT did not answer within 30s" >&2
exit 1
