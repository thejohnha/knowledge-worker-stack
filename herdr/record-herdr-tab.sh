#!/usr/bin/env bash
# SessionStart hook — record which herdr TAB a session is living in, so the tab can still name its
# session after that session exits.
#
# herdr keeps the pane->session mapping only while the agent is ALIVE: it deletes
# workspaces[].tabs[].panes[].agent_session from ~/.config/herdr/session.json shortly after the agent
# goes away, so after a herdr restart every tab you did not resume is left with nothing but its label.
# This hook writes the same fact down somewhere herdr cannot erase. `hr` reads it.
#
# The tab id comes from HERDR_TAB_ID, which the herdr server injects into every pane it spawns and
# claude passes down to its hooks. A session started outside herdr has no such variable and no-ops.
#
# Keyed by TAB, not pane: a tab outlives the panes inside it, and the tab label is what you read in the
# tab bar. The sibling store state_claude_session_last_herdr_pane.json goes the other way (session ->
# pane, written by herdr_session_manage.sh) and answers "where is this session now", not "what was
# this tab". Both are wanted.
#
# No title is stored: a copy here would go stale the first time the session is renamed. Readers join
# a title on at read time.
#
# Up to five previous occupants are kept per tab, newest first. Any claude started INSIDE a pane
# inherits that pane's HERDR_TAB_ID and records itself as the tab's session, a throwaway one included;
# if its transcript is then deleted, history lets hr fall back to the previous occupant.
#
# Idempotent; mkdir-locked so concurrent SessionStarts cannot clobber the store. Needs jq.
set -euo pipefail

input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input")
[ -n "$sid" ] || exit 0
tab="${HERDR_TAB_ID:-}"
[ -n "$tab" ] || exit 0                       # not inside a herdr pane -> nothing to record

cwd=$(jq -r '.cwd // empty' <<<"$input")
pane="${HERDR_PANE_ID:-}"
ws="${HERDR_WORKSPACE_ID:-}"
now=$(date +%Y-%m-%dT%H:%M:%S%z)
# The tab's label, recorded beside the id so hr can tell later whether the two still belong together.
# Empty is a legitimate answer — an unlabeled tab, or herdr's layout file not yet caught up with a tab
# made seconds ago — and hr reads empty as "no check possible", never as a mismatch.
resolver=$(command -v herdr_session_resolve_tab.py || echo "$HOME/bin/herdr_session_resolve_tab.py")
label=$("$resolver" --live-label "$tab" 2>/dev/null || true)

# HERDR_TAB_STORE redirects every write, for testing. Never point it at the live path in a test.
store="${HERDR_TAB_STORE:-$HOME/.claude/state/state_claude_session_herdr_tabs.json}"
mkdir -p "$(dirname "$store")"
lock="$store.lock"
for _ in $(seq 1 50); do
  if mkdir "$lock" 2>/dev/null; then trap 'rmdir "$lock" 2>/dev/null || true' EXIT; break; fi
  sleep 0.05
done
[ -d "$lock" ] || exit 0
[ -f "$store" ] || echo '{}' > "$store"

readme="Which Claude Code session each herdr TAB last held, so a tab whose session is no longer running can still be resumed. Keys are herdr public tab ids such as wA:t2F; the value carries the session uuid and where it was seen. herdr itself forgets this shortly after an agent exits, which is why the file exists. Written by the SessionStart hook record-herdr-tab.sh at session start, and every minute by herdr_session_record_live.sh for any tab whose session has since moved to another workspace. Read by hr, which resumes the calling tab's own session. Safe to delete: live tabs refill it as their sessions restart, and the hourly herdr_session_snapshot.sh backup (the tabstore family) holds the rest."

# Guard the readme as well as the row, or deleting the header would leave it gone for good — every tab
# already recorded would take the early exit before any write could put it back.
[ "$(jq -r --arg t "$tab" '.tabs[$t].uuid // empty' "$store" 2>/dev/null)" = "$sid" ] \
  && [ "$(jq -r '._readme // empty' "$store" 2>/dev/null)" = "$readme" ] && exit 0

# mktemp is load-bearing for the PERMISSIONS, not just for the atomic swap: it creates at 0600
# regardless of umask, and mv is a rename, so the private mode rides onto the store.
tmp=$(mktemp "$store.XXXXXX")
# `{_readme:...} + del(._readme)` puts the header FIRST; a plain `._readme=$r` would append it last.
if jq --arg t "$tab" --arg s "$sid" --arg p "$pane" --arg w "$ws" --arg c "$cwd" --arg n "$now" --arg l "$label" --arg r "$readme" \
      '{_readme:$r} + del(._readme)
       | .tabs[$t].history = ([(.tabs[$t] // {} | select(.uuid) | {uuid, captured_at})]
                              + (.tabs[$t].history // []) | unique_by(.uuid) | .[0:5])
       | .tabs[$t] += {uuid:$s, pane:$p, workspace:$w, cwd:$c, label:$l, captured_at:$n}' \
      "$store" > "$tmp" 2>/dev/null; then mv "$tmp" "$store"; else rm -f "$tmp"; fi
exit 0
