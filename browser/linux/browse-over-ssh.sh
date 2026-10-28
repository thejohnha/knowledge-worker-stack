#!/usr/bin/env bash
# browse-over-ssh.sh: run `browse` on the browser box from another computer. Install it on your PATH as
# `browse`. The box is an ssh host name that logs in as root: AGENT_BROWSER_BOX, default `agent-browser`.
# Passes this caller's tab name along: an exported BROWSE_SESSION wins, else the Claude Code session id, so
# every Claude Code session gets its own tab; neither = a throwaway tab closed after the call.
# %q-quotes every argument so run-js code and selectors survive the ssh hop (the box's root shell must be bash).
set -euo pipefail
box=${AGENT_BROWSER_BOX:-agent-browser}
cmd="BROWSE_SESSION=$(printf '%q' "${BROWSE_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}") /root/agent-browser/browse"
for a in "$@"; do cmd+=" $(printf '%q' "$a")"; done
exec ssh "$box" "$cmd"
