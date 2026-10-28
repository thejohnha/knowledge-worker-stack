#!/usr/bin/env bash
# claude_auto_successor.sh — scheduled sweep: any live, IDLE Claude Code session in herdr whose context
# has grown past a threshold (default 250,000 tokens) is told, ONCE, to run /successor and hand its
# work to a fresh session.
#
# Why 250k: a fresh successor starts at roughly 30-70k tokens (startup context plus its first
# prompt), so no successor can trip the threshold at birth — a chain cannot run itself, a session
# has to do real work to qualify. Tune SUCCESSOR_THRESHOLD to taste.
#
# Gates, in order — every one must pass before the tell:
#   1. the pane runs a claude agent with a known session id (herdr pane list)
#   2. agent_status is idle or done (`done` is idle with unread output)
#   3. the session is not excluded and has not already been told (grep of the log)
#   4. the transcript has not been written for SUCCESSOR_IDLE_MIN minutes — a real idle signal,
#      where agent_status alone is a snapshot
#   5. context — input + cache_read + cache_creation tokens of the LAST assistant record — exceeds
#      the threshold (input_tokens alone reads near zero when the prompt cache is warm)
#   6. the input box holds no draft — enforced by `tell` itself, which refuses rather than send
# At most ONE session is told per sweep, so two bloated sessions never churn tabs at once.
#
# The log is also the state: a "told <uuid>" line means that session is never nagged again; a
# "refused" line is retried next sweep (a cleared draft clears the refusal).
#
# Environment:
#   SUCCESSOR_THRESHOLD  token threshold                 (default 250000)
#   SUCCESSOR_IDLE_MIN   idle minutes required           (default 30)
#   SUCCESSOR_LOG        log + state file                (default ~/Library/Logs/knowledge-worker-stack/claude_auto_successor.log)
#   SUCCESSOR_EXCLUDE    space-separated uuid prefixes to leave alone
#   SUCCESSOR_DRY=1      list EVERY session that qualifies now, tell nothing, log nothing (a real
#                        run tells only the first one per run)
#   CLAUDE_CONFIG_DIR    Claude Code's config dir        (default ~/.claude)
#
# Runs every 10 minutes from a LaunchAgent (README piece 5) whose PATH finds herdr, jq, python3 and
# ~/bin; launchd starts jobs with a bare PATH, so the plist spells it out.

THRESHOLD=${SUCCESSOR_THRESHOLD:-250000}
IDLE_MIN=${SUCCESSOR_IDLE_MIN:-30}
LOG=${SUCCESSOR_LOG:-$HOME/Library/Logs/knowledge-worker-stack/claude_auto_successor.log}
mkdir -p "$(dirname "$LOG")"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
read -r -a EXCLUDE <<<"${SUCCESSOR_EXCLUDE:-}"
for c in herdr jq herdr_session_manage.sh; do
  command -v "$c" >/dev/null 2>&1 || { echo "$(date '+%F %T') missing $c on PATH — nothing checked" >> "$LOG"; exit 1; }
done
if tail -r /dev/null >/dev/null 2>&1; then revlines() { tail -r "$@"; }; else revlines() { tac "$@"; }; fi

say() { [ -n "${SUCCESSOR_DRY:-}" ] && { echo "DRY $*"; return; }; echo "$(date '+%F %T') $*" >> "$LOG"; }

now=$(date +%s)
while IFS=$'\t' read -r pane uuid status; do
  case "$status" in idle|done) ;; *) continue ;; esac
  for x in "${EXCLUDE[@]}"; do case "$uuid" in "$x"*) continue 2 ;; esac; done
  [ -f "$LOG" ] && grep -q "told $uuid" "$LOG" && continue
  # A lineage closed with /prime-directive close (if installed) is finished: never hand it over.
  [ "$(jq -r --arg s "$uuid" '.[$s].closed? // false' "$HOME/.claude/state/state_claude_session_title_lineage.json" 2>/dev/null)" = true ] && continue
  tx=$(ls "$CLAUDE_HOME"/projects/*/"$uuid".jsonl 2>/dev/null | head -1)
  [ -n "$tx" ] || continue
  mt=$(stat -c %Y "$tx" 2>/dev/null || stat -f %m "$tx")
  [ $(( now - mt )) -ge $(( IDLE_MIN * 60 )) ] || continue
  ctx=$(revlines "$tx" 2>/dev/null | jq -r 'select(.type=="assistant" and .message.usage.input_tokens!=null and .message.model!="<synthetic>")
        | .message.usage | .input_tokens + (.cache_read_input_tokens//0) + (.cache_creation_input_tokens//0)' 2>/dev/null | head -1)
  case "$ctx" in ''|*[!0-9]*) continue ;; esac
  [ "$ctx" -gt "$THRESHOLD" ] || continue
  # The opening tag lets the successor's index of the user's turns recognize this as machine-written.
  msg="[auto-successor] This session's context is $ctx tokens, past the $THRESHOLD auto-handoff threshold. Run the /successor skill now to hand your work to a fresh successor session."
  if [ -n "${SUCCESSOR_DRY:-}" ]; then say "would tell $uuid ctx=$ctx pane=$pane"; continue; fi
  out=$(herdr_session_manage.sh tell "$uuid" "$msg" --timeout 60000 2>&1); trc=$?
  if [ "$trc" = 0 ]; then
    say "told $uuid ctx=$ctx pane=$pane"
  elif [ "$trc" = 3 ]; then
    # SENT but unconfirmed: logged as told ON PURPOSE. The target is probably already running
    # /successor on the first copy, and a second copy would interrupt it mid-handover.
    say "told $uuid ctx=$ctx pane=$pane (unconfirmed: $out)"
  else
    say "refused $uuid ctx=$ctx pane=$pane: $out"
  fi
  exit 0
done < <(herdr pane list 2>/dev/null | jq -r '.result.panes[]
         | select(.agent=="claude" and .agent_session.kind=="id")
         | [.pane_id, .agent_session.value, .agent_status] | @tsv')
exit 0
