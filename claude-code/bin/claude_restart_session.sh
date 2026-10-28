#!/usr/bin/env bash
# Restarts a live Claude Code session IN ITS OWN PANE with ONE thing changed: quits it once it is
# idle, then resumes the same transcript there. The two things it can change:
#
#   --dangerously-skip-permissions
#                     resume in skip mode (claude's own flag, same spelling) — no permission
#                     prompts and no auto-mode classifier. Only the user turns this on: the
#                     `skip` hook and the keep-skip-mode hook pass it; nothing tells a session to.
#   --account NAME    resume on another Claude account (a name in ~/.config/knowledge-worker-stack/accounts.json,
#                     or default). The account is a per-session TAG in the sidecar
#                     ~/.claude/state/state_claude_session_accounts.json; `cr` reads it on resume and
#                     launches with that account's config dir and token. The switch changes WHO IS
#                     BILLED; the transcript stays where it is.
#
#   claude_restart_session.sh [<uuid>] [--dangerously-skip-permissions] [--account NAME] [--model M] [--effort E] [--no-continue]
#
# No uuid means THIS session ($CLAUDE_CODE_SESSION_ID) — the normal case: the session runs it on
# itself, replies, goes idle, and comes back in the same tab a few seconds later with its whole
# transcript. Model and effort default to what the session is running now (the transcript's last
# assistant event, and $CLAUDE_EFFORT). Skip mode is KEPT if the session already runs in it
# (read off the live claude process's command line), so an account change alone changes one thing.
# After a good resume it tells the session to carry on (one `tell`, so it does not sit idle waiting for
# a "go"); --no-continue skips that, and keep-skip-mode-across-resume.py passes it, because a reboot
# restore would otherwise wake every session at once.
#
# It detaches itself and returns at once, because the session that runs it is still working at
# that moment and `quit` sends ctrl+d ctrl+d immediately — a quit typed into a working session would
# only interrupt its turn. The detached half waits for two consecutive idle reads, quits through
# herdr_session_manage.sh, waits for the process to be gone, then resumes through the same script's
# `resume` — or, for skip mode, which that script never starts, by typing `cr` into the pane itself.
# Everything it did is in the log it prints; the fallback if the resume half fails is one paste
# (the log names it):
#   cr <uuid> [--dangerously-skip-permissions]

set -o pipefail

# Every account's config dir: ~/.claude plus each dir in ~/.config/knowledge-worker-stack/accounts.json.
config_dirs() {
  echo "$HOME/.claude"
  jq -r 'if type=="object" then .[] | strings else empty end' ~/.config/knowledge-worker-stack/accounts.json 2>/dev/null | sed "s|^~|$HOME|"
}
session_files() { local d; config_dirs | sort -u | while IFS= read -r d; do ls "$d"/sessions/*.json 2>/dev/null; done; }

# ------------------------------------------------------------------ the detached half
if [[ "$1" == --watch ]]; then
  shift
  u=$1; pane=$2; model=$3; effort=$4; log=$5; aname=$6; skip=$7; acct=$8; cont=${9:-yes}; clear=${10:-}
  # Skip mode only on claude's own flag spelling, so even a hand-run of this half says what it does.
  [[ "$skip" == --dangerously-skip-permissions ]] && skip=yes || skip=no
  say() { echo "$(date +%H:%M:%S) $*" >> "$log"; }
  # One durable line per restart in ~/.claude/state (macOS sweeps $TMPDIR after a few days): the record of
  # what was switched when. Written once, at the end, whatever the outcome.
  uselog=~/.claude/state/state_claude_session_restarts.log
  record() { mkdir -p "${uselog%/*}"; echo "$(date '+%Y-%m-%d %H:%M:%S') $u account=${acct:-unchanged} skip=$skip outcome=$1" >> "$uselog"; }
  fallback="cr $u"; [[ "$skip" == yes ]] && fallback+=" --dangerously-skip-permissions"

  gone() {   # pid registry, believed only while kill -0 says the pid is alive
    local f pid
    for f in $(session_files); do
      [[ -e "$f" ]] || continue; pid=${f##*/}; pid=${pid%.json}
      kill -0 "$pid" 2>/dev/null || continue
      [[ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" == "$u" ]] && return 1
    done
    return 0
  }

  say "watching $u in $pane — skip=$skip account=${acct:-(unchanged)} model=${model:-(default)} effort=${effort:-(default)}"
  idle=0; quit=no; armed=$(date +%s)
  for _ in $(seq 1 "${RESTART_POLLS:-120}"); do
    sleep "${RESTART_POLL:-5}"
    st=$(herdr agent list 2>/dev/null | jq -r --arg p "$pane" '.result.agents[]|select(.pane_id==$p)|.agent_status')
    [[ -z "$st" ]] && { say "no agent in $pane any more — nothing to quit"; quit=gone; break; }
    [[ "$st" == idle || "$st" == done ]] || { idle=0; continue; }
    (( ++idle < 2 )) && continue
    if out=$(herdr_session_manage.sh quit "$pane" 2>&1); then
      say "quit after $(( $(date +%s) - armed ))s: $out"; quit=yes; break
    fi
    # Claude Code puts a prompt a hook blocked back in the box, so the "skip" that armed this restart
    # sits there as a draft; clear it when it is exactly that text and nothing more.
    if [[ -n "$clear" && "$(herdr_session_manage.sh draft "$pane" 2>/dev/null)" == "$clear" ]]; then
      herdr pane send-keys "$pane" ctrl+u >/dev/null 2>&1; idle=0; say "cleared '$clear' left in the box by the hook"; continue
    fi
    idle=0; say "not quitting: $out"                       # an unsent draft — the user is typing; wait
  done
  [[ "$quit" == yes || "$quit" == gone ]] || { say "never idle within the poll budget — left running, nothing changed (the account tag, if any, IS already written and applies on the next resume)"; record never-idle; exit 0; }

  for _ in $(seq 1 20); do gone && break; sleep 1; done
  gone || { say "still live 20s after quit — NOT resuming; paste: $fallback"; record quit-failed; exit 1; }

  if [[ "$skip" == yes ]]; then
    # herdr_session_manage.sh resume never starts skip mode (any agent can call it), so this half
    # types cr itself and then checks the pane came back on this session.
    cmd="cr $u --dangerously-skip-permissions"
    [[ -n "$model" ]]  && cmd+=" --model $(printf %q "$model")"
    [[ -n "$effort" ]] && cmd+=" --effort $(printf %q "$effort")"
    herdr pane send-keys "$pane" ctrl+u >/dev/null 2>&1
    herdr pane run "$pane" "$cmd" >/dev/null 2>&1
    back=""; trusted=no
    for _ in $(seq 1 30); do
      sleep 1
      back=$(herdr pane list --workspace "${pane%%:*}" 2>/dev/null | jq -r --arg p "$pane" '.result.panes[]?|select(.pane_id==$p)|.agent_session.value // empty' 2>/dev/null)
      [[ "$back" == "$u" ]] && break
      # Another account meets claude's trust box for the session's own launch folder: answer it once.
      if [[ $trusted == no ]] && herdr pane read "$pane" --source visible --lines 12 --format text 2>/dev/null | grep -q 'Yes, I trust this folder'; then
        herdr pane send-keys "$pane" down enter >/dev/null 2>&1; trusted=yes
      fi
    done
    [[ -n "$aname" && "$back" == "$u" ]] && herdr agent rename "$pane" "$aname" >/dev/null 2>&1
    out="pane=$pane uuid=${back:-none}"; [[ "$back" == "$u" ]]; ok=$?
  else
    args=(resume "$u" --pane "$pane" --exact)
    [[ -n "$model" ]]  && args+=(--model "$model")
    [[ -n "$effort" ]] && args+=(--effort "$effort")
    [[ -n "$aname" ]]  && args+=(--agent-name "$aname")
    out=$(herdr_session_manage.sh "${args[@]}" 2>&1); ok=$?
  fi
  if (( ok == 0 )); then
    say "resumed (skip=$skip account=${acct:-unchanged}): $out"; record resumed
    if [[ "$cont" == yes ]]; then
      what=(); [[ "$skip" == yes ]] && what+=("in skip mode"); [[ -n "$acct" ]] && what+=("on the $acct account")
      msg="Restarted${what:+ ${what[*]}}. Continue where you left off; if you were waiting on the user, say so in one line."
      # env -u: this watcher inherited the restarted session's own id, and tell refuses to message itself.
      if out=$(env -u CLAUDE_CODE_SESSION_ID herdr_session_manage.sh tell "$u" "$msg" --no-resume --exact --timeout 180000 2>&1); then
        say "continue sent: $out"
      else
        say "continue NOT confirmed (rc=$?): $out"
      fi
    fi
  else
    say "resume FAILED: $out"; say "paste in $pane: $fallback"; record resume-failed; exit 1
  fi
  exit 0
fi

# ------------------------------------------------------------------ the arming half
u=""; model=""; effort=""; skip=""; acct=""; cont=yes; clear=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dangerously-skip-permissions) skip=yes; shift;;
    --no-continue) cont=no; shift;;
    --clear-draft) clear=$2; shift 2;;                     # restart-in-skip-mode-on-skip.sh: its trigger word
    --account) acct=$2; shift 2;;
    --model)   model=$2; shift 2;;
    --effort)  effort=$2; shift 2;;
    --*) echo "usage: ${0##*/} [<uuid>] [--dangerously-skip-permissions] [--account NAME] [--model M] [--effort E] [--no-continue]" >&2; exit 2;;
    *) u=$1; shift;;
  esac
done
u=${u:-$CLAUDE_CODE_SESSION_ID}
[[ "$u" =~ ^[0-9a-f-]{36}$ ]] || { echo "need a full session uuid (none given and \$CLAUDE_CODE_SESSION_ID is empty)" >&2; exit 2; }

# Any project folder: a session files its transcript under <config dir>/projects/<launch folder>/, and
# cr resolves it the same way and cds to the launch folder before resuming.
j=$(claude_session_transcript.sh "$u") || exit 2

pane=$(herdr agent list 2>/dev/null | jq -r --arg u "$u" '.result.agents[]|select(.agent_session.value==$u)|.pane_id' | head -1)
[[ -n "$pane" ]] || { echo "session $u is not live in any herdr pane — resume it instead: cr $u" >&2; exit 1; }

# Account: validate against accounts.json and the token on disk BEFORE anything is quit, then write the
# sidecar (mkdir lock, jq, mv; default = entry absent). The SessionStart hook tag-session-account.sh re-tags
# from the resumed session's transcript path, so the two agree afterwards.
if [[ -n "$acct" ]]; then
  if [[ "$acct" != default ]]; then
    dir=$(jq -r --arg a "$acct" 'if type=="object" then .[$a] // empty else empty end' ~/.config/knowledge-worker-stack/accounts.json 2>/dev/null)
    [[ -n "$dir" ]] || { echo "unknown account '$acct' — add it to ~/.config/knowledge-worker-stack/accounts.json" >&2; exit 2; }
    dir=${dir/#\~/$HOME}
    [[ -s "$dir/.oauth_token" ]] || { echo "$acct has no token ($dir/.oauth_token) — mint one with claude setup-token" >&2; exit 1; }
  fi
  store=~/.claude/state/state_claude_session_accounts.json
  mkdir -p "$(dirname "$store")"; lock="$store.lock"
  for _ in $(seq 1 50); do mkdir "$lock" 2>/dev/null && break; sleep 0.05; done
  [[ -d "$lock" ]] || { echo "could not lock $store" >&2; exit 1; }
  [[ -f "$store" ]] || echo '{}' > "$store"
  tmp=$(mktemp "$store.XXXXXX")
  if [[ "$acct" != default ]]; then jq --arg s "$u" --arg a "$acct" '.[$s]=$a' "$store" > "$tmp"
  else jq --arg s "$u" 'del(.[$s])' "$store" > "$tmp"; fi
  command mv -f "$tmp" "$store"; rmdir "$lock" 2>/dev/null
  was=$(jq -r --arg s "$u" '.[$s] // "default"' "$store")   # re-read: proves the write landed
  [[ "$was" == "$acct" ]] || { echo "sidecar write did not land (reads '$was')" >&2; exit 1; }
fi

# Keep skip mode if the session already runs in it: the TARGET's live claude process's command line says
# so. Its pid comes from the pid registry (alive per kill -0); $CLAUDE_PID is the CALLER, right only when
# a session restarts itself, so it is the fallback for a target the registry does not show.
if [[ -z "$skip" ]]; then
  skip=no; tpid=""
  for f in $(session_files); do
    [[ -e "$f" ]] || continue; p=${f##*/}; p=${p%.json}
    kill -0 "$p" 2>/dev/null && [[ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" == "$u" ]] && { tpid=$p; break; }
  done
  ps -o args= -p "${tpid:-${CLAUDE_PID:-0}}" 2>/dev/null |
    grep -qE -- '--dangerously-skip-permissions|--permission-mode[ =]bypassPermissions' && skip=yes
fi

# Defaults that keep the session as it is: the model of the last assistant event, and this shell's effort.
if [[ -z "$model" ]]; then
  # -R + fromjson? : the tail starts mid-line, and a plain jq stops dead on that first broken row.
  model=$(tail -c 400000 "$j" | jq -R 'fromjson? | select(.type=="assistant") | .message.model // empty' -r 2>/dev/null | grep -v '<synthetic>' | tail -1)
fi
[[ -z "$effort" && -n "${CLAUDE_EFFORT:-}" ]] && effort=$CLAUDE_EFFORT
# The sidebar name (herdr's agent name) does not survive a quit; carry it across or the session comes back <unnamed>.
aname=$(herdr agent list 2>/dev/null | jq -r --arg u "$u" '.result.agents[]|select(.agent_session.value==$u)|.name // empty' | head -1)

sid=${u:0:8}
log=$(mktemp "${TMPDIR:-/tmp}/claude-$(date +%Y%m%d)-$sid-restart-session.XXXXXX") || exit 1
self=$(command -v "$0" 2>/dev/null || echo "$0"); case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
skipflag=no; [[ "$skip" == yes ]] && skipflag=--dangerously-skip-permissions
nohup "$self" --watch "$u" "$pane" "$model" "$effort" "$log" "$aname" "$skipflag" "$acct" "$cont" "$clear" >/dev/null 2>&1 &
disown 2>/dev/null || true
echo "restart armed for $u in $pane (skip=$skip account=${acct:-unchanged} model=${model:-default} effort=${effort:-default} name=${aname:-none} continue=$cont) -> $log"
