#!/usr/bin/env bash
# claude_continue_after_connection_loss.sh — run every minute: when the Mac is back online, type
# "continue" into every live claude session in herdr that stopped because it lost the connection.
#
# Claude Code retries a dropped request for a while (CLAUDE_CODE_MAX_RETRIES), then writes its own
# error stop into the transcript and waits for a human. On a laptop that moves (train, tether, sleep)
# that is most drops. This job types the "continue" for you.
#
# A session qualifies when, in order:
#   1. its pane runs a claude agent with a known session id, and herdr says idle or done
#   2. the LAST conversation record of its transcript (user/assistant, not a sidechain) is Claude
#      Code's own error stop: type=assistant, message.model="<synthetic>", isApiErrorMessage=true
#   3. that stop is error="server_error" with NO apiErrorStatus — the shape of the network-class
#      stops (can't reach the API, went to sleep, connection lost, DNS failure, timed out).
#      Matched on these structured fields only, never on the message wording.
#   4. this stop (its record uuid) has not been continued before — exactly once per stop
#   5. the session has not been continued LOOP_MAX times in the last hour; past that it is held
#      and you get one alert, so a stop that "continue" cannot clear never becomes a paid loop
# Only after something qualifies is the API probed; unreachable means exit and try next minute.
#
# Never continued, by design: rate_limit, authentication_failed, oauth_org_not_allowed, and
# server_error WITH a status (529 overloaded, 500). Any OTHER error stop is unrecognized: you get one
# alert per distinct shape, ever, so a format change shows up instead of failing silently.
# Alerts go through mattermost_post.py (comms/) when it is on PATH, else a macOS notification.
#
# State and log are ONE file, STATE below:
#   continued <session> <stop-record-uuid>   one-shot memory, also the loop count
#   unrecognized <error>/<status>            one alert per shape
#   held <session>                           loop guard tripped, one alert per session
#   refused / unconfirmed lines              tell refused (draft, busy) is retried next minute;
#                                            unconfirmed (tell exit 3) counts as continued, never resent
#
# Env overrides, for testing:
#   CONT_ONLY   only consider sessions whose uuid starts with this prefix
#   CONT_DRY=1  print what would happen, type nothing, write nothing, alert nothing
#   CONT_STATE  state file path

PATH="$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STATE=${CONT_STATE:-$HOME/.claude/state/state_claude_continue_after_connection_loss.log}
LOOP_MAX=3
mkdir -p "$(dirname "$STATE")"

say() { [ -n "${CONT_DRY:-}" ] && { echo "DRY $*"; return; }; echo "$(date '+%F %T') $*" >> "$STATE"; }
seen() { [ -f "$STATE" ] && grep -qF -- "$1" "$STATE"; }
alert() {   # stdin = body; $1 = subject
  [ -n "${CONT_DRY:-}" ] && { echo "DRY alert: $1"; cat; return 0; }
  body=$(cat)
  if command -v mattermost_post.py >/dev/null 2>&1; then
    printf '%s\n' "$body" | mattermost_post.py "$1" >/dev/null 2>&1 && return 0
  fi
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' \
            "$1" "${body:0:200}" >/dev/null 2>&1
  return 0
}
if tail -r /dev/null >/dev/null 2>&1; then revlines() { tail -r "$@"; }; else revlines() { tac "$@"; }; fi

api_up=""
api_reachable() {   # any HTTP answer at all means the network path is back; asked once per run
  [ -n "$api_up" ] || { code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://api.anthropic.com/v1/messages)
                        case "$code" in ''|000) api_up=no ;; *) api_up=yes ;; esac; }
  [ "$api_up" = yes ]
}

for c in herdr jq herdr_session_manage.sh claude_session_transcript.sh; do
  command -v "$c" >/dev/null 2>&1 || { echo "$(date '+%F %T') missing $c on PATH — nothing checked" >> "$STATE"; exit 1; }
done

while IFS=$'\t' read -r pane uuid status; do
  case "$status" in idle|done) ;; *) continue ;; esac
  [ -n "${CONT_ONLY:-}" ] && case "$uuid" in "$CONT_ONLY"*) ;; *) continue ;; esac
  tx=$(claude_session_transcript.sh "$uuid" 2>/dev/null) || continue
  [ -f "$tx" ] || continue

  # The last conversation record, as: rec_uuid  model  isApiErrorMessage  error  apiErrorStatus
  last=$(tail -n 200 "$tx" | revlines | jq -r 'select((.type=="user" or .type=="assistant") and (.isSidechain|not))
         | [.uuid, (.message.model // "-"), (.isApiErrorMessage // false), (.error // "-"), (.apiErrorStatus // "-")] | @tsv' \
         2>/dev/null | head -1)
  IFS=$'\t' read -r rec model iserr err st <<<"$last"
  [ "$model" = "<synthetic>" ] && [ "$iserr" = true ] || continue
  seen "continued $uuid $rec" && continue

  case "$err/$st" in
    server_error/-) ;;                                                      # lost connection: continue
    rate_limit/*|authentication_failed/*|oauth_org_not_allowed/*|server_error/*) continue ;;  # known, left for you
    *) seen "unrecognized $err/$st" && continue
       txt=$(tail -n 200 "$tx" | jq -r --arg r "$rec" 'select(.uuid==$r) | .message.content[0].text // ""' 2>/dev/null | head -c 400)
       printf 'A Claude session stopped on an error that claude_continue_after_connection_loss.sh does not recognize, so it was left alone.\nIf this is a lost connection in a new format, the script needs updating.\n\nerror: %s\napiErrorStatus: %s\nsession: %s (pane %s)\nmessage: %s\n\nYou get this once per error shape. Log: %s\n' \
         "$err" "$st" "$uuid" "$pane" "$txt" "$STATE" | alert "Claude auto-continue: unrecognized error stop $err/$st" \
         && say "unrecognized $err/$st session=$uuid rec=$rec"
       continue ;;
  esac

  hour_ago=$(date -v-1H '+%F %T' 2>/dev/null || date -d '1 hour ago' '+%F %T')
  recent=$([ -f "$STATE" ] && awk -v t="$hour_ago" -v s="$uuid" '($1" "$2)>=t && $3=="continued" && $4==s' "$STATE" | wc -l | tr -d ' ')
  if [ "${recent:-0}" -ge "$LOOP_MAX" ]; then
    seen "held $uuid" && continue
    printf 'claude_continue_after_connection_loss.sh typed "continue" into session %s (pane %s) %s times in the last hour and it stopped on a lost connection again each time.\nIt is no longer continuing that session. Look at it when you can.\n\nLog: %s\n' \
      "$uuid" "$pane" "$recent" "$STATE" | alert "Claude auto-continue: holding a session that keeps failing" \
      && say "held $uuid pane=$pane"
    continue
  fi

  api_reachable || exit 0                                                   # still offline: next minute
  if [ -n "${CONT_DRY:-}" ]; then say "would continue $uuid rec=$rec pane=$pane"; continue; fi
  # The comms manager's per-session wake lock, when installed, so two wakers never type at once;
  # busy (exit 75) is retried next minute like any refusal.
  tell=(herdr_session_manage.sh tell "$uuid" "continue" --no-resume --timeout 60000)
  if command -v claude_frontdesk.py >/dev/null 2>&1; then
    out=$(claude_frontdesk.py wake-lock "$uuid" --wait 5 -- "${tell[@]}" 2>&1); trc=$?
  else
    out=$("${tell[@]}" 2>&1); trc=$?
  fi
  case "$trc" in
    0) say "continued $uuid $rec pane=$pane" ;;
    3) say "continued $uuid $rec pane=$pane (unconfirmed: $out)" ;;        # sent; never resend blind
    *) say "refused $uuid $rec pane=$pane: $out" ;;                        # draft or busy box: next minute
  esac
done < <(herdr pane list 2>/dev/null | jq -r '.result.panes[]
         | select(.agent=="claude" and .agent_session.kind=="id")
         | [.pane_id, .agent_session.value, .agent_status] | @tsv')
exit 0
