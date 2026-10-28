#!/usr/bin/env bash
# browse — the remote entry point to the Windows agent-browser, for agents running on another machine
# (macOS or Linux; needs ssh and python3). Install it there as `browse` somewhere on PATH; it is the only
# file that machine needs.
#
# WHY IT EXISTS: it threads the calling AI session's id through as BROWSE_SESSION, which is what gives
# each concurrent session its OWN tab in the one shared browser. Without it every agent would drive the
# same tab and they would fight. No session id (a plain shell) gets an ephemeral throwaway tab, never
# another session's.
#
# WHY IT LIVES ON PATH RATHER THAN IN .bashrc: non-interactive agent shells skip .bashrc at the `$PS1`
# guard, so a shell function would be invisible to exactly the callers this exists for.
#
# AN ALREADY-EXPORTED BROWSE_SESSION WINS over the session id. That is how a long-lived TOOL, as opposed
# to a chat session, claims a stable named tab that survives across its own calls.
#
# QUOTING: the argument vector crosses bash -> ssh -> Windows PowerShell, three shells with three
# different quoting rules, and selectors and JS snippets are full of quotes. So the vector travels as
# ONE base64 JSON array and is decoded on the far side. Nothing in an argument can be interpreted by
# anything in between, which is the only way this survives contact with a CSS selector.
set -euo pipefail

: "${BROWSE_WINDOWS_HOST:=agent-browser-windows}"   # the box: an ssh config Host entry (see README.md), not a bare address
: "${BROWSE_WINDOWS_HOME:=C:\\agent-browser}"

sid="${BROWSE_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"

argv_b64=$(python3 -c 'import base64,json,sys; sys.stdout.write(base64.b64encode(json.dumps(sys.argv[1:]).encode()).decode())' "$@")
sid_b64=$(printf '%s' "$sid" | base64 | tr -d '\n')

exec ssh "$BROWSE_WINDOWS_HOST" \
  "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"\$s='$sid_b64'; \$a='$argv_b64'; \
   \$env:BROWSE_SESSION=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\$s)); \
   \$argv=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\$a)) | ConvertFrom-Json; \
   & '$BROWSE_WINDOWS_HOME\\browse.ps1' @argv; exit \$LASTEXITCODE\""
