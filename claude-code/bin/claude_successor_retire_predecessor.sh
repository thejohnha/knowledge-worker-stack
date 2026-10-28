#!/usr/bin/env bash
# Retires the predecessor of a /successor handover. The successor runs this as its FIRST action.
#
#   claude_successor_retire_predecessor.sh <pred-uuid> <pred-pane> [pred-title]
#
# In order: wait for the predecessor to stop working, quit it (ctrl+d twice, via
# herdr_session_manage.sh), close the tab it leaves behind, then — if [pred-title] is given — set
# its title. It detaches itself and returns at once with a log path, because when the successor
# reads its first prompt the predecessor is ALWAYS still live, writing its closing report: anything
# that checks once and gives up can only ever refuse.
#
# An empty [pred-title] means "quit and close, no title to set" (the predecessor was already
# numbered). The title is written only AFTER the quit: a running Claude Code session re-writes its
# own title record as it works, so a title appended to a live session's transcript is outvoted.
#
# It is a script invoked by name, not an inline heredoc, so a single Bash permission rule
# (Bash(claude_successor_retire_predecessor.sh:*)) can cover it — rules match the first token.
#
# Environment: RETIRE_POLL (seconds between reads, default 20), RETIRE_POLLS (default 90).

set -o pipefail
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

# ------------------------------------------------------------------ the detached half
if [[ "$1" == --watch ]]; then
  shift
  u=$1; pane=$2; predtitle=$3; log=$4
  say() { echo "$(date +%H:%M:%S) $*" >> "$log"; }

  # Is the predecessor still running? `lsof` cannot answer this — Claude Code appends to its
  # transcript and closes it rather than holding it open. The pid registry is the check that works,
  # each entry believed only while `kill -0` says its pid is alive. Ambiguity resolves to LIVE.
  gone() {
    local f pid
    for f in "$CLAUDE_HOME"/sessions/*.json; do
      [[ -e "$f" ]] || continue; pid=${f##*/}; pid=${pid%.json}
      kill -0 "$pid" 2>/dev/null || continue
      [[ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" == "$u" ]] && return 1
    done
    return 0
  }

  idle=0; retired=no; armed=$(date +%s)
  for _ in $(seq 1 "${RETIRE_POLLS:-90}"); do
    sleep "${RETIRE_POLL:-20}"
    row=$(herdr agent list 2>/dev/null | jq -r --arg p "$pane" '.result.agents[]|select(.pane_id==$p)|"\(.agent_status) \(.agent_session.value // "")"')
    st=${row%% *}; s=${row#* }
    if [[ -z "$st" ]]; then
      # An empty list means the agent is gone OR herdr did not answer this call. Ask the pid
      # registry, which does not go blind at the same moment, instead of believing one empty read.
      gone && { say "no agent in $pane any more"; retired=yes; break; }
      say "agent list empty for $pane but its session is still live — herdr did not answer, still watching"
      continue
    fi
    # The pane must still hold the predecessor: a pane id names a place, and another session may sit there now.
    [[ "$s" == "$u" ]] || { say "$pane runs ${s:-an unknown session}, not $u — not quitting it"; break; }
    [[ "$st" == idle || "$st" == done ]] || { idle=0; continue; }   # `done` is idle, just unread
    (( ++idle < 2 )) && continue                                    # one idle read can land between tool calls
    if out=$(herdr_session_manage.sh quit "$pane" 2>&1); then
      say "quit after $(( $(date +%s) - armed ))s: $out"; retired=yes; break
    fi
    idle=0; say "not quitting: $out"                                # an unsent draft: the user is still there
  done

  # Every line below assumes the session is GONE. A refused quit is a person still using it.
  [[ "$retired" == yes ]] || { say "not retired — tab left open, title untouched"; exit 0; }
  for _ in 1 2 3 4 5; do gone && break; sleep 1; done
  gone || { say "still live — tab left open and title NOT touched"; exit 0; }

  predtab=$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.tab_id // empty')
  [[ -n "$predtab" ]] || { sleep 2; predtab=$(herdr pane get "$pane" 2>/dev/null | jq -r '.result.pane.tab_id // empty'); }
  if [[ -n "$predtab" ]] && herdr tab close "$predtab" >/dev/null 2>&1; then
    say "closed tab $predtab — resume the predecessor with: cr $u"
  else
    say "could not close the tab for $pane, it is left at a shell — resume with: cr $u"
  fi
  [[ -n "$predtitle" ]] || { say "predecessor was already numbered — no title to set"; exit 0; }

  j=$(ls "$CLAUDE_HOME"/projects/*/"$u".jsonl 2>/dev/null | head -1)
  [[ -f "$j" ]] || { say "no transcript for $u — title not set"; exit 0; }
  if tail -r /dev/null >/dev/null 2>&1; then rev() { tail -r "$@"; }; else rev() { tac "$@"; }; fi
  now=$(rev "$j" | jq -r 'select(.type=="custom-title")|.customTitle' | head -1)
  if [[ "$now" == "$predtitle" ]]; then say "predecessor title is already: $now"; else
    jq -nc --arg t "$predtitle" --arg u "$u" '{type:"custom-title",customTitle:$t,sessionId:$u}' >> "$j"
    say "titled: $predtitle   (was \"$now\")"
  fi
  exit 0
fi

# ------------------------------------------------------------------ the arming half
u=$1; predpane=$2; predtitle=$3
[[ -n "$u" && -n "$predpane" ]] || { echo "usage: ${0##*/} <pred-uuid> <pred-pane> [pred-title]" >&2; exit 2; }
case "$u$predpane" in *'<'*|*'>'*) echo "refusing to arm: an argument is still a placeholder" >&2; exit 2 ;; esac
[[ "$u" =~ ^[0-9a-f-]{36}$ ]] || { echo "refusing to arm: \"$u\" is not a session uuid" >&2; exit 2; }

live=$(herdr agent list 2>/dev/null | jq -r --arg p "$predpane" '.result.agents[]|select(.pane_id==$p)|.agent_session.value // empty')
[[ "$live" == "$u" ]] || { echo "refusing to arm: $predpane runs ${live:-no known session}, not $u" >&2; exit 2; }
log=$(mktemp "${TMPDIR:-/tmp}/claude-successor-retire-${u:0:8}.XXXXXX") || exit 1
self=$(command -v "$0" 2>/dev/null || echo "$0"); case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
nohup "$self" --watch "$u" "$predpane" "$predtitle" "$log" >/dev/null 2>&1 &
disown 2>/dev/null || true
echo "predecessor retirement armed -> $log"
