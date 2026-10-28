#!/usr/bin/env bash
# Exits a live Claude Code session and CLOSES its herdr tab — "exit this session" / "close this tab".
#
#   claude_exit_session.sh [<uuid>]
#
# No uuid means THIS session ($CLAUDE_CODE_SESSION_ID) — the normal case: the session runs it on
# itself, replies, goes idle, and is gone a few seconds later. `cr <uuid>` brings it back (the log
# names the uuid), and the grid, if installed, keeps it as a parked cell.
#
# One engine, not two: this is claude_successor_retire_predecessor.sh (knowledge-worker-stack claude-code/)
# pointed at the session's own pane with no title to set — detach, two consecutive idle reads, quit
# (refused on an unsent draft), wait for the process to be gone, close the tab. It detaches because
# the calling session is still working when it runs, and a quit typed into a working session would
# only interrupt its turn. Allow rule: Bash(claude_exit_session.sh:*).

u=${1:-${CLAUDE_CODE_SESSION_ID:-}}
[[ "$u" =~ ^[0-9a-f-]{36}$ ]] || { echo "need a full session uuid (none given and \$CLAUDE_CODE_SESSION_ID is empty)" >&2; exit 2; }
command -v claude_successor_retire_predecessor.sh >/dev/null \
  || { echo "claude_successor_retire_predecessor.sh is not on PATH — install the successor tools from knowledge-worker-stack claude-code/" >&2; exit 2; }
claude_session_transcript.sh "$u" >/dev/null || exit 2

pane=$(herdr agent list 2>/dev/null | jq -r --arg u "$u" '.result.agents[]|select(.agent_session.value==$u)|.pane_id' | head -1)
[[ -n "$pane" ]] || { echo "session $u is not live in any herdr pane — nothing to exit" >&2; exit 1; }

out=$(claude_successor_retire_predecessor.sh "$u" "$pane" '') || { echo "$out" >&2; exit 1; }
echo "exit armed for $u in $pane -> ${out##*-> }"
