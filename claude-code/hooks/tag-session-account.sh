#!/usr/bin/env bash
# SessionStart hook — record a session's ACCOUNT the moment it starts (or resumes) under a non-default
# account, so every later resume (cr, herdr_session_manage.sh, the restart scripts) bills that subscription.
#
# Accounts come from ~/.config/knowledge-worker-stack/accounts.json ({"default": "~/.claude", "<name>": "<dir>"}). No file,
# or only a default row, and this hook does nothing. The session's account is the row whose dir is the config dir
# its transcript lives under: transcript_path is <config dir>/projects/<folder>/<uuid>.jsonl, so it reflects
# CLAUDE_CONFIG_DIR. CLAUDE_CONFIG_DIR in the hook's environment counts only when no transcript_path was supplied.
#
# It writes a SIDECAR (~/.claude/state/state_claude_session_accounts.json -> {uuid: "<account>"}), NEVER the .jsonl
# transcript: Claude Code owns the live transcript and a concurrent append can corrupt it. A default-account session
# is the absent case. Idempotent; mkdir-locked so concurrent SessionStarts can't clobber the store.
set -euo pipefail

accounts="$HOME/.config/knowledge-worker-stack/accounts.json"
[ -s "$accounts" ] || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input")
tp=$(jq -r '.transcript_path // empty' <<<"$input")
[ -n "$sid" ] || exit 0
if [ -n "$tp" ]; then cfg=$(dirname "$(dirname "$(dirname "$tp")")"); else cfg="${CLAUDE_CONFIG_DIR:-}"; fi
[ -n "$cfg" ] && [ -d "$cfg" ] || exit 0
cfg=$(cd "$cfg" && pwd -P)

acct=""
while IFS=$'\t' read -r name dir; do
  dir=${dir/#\~/$HOME}
  [ -d "$dir" ] || continue
  [ "$(cd "$dir" && pwd -P)" = "$cfg" ] && { acct=$name; break; }
done < <(jq -r 'if type=="object" then to_entries[] | select(.key!="default" and (.value|type)=="string") | "\(.key)\t\(.value)" else empty end' "$accounts" 2>/dev/null)
[ -n "$acct" ] || exit 0                        # default (or an unlisted dir) -> no-op, default is the absent case

store="$HOME/.claude/state/state_claude_session_accounts.json"
mkdir -p "$(dirname "$store")"
lock="$store.lock"
for _ in $(seq 1 50); do
  if mkdir "$lock" 2>/dev/null; then trap 'rmdir "$lock" 2>/dev/null || true' EXIT; break; fi
  sleep 0.05
done
[ -d "$lock" ] || exit 0
[ -f "$store" ] || echo '{}' > "$store"

# One line at the top of the store so a person opening it knows what it is, re-seeded on every write. The no-op
# guard tests the header as well as the row, or a deleted header would never come back.
readme="Which Claude Code account each session belongs to. Keys are Claude Code session ids; the value is an account name from ~/.config/knowledge-worker-stack/accounts.json, and a session absent from this file is on the default account. Written by ~/.claude/hooks/tag-session-account.sh at session start. Deleting this file makes every past session read as default; only a session that starts again is re-tagged."

[ "$(jq -r --arg s "$sid" '.[$s] // empty' "$store" 2>/dev/null)" = "$acct" ] \
  && [ "$(jq -r '._readme // empty' "$store" 2>/dev/null)" = "$readme" ] && exit 0   # already recorded

tmp=$(mktemp "$store.XXXXXX")
# `{_readme:...} + del(._readme)` puts the header FIRST; a plain `._readme=$r` would append it last.
if jq --arg s "$sid" --arg a "$acct" --arg r "$readme" \
      '{_readme:$r} + del(._readme) | .[$s]=$a' "$store" > "$tmp" 2>/dev/null; then mv "$tmp" "$store"; else rm -f "$tmp"; fi
exit 0
