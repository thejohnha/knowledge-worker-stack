#!/bin/bash
# browse-run-one-at-a-time-macos.sh: installed AS ~/agent-browser/browse on a Mac whose own Chromium the agent
# drives (README.md). One call at a time, each capped at 240s, exit 124 on the cap. macOS has no flock or
# timeout, so /usr/bin/lockf takes the lock and perl makes the cap; both ship with macOS. Perl FORKS the call
# and kills it on the alarm: an alarm that killed perl itself would make lockf exit 70, hiding the cap.
# Paths DEFER to the caller (:=), so a test can point them elsewhere; they default under the toolset folder,
# never ~/Downloads.
set -u
H="$HOME/agent-browser"
: "${BROWSE_DOWNLOADS:=$H/Downloads}"
: "${BROWSE_SESSION_MAP:=$H/state/browse-sessions.json}"
: "${BROWSE_REF_MAP:=$H/state/browse-refs.json}"
: "${BROWSE_RESTORE_DIR:=$H/state}"
# restart-browser would quit the owner's Chromium with every window open: never on a Mac.
: "${BROWSE_RESTART_CMD:=echo 'restart-browser is off on a Mac: it would quit the owner'\''s own Chromium' >&2; exit 1}"
# BROWSE_SESSION names this caller's tab. A Claude Code session gets its own tab from its session id;
# no name at all = a throwaway tab closed after the call.
BROWSE_SESSION=${BROWSE_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}
export BROWSE_DOWNLOADS BROWSE_SESSION_MAP BROWSE_REF_MAP BROWSE_RESTORE_DIR BROWSE_RESTART_CMD BROWSE_SESSION
mkdir -p "$BROWSE_DOWNLOADS" "$H/state"
/usr/bin/lockf -k "$H/state/browse.lock" /usr/bin/perl -e '$SIG{ALRM}=sub{kill "KILL",$p; exit 124}; alarm 240; defined($p=fork) or die; if(!$p){exec @ARGV or die} waitpid $p,0; exit($?&127 ? 128+($?&127) : $?>>8)' "$H/node" "$H/browse.js" "$@"
rc=$?
if [ "$rc" -eq 124 ]; then
  echo "ERR browse: hard-capped at 240s (exit $rc) — the call was killed and the lock released" >&2
  echo "call timed out — if a tab is frozen by an orphaned native dialog, run: browse dismiss-dialog --probe-only" >&2
fi
exit $rc
