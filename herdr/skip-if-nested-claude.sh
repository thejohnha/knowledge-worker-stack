#!/usr/bin/env bash
# skip-if-nested-claude.sh <command...> — run <command> with this hook's stdin, UNLESS the claude
# that fired the hook was itself started by another claude.
#
# Why: a claude started inside a session (a `claude -p` from a Bash call, a Claude Code daemon spare)
# inherits the parent's HERDR_PANE_ID and HERDR_TAB_ID. Its SessionStart hooks then report ITS session
# id as the pane's, and herdr keeps the latest report, so the pane, the tab store and the session grid
# all name a throwaway run instead of the session you are looking at. Wrapping the pane-reporting
# hooks here keeps the pane's id with the outermost claude.
#
# Nested = two or more processes named `claude` in the ancestry of this script, one ps call. Where
# ps cannot name claude nothing counts as nested, so the wrapped hook runs as before. Fail-open: any
# error runs the command.
[ $# -gt 0 ] || exit 0
n=$(ps -axo pid=,ppid=,comm= 2>/dev/null | awk -v me="$$" '
  { par[$1] = $2; c = $3; sub(/.*\//, "", c); name[$1] = c }
  END { p = me; k = 0; hops = 0
        while (p > 1 && (p in par) && hops++ < 64) { if (name[p] == "claude") k++; p = par[p] }
        print k }') || n=0
[ "${n:-0}" -ge 2 ] && exit 0
exec "$@"
