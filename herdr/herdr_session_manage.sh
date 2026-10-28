#!/usr/bin/env bash
# Reach a Claude Code session inside a herdr pane — start it, resume it, quit it, look at its
# input box, put the user's screen on it, or get a message into it. Each move was being
# re-derived by hand every time, and each one here verifies its own result rather than
# trusting the call that made it.
#
#   herdr_session_manage.sh start <tab-label> [--workspace wN] [--account NAME] [--cwd PATH, default $HOME]
#                                            (tab-label: one word, two max — never the dated session title)
#                                            [--agent-name NAME] [--session-name TITLE] [--model M] [--effort E]
#                                            [--permission-mode MODE, default auto]
#   herdr_session_manage.sh resume <UUID> [--pane wN:pM | --workspace wN --label TEXT] [--agent-name NAME]
#                                         [--model M] [--effort E] [--permission-mode MODE]
#                                         [--exact] [--new-tab]
#     MODE, for start and resume: auto default acceptEdits plan dontAsk. Never bypassPermissions (skip
#     mode): only the user turns that on, by typing `skip` in the session itself.
#   herdr_session_manage.sh quit <PANE> [--keep-work]   # background work is stopped unless --keep-work
#   herdr_session_manage.sh draft <PANE>
#   herdr_session_manage.sh goto <TAB>
#   herdr_session_manage.sh move [<TARGET>] <WORKSPACE> [--label TEXT] [--new] [--focus]
#                                        (TARGET: this | <UUID> | <PANE> | <TAB> | a tab label; default this.
#                                         WORKSPACE: an id, or any unambiguous part of its label)
#   herdr_session_manage.sh tell <UUID|PANE> <message> [--timeout MS] [--no-resume]
#                                        [--workspace wN] [--label TEXT] [--agent-name NAME]
#                                        [--exact] [--new-tab]
#     tell never sends a message that is only `skip`: in the target that is the user's skip-mode command.
#     tell exit codes: 0 delivered and PROVED off the target's transcript; 1 refused before
#     sending, or something arrived that is not what was sent; 2 usage; 3 SENT but not confirmed
#     inside the verify budget (TELL_VERIFY_SECONDS, default 30), or only queued in a busy target
#     (read later, as a queued_command or the next turn's prompt). Treat 3 as probably-delivered:
#     read the target's transcript, and never resend on it blind — that double-prompts a session
#     already acting on the first copy.
#
# Accounts are the names in ~/.config/knowledge-worker-stack/accounts.json; without that file there is one,
# called default.
# Example — a session on another account, in an existing workspace, named for the sidebar:
#   herdr_session_manage.sh start notes --workspace w7 --account project-b \
#                                 --agent-name notes-001 --model opus --effort high
# Example — bring a session back cheaper than it was, and in plan mode:
#   herdr_session_manage.sh resume <UUID> --pane w7:p3 --model haiku --permission-mode plan
# Example — put this very session in the project-a workspace, and another session's tab in project-b:
#   herdr_session_manage.sh move this project-a
#   herdr_session_manage.sh move notes project-b
# Example — get a message into a session whether or not it is still running:
#   herdr_session_manage.sh tell 12345678-90ab-4cde-8f01-23456789abcd "the folder moved to ~/projects/docs"
#
# Why each verb is not a one-liner, and why the details below are load-bearing. See also
# herdr/README.md in knowledge-worker-stack.
#   start   the account is exported INSIDE the pane and then VERIFIED, because a wrong config dir
#           runs the session on the wrong account instead of failing; agent start also races
#           the pane's shell and must be retried on agent_pane_busy.
#   resume  goes through cr, the only path that refuses a second live copy of one session
#           (two copies fork the transcript and one branch is lost) and that resolves the
#           session's account and title. --model/--effort/--permission-mode ride along on
#           that cr call, one-shot for this resume only; --model is then VERIFIED off the
#           footer, because an unrecognized name is accepted in silence.
#   quit    ctrl+d must arrive twice inside Claude Code's confirm window, and never into a
#           pane holding an unsent draft.
#   goto    puts the USER'S SCREEN on a tab. The screen only follows workspace focus; tab
#           focus alone re-arms which tab a workspace shows without switching to it. No flag
#           verifies the result — the focused flag can disagree with the screen the user is
#           reading — so goto reports what it did and leaves confirmation to the user's eyes.
#   move    a tab CANNOT change workspace: tab.move carries insert_index and no workspace_id,
#           so the pane moves and a NEW tab is built around it on the far side. herdr carries
#           none of what you would notice across that gap — the tab's label is dropped and
#           the arrival is numbered — so this verb re-applies the label, follows with the
#           tab's other panes, and proves the same session id arrived rather than a fresh one.
#   tell    one composed path for "get this message into that session", live or stopped. It
#           resolves the target by SESSION id, resumes it if it is not running, waits on
#           herdr's own agent_status rather than sleeping and hoping, refuses a blocked target
#           outright, refuses a pane holding an unsent draft, and then proves delivery by
#           reading the TARGET'S transcript — a send call returning 0 proves only that herdr
#           accepted a string.
set -uo pipefail

usage() { sed -n '2,/^# Why each verb/p' "$0" | sed -e '$d' -e '$d' -e 's/^# \{0,1\}//' >&2; }  # synopsis + examples, delimited by ADDRESS not a line number so a concurrent synopsis insert cannot truncate them; the rationale below is for readers, not the usage line
die() { echo "herdr_session_manage: $*" >&2; exit 1; }
die_usage() { echo "herdr_session_manage: $*" >&2; echo >&2; usage; exit 2; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
# The flag fails SOFT in claude: a typo prints one stderr line and the session runs at the default.
# bypassPermissions is refused: this script runs on an agent's word, and skip mode is the user's call alone.
check_mode() {  # <verb> <mode>
  case "$2" in auto|default|acceptEdits|dontAsk|plan) ;;
    *) die "$1: --permission-mode '$2' is not allowed here (auto default acceptEdits dontAsk plan)";;
  esac
}
need herdr; need python3

api() { herdr "$@" 2>&1; }
jget() { python3 -c 'import json,sys
d=json.load(sys.stdin)
if "error" in d: sys.exit(3)
cur=d.get("result",{})
for k in sys.argv[1].split("."):
    if cur is None: sys.exit(4)
    cur=cur.get(k) if isinstance(cur,dict) else None
print(cur if cur is not None else "")' "$1"; }

# The input box is what sits between the LAST two ─── rules. It is read in ANSI because an
# empty box is not blank: Claude Code paints a grayed-out suggestion there, dim (SGR 2),
# and a plain-text read reports that placeholder as if it were the user's own draft.
# A pane can be MID-REPAINT when it is read, and a read landing in that window finds no ─── rules
# at all and reports exit 2 — "I could not look". A check fired the instant `herdr agent wait
# --until idle` returns can come back "no input box found" while the same check seconds later reads
# "empty", so a single read produces random refusals. So exit 2 is RETRIED here, and only a RUN of
# unreadable reads is reported as unreadable. A box holding real text is never retried — that is a
# genuine answer, and it is the one that must abort a send.
#
# Scrolling is NOT a cause: Claude Code pins the box and footer below the scrolling transcript, so
# there is no need to page a pane down before sending. A persistent rc 2 has no known cause beyond
# the repaint race, so dump what was on screen when the reads failed, as evidence for whoever hits
# it next. That dump is plain text on purpose: it is for a human to read, not for the draft parser,
# so the dim-attribute hazard above does not apply to it.
pane_draft() {
  local i out rc
  for i in 1 2 3 4 5; do
    out=$(pane_draft_once "$1"); rc=$?
    [ "$rc" = 2 ] || { printf '%s' "$out"; return "$rc"; }
    sleep 1
  done
  echo "pane_draft: $1 showed no input box in 5 reads over 5s — cause unknown, see the comment" >&2
  echo "pane_draft: what was on screen:" >&2
  herdr pane read "$1" --source visible --lines 20 --format text 2>&1 | sed 's/^/  | /' >&2  # not-a-draft-check
  return 2
}
pane_draft_once() {
  herdr pane read "$1" --source visible --lines 60 --format ansi --ansi 2>/dev/null | python3 -c '
import re,sys
raw=sys.stdin.read().split("\n")
plain=[re.sub(r"\x1b\[[0-9;]*[A-Za-z]","",l).replace("\r","") for l in raw]
rules=[i for i,l in enumerate(plain) if l.strip().startswith("─")]
# The top border carries the session title right-aligned, so a title long enough to fill the
# pane consumes the whole dash run and the line no longer STARTS with one — only the bottom
# rule is found and the box reads as absent, and every quit is refused.
# Recover the border from the INPUT LINE rather than by widening the dash test to "ends with
# a dash" — a wrapped draft line ending in one would then read as the border, the box would
# come back EMPTY, and empty is what lets quit send ctrl+d over unsent text.
if len(rules)<2:
    p=[i for i,l in enumerate(plain[:rules[-1]]) if l.startswith("❯")] if rules else []
    if p and p[-1]>0: rules=[p[-1]-1]+rules
if len(rules)<2: sys.exit(2)
out=[]
for r,p in zip(raw[rules[-2]+1:rules[-1]], plain[rules[-2]+1:rules[-1]]):
    body=re.sub(r"^\s*❯\s?","",p).strip()
    if not body: continue
    if "\x1b[2m" in r: continue          # dim = placeholder suggestion, not typed text
    out.append(body)
sys.stdout.write("\n".join(out))'
}

# ctrl+u clears ONE line of the input box, not the box: a three-line draft can need four presses
# to empty. So press and RE-READ rather than pressing a fixed count and
# hoping. Returns non-zero if the box still holds text, and the caller must not send in that case.
pane_clear_box() {
  local i txt
  for i in $(seq 1 12); do
    txt=$(pane_draft_once "$1" 2>/dev/null) || txt="?"      # unreadable counts as not-yet-empty
    [ -z "$txt" ] && return 0
    herdr pane send-keys "$1" ctrl+u >/dev/null 2>&1
  done
  txt=$(pane_draft "$1") && [ -z "$txt" ]
}

# The FAITHFUL reader, used only to capture text that will be typed back. pane_draft_once above
# strips each line and drops empty ones. That is right for "is there a draft?" and wrong for "put
# it back exactly": blank lines would vanish and indents would flatten.
# The box renders a two-column left gutter — "❯" plus a non-breaking space on the first line, two
# spaces on every continuation line — so removing exactly that gutter recovers the author's own
# indentation and keeps interior blank lines. Only TRAILING spaces are unrecoverable: the box is
# padded to the width of the herdr pane and padding cannot be told from typed spaces. That is the
# one loss this accepts, because a trailing space carries no meaning.
# Known limit: a line long enough to WRAP arrives as two screen lines and would rebuild with a
# break that was never typed. --source recent-unwrapped exists if that ever bites.
pane_draft_raw() {
  herdr pane read "$1" --source visible --lines 60 --format ansi --ansi 2>/dev/null | python3 -c '
import re,sys
raw=sys.stdin.read().split("\n")
plain=[re.sub(r"\x1b\[[0-9;]*[A-Za-z]","",l).replace("\r","") for l in raw]
rules=[i for i,l in enumerate(plain) if l.strip().startswith("─")]
# The top border carries the session title right-aligned, so a title long enough to fill the
# pane consumes the whole dash run and the line no longer STARTS with one — only the bottom
# rule is found and the box reads as absent, and every quit is refused.
# Recover the border from the INPUT LINE rather than by widening the dash test to "ends with
# a dash" — a wrapped draft line ending in one would then read as the border, the box would
# come back EMPTY, and empty is what lets quit send ctrl+d over unsent text.
if len(rules)<2:
    p=[i for i,l in enumerate(plain[:rules[-1]]) if l.startswith("❯")] if rules else []
    if p and p[-1]>0: rules=[p[-1]-1]+rules
if len(rules)<2: sys.exit(2)
out=[]
for r,p in zip(raw[rules[-2]+1:rules[-1]], plain[rules[-2]+1:rules[-1]]):
    if "\x1b[2m" in r: continue                      # dim = the placeholder, never typed text
    p = re.sub(r"^❯[\s ]?","",p,count=1) if p.startswith("❯") else re.sub(r"^ {0,2}","",p,count=1)
    out.append(p.rstrip())
while out and not out[-1]: out.pop()                 # padding rows below the last typed line
while out and not out[0]: out.pop(0)
sys.stdout.write("\n".join(out))'
}

# Rebuild a draft the way a person types it: the text of a line, then shift+enter for the break.
# A literal newline through send-text would SUBMIT the box, which is the thing this whole path
# exists to prevent.
#
# What it is given comes from pane_draft_raw, so indentation and blank lines are already intact
# by the time they get here. A blank line is a shift+enter with no text, which is why the
# send-text call is guarded rather than unconditional.
pane_restore_box() {
  local pane="$1" text="$2" first=yes line
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$first" = yes ] || herdr pane send-keys "$pane" shift+enter >/dev/null 2>&1
    first=no
    [ -n "$line" ] && herdr pane send-text "$pane" "$line" >/dev/null 2>&1
  done <<<"$text"
}

# The lifted draft lives in globals so the EXIT trap can still see it: an EXIT trap fires after
# the function returns, by which point its locals are gone.
_TELL_DRAFT_PANE=""; _TELL_DRAFT_TEXT=""
tell_restore_draft() {
  [ -n "$_TELL_DRAFT_PANE" ] || return 0
  local pane="$_TELL_DRAFT_PANE"; _TELL_DRAFT_PANE=""    # cleared first, so a second call is a no-op
  pane_restore_box "$pane" "$_TELL_DRAFT_TEXT"
  local back; back=$(pane_draft_raw "$pane")   # the faithful reader, to match what was lifted
  if [ "$back" = "$_TELL_DRAFT_TEXT" ]; then
    echo "tell: your unsent text is back in $pane" >&2
  else
    echo "tell: WARNING — could not put your text back in $pane. It was:" >&2
    printf '%s\n' "$_TELL_DRAFT_TEXT" >&2
  fi
}

# A freshly created pane is described in stages: herdr lists the foreground process before
# it has filled in cmdline, so a plain p[0]["cmdline"] raises KeyError exactly while
# wait_for_shell is polling. That crash printed a traceback and returned nothing, and
# "nothing" is how this function says "no process" — so the resume guard below, which
# refuses a pane already running claude, would have waved it through. Fall back through the
# other names for the same thing rather than trusting one key.
pane_shell_cmd() {  # foreground process command line, empty if the pane is gone
  herdr pane process-info --pane "$1" 2>/dev/null | python3 -c '
import json,sys
try: p=json.load(sys.stdin)["result"]["process_info"]["foreground_processes"]
except Exception: sys.exit(1)
if not p: print(""); raise SystemExit
e=p[0]
print(e.get("cmdline") or e.get("argv0") or e.get("name") or "")' 2>/dev/null
}

# Reads the second |-separated field of the status line, which is where the knowledge-worker-stack status line
# (claude-code/) prints "<model> <effort>". With another status line this reads nothing useful and
# warn_model says the model went unverified, which is a warning, never a failure.
pane_model() {  # the model+effort field of the statusline footer, empty if it has not painted yet
  local i out
  for i in 1 2 3 4 5; do
    out=$(herdr pane read "$1" --source visible --lines 12 --format text 2>/dev/null |
          sed -n 's/^ *[^ |]* | \([^|]*\) |.*/\1/p' | tail -1)
    out="${out%"${out##*[![:space:]]}"}"          # trim the trailing spaces the footer pads with
    [ -n "$out" ] && { printf '%s' "$out"; return; }
    sleep 1
  done
}
warn_model() {  # <pane> <requested model> — --model fails SOFT, and the footer is the only witness
  local shown; shown=$(pane_model "$1")
  # A model the CLI KNOWS is rendered as a display name (haiku -> "Haiku 4.5", and so is the
  # full claude-haiku-4-5-20251001). One it does not know is echoed back verbatim and the
  # session runs against an assumed context window. So an exact echo is the tell.
  local s="$shown"
  s="${s% xhigh}"; s="${s% max}"; s="${s% high}"; s="${s% medium}"; s="${s% low}"
  if [ -z "$shown" ]; then
    echo "WARNING: could not read $1's footer — --model '$2' went unverified" >&2
  elif [ "$s" = "$2" ]; then
    echo "WARNING: the footer echoes '$2' back verbatim — the CLI does not know that model, and the session is running against an assumed context window" >&2
  fi
}
pane_session_uuid() {  # herdr agent_session for a pane, empty if no live agent
  # Guarded for the same reason pane_shell_cmd above is: herdr answers a pane id whose WORKSPACE
  # does not exist with an error rather than a pane list, and a caller that polls this in a loop
  # (cmd_resume does, 30 times) would print a traceback per poll. Empty is how this function says
  # "no session"; say it quietly. Python's stderr is deliberately NOT redirected: with the expected
  # shape handled, a message there means a genuinely unexpected failure, which should be visible.
  herdr pane list --workspace "${1%%:*}" 2>/dev/null | python3 -c '
import json,sys
pid=sys.argv[1]
try: panes=json.load(sys.stdin)["result"]["panes"]
except Exception: raise SystemExit(0)
for p in panes:
    if p.get("pane_id")==pid: print((p.get("agent_session") or {}).get("value") or "")' "$1"
}
sidecar_account() {  # <uuid> — the account recorded for this session, 'default' if unknown.
  # Every unknown answer has to come back 'default', because a wrong account here is reported as a
  # real mismatch.
  local f="$HOME/.claude/state/state_claude_session_accounts.json"
  [ -f "$f" ] || { echo default; return; }
  python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
e=d.get(sys.argv[2]) if isinstance(d,dict) else None
print((e.get("account") if isinstance(e,dict) else e) or "default")' "$f" "$1" 2>/dev/null || echo default
}
pane_agent_name() {  # herdr's registered agent name for a pane, empty if it has none
  herdr agent list 2>/dev/null | python3 -c '
import json,sys
pid=sys.argv[1]
for a in json.load(sys.stdin).get("result",{}).get("agents",[]):
    if a.get("pane_id")==pid: print(a.get("name") or "")' "$1"
}

# ---------------------------------------------------------------- quit
cmd_quit() {
  local pane="${1:-}"; [ -n "$pane" ] || die_usage "quit needs a pane id"; shift
  # --keep-work: answer the background-work menu with move-to-background instead of stop tasks.
  local keep_work=; while [ $# -gt 0 ]; do case "$1" in --keep-work) keep_work=1;; *) die_usage "quit: unknown option $1";; esac; shift; done
  # The last moment this session's pane is knowable: after the two ctrl+d, herdr drops the
  # agent_session and nothing on the machine remembers where it lived. Recording it here is what
  # lets a later resume put it back where it was rather than in the caller's workspace.
  record_panes
  local draft rc; draft=$(pane_draft "$pane"); rc=$?
  # exit 2 is "I could not find the input box", which is NOT "there is no draft".
  # Treating it as empty is how a could-not-check renders as OK.
  [ "$rc" = 2 ] && die "quit: cannot read the input box in $pane — refusing to send ctrl+d"
  if [ -n "$draft" ]; then
    echo "REFUSED: $pane holds an unsent draft — not quitting. Its text:" >&2
    printf '%s\n' "$draft" >&2
    exit 1
  fi
  # Both presses in ONE call: measured, a 0.5 s gap still exits and a 1 s gap does not.
  herdr pane send-keys "$pane" ctrl+d ctrl+d >/dev/null 2>&1
  # Success is the pane being back at a SHELL, not merely "not claude": during a turn the
  # foreground process is claude's own caffeinate, and a not-claude test reads that as an exit.
  local i cmd screen n answered=
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 1; cmd=$(pane_shell_cmd "$pane")
    case "${cmd##*/}" in -bash|bash|-zsh|zsh|sh) echo "quit: $pane is back at $cmd"; return 0;; esac
    # ctrl+d does NOT exit a session that has background work: Claude Code asks what to do with
    # it instead, and a quit that just waits out its timeout leaves the pane parked on that menu.
    # Default answer: "Exit and stop tasks". Move-to-background (--keep-work) forks the session
    # into a daemon-owned copy that nothing of ours can reach or read, so the "kept" work reports
    # to nobody while costing a full process.
    # Read the option NUMBER off the screen rather than assuming its position.
    [ -n "$answered" ] && continue
    screen=$(herdr pane read "$pane" --source visible --lines 40 --format text 2>/dev/null)
    case "$screen" in *"Background work is running"*) ;; *) continue;; esac
    local want="Exit and stop tasks"; [ -n "$keep_work" ] && want="Move to background and exit"
    n=$(printf '%s\n' "$screen" | sed -n "s/^[^0-9]*\([0-9]\)\. *$want.*/\1/p" | head -1)
    [ -n "$n" ] || die "quit: $pane holds background work and offers no '$want' option — left untouched"
    herdr pane send-keys "$pane" "$n" >/dev/null 2>&1
    answered=$n
    echo "quit: $pane had background work — chose $n, $want" >&2
  done
  die "quit: $pane still running claude after 12s — nothing was forced"
}

# ---------------------------------------------------------------- draft
cmd_draft() {
  local pane="${1:-}"; [ -n "$pane" ] || die_usage "draft needs a pane id"
  local d rc; d=$(pane_draft "$pane"); rc=$?
  [ "$rc" = 2 ] && { echo "unreadable: no input box found in $pane" >&2; return 2; }
  [ -z "$d" ] && { echo "empty"; return 0; }
  printf '%s\n' "$d"; return 1
}

# ---------------------------------------------------------------- goto
cmd_goto() {
  local tab="${1:-}"; [ -n "$tab" ] || die_usage "goto needs a tab id (wN:tM)"
  local ws="${tab%%:*}"
  { [ "$ws" != "$tab" ] && [ -n "$ws" ]; } || die_usage "goto needs a full tab id like w1R:t4, workspace and tab together"
  api workspace focus "$ws" | jget workspace.workspace_id >/dev/null || die "goto: workspace focus $ws was refused"
  api tab focus "$tab"      | jget tab.tab_id             >/dev/null || die "goto: tab focus $tab was refused"
  echo "goto: focused workspace $ws, then tab $tab — no flag proves the screen followed; only the user's eyes confirm the move"
}

# ---------------------------------------------------------------- shared pane plumbing
new_tab_pane() {  # <label> [workspace] [cwd] -> "<pane id> <tab id>"
  local label="$1" ws="${2:-}" cwd="${3:-}" out
  local -a a=(tab create --label "$label" --no-focus)
  [ -n "$ws" ] && a+=(--workspace "$ws")
  [ -n "$cwd" ] && a+=(--cwd "$cwd")
  out=$(api "${a[@]}") || die "tab create failed: $out"
  # tab create returns BOTH ids in one payload (root_pane.pane_id and tab.tab_id).
  # Return both: a caller that has to roll back needs the TAB id, and reassembling
  # one from the other is not possible — the two id spaces are allocated separately.
  printf '%s %s' "$(printf '%s' "$out" | jget root_pane.pane_id)" \
                 "$(printf '%s' "$out" | jget tab.tab_id)"
}

wait_for_shell() {  # a pane reports revision 0 until its terminal has painted
  local pane="$1" i
  for i in $(seq 1 20); do
    [ -n "$(pane_shell_cmd "$pane")" ] && return 0
    sleep 0.5
  done
  return 1
}

account_dir() {  # <account> -> its CLAUDE_CONFIG_DIR from ~/.config/knowledge-worker-stack/accounts.json; rc 1 if unknown
  python3 -c '
import json, os, sys
try: acc = json.load(open(os.path.expanduser("~/.config/knowledge-worker-stack/accounts.json")))
except Exception: acc = {}
d = acc.get(sys.argv[1]) if isinstance(acc, dict) else None
if not d and sys.argv[1] == "default": d = "~/.claude"
if not isinstance(d, str) or not d: raise SystemExit(1)
print(os.path.expanduser(d))' "$1"
}

export_account() {  # <pane> <account> — export it INSIDE the pane and VERIFY there, never out here
  local pane="$1" acct="$2" d
  [ "$acct" = default ] && return 0
  d=$(account_dir "$acct") || { echo "unknown account '$acct' — add it to ~/.config/knowledge-worker-stack/accounts.json" >&2; return 1; }
  [ -d "$d" ] || { echo "account '$acct': config dir $d does not exist" >&2; return 1; }
  local probe; probe=$(mktemp "${TMPDIR:-/tmp}/claude-herdrsess-acct.XXXXXX") || return 1
  local qd; qd=$(printf %q "$d")
  # The token, if this account keeps one, is never exported into the pane's shell. A shell function
  # named claude reads it with `cat` at launch and sets it on that one command (agent start types
  # `claude ...` into this shell), so it is not on any command line, not in the typed text, and not
  # in the environment of anything else the pane runs. Without a token file the account signs in
  # with its own config dir, and a token inherited from another account must not override it.
  local tok=""
  [ -s "$d/.oauth_token" ] && tok="function claude { CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat $qd/.oauth_token)\" command claude \"\$@\"; } && "
  herdr pane run "$pane" "{ export CLAUDE_CONFIG_DIR=$qd && unset CLAUDE_CODE_OAUTH_TOKEN && $tok[ \"\$CLAUDE_CONFIG_DIR\" = $qd ] && echo acct=ok || echo acct=BAD; } > $(printf %q "$probe") 2>&1" >/dev/null 2>&1
  local i
  for i in $(seq 1 20); do [ -s "$probe" ] && break; sleep 0.5; done
  if ! grep -qx 'acct=ok' "$probe" 2>/dev/null; then
    echo "account export FAILED for '$acct' in $pane: $(cat "$probe" 2>/dev/null)" >&2
    rm -f "$probe"; return 1
  fi
  rm -f "$probe"; return 0
}

# ---------------------------------------------------------------- start
cmd_start() {
  # Always an explicit folder. Without --cwd the new tab would inherit its WORKSPACE's folder, the
  # session could open somewhere never trusted, meet the trust-this-folder box, and `agent start`
  # would fail as "blocked during startup". Default $HOME; pass --cwd for a project folder.
  local label="" ws="" acct="default" cwd="$HOME" aname="" sname="" model="" effort="" tmo=120000 pmode="auto"
  label="${1:-}"; shift || true
  [ -n "$label" ] || die_usage "start needs a tab label"
  # There is no help flag. A caller probing with --help would otherwise START a session labeled "--help".
  case "$label" in -*) die_usage "start: '$label' looks like a switch, not a tab label — the label is the first argument and there is no --help; the synopsis follows";; esac
  # Tab labels are the at-a-glance map: one word, two max. Warn on 3+, don't block.
  # A trailing 1-2 digit session index ("Notes 02") is not a word — successor lineages number every tab.
  countable="$label"
  case "$countable" in *" "[0-9]|*" "[0-9][0-9]) countable="${countable% *}";; esac
  case "$countable" in *" "*" "*) echo "note: tab label '$label' is 3+ words — keep labels to one word (two max), never the dated session title" >&2;; esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --workspace) ws="$2"; shift 2;;
      --account) acct="$2"; shift 2;;
      --cwd) cwd="$2"; shift 2;;
      --agent-name) aname="$2"; shift 2;;
      --session-name) sname="$2"; shift 2;;   # the session's title, passed to claude as --name
      --model) model="$2"; shift 2;;
      --effort) effort="$2"; shift 2;;
      --permission-mode) pmode="$2"; shift 2;;
      --timeout) tmo="$2"; shift 2;;
      *) die "start: unknown option $1";;
    esac
  done
  check_mode start "$pmode"
  # An unknown account is refused here, before a tab exists, rather than after one is left behind.
  [ "$acct" = default ] || account_dir "$acct" >/dev/null || die "start: unknown account '$acct' — add it to ~/.config/knowledge-worker-stack/accounts.json"
  [ -n "$aname" ] || aname="s$(date +%H%M%S)"
  [[ "$aname" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "agent name '$aname' fails herdr's [a-z][a-z0-9_-]{0,31}"

  local pane tab; read -r pane tab < <(new_tab_pane "$label" "$ws" "$cwd")
  [ -n "$pane" ] && [ -n "$tab" ] || die "tab create returned no pane/tab ($pane/$tab)"
  wait_for_shell "$pane" || { herdr tab close "$tab" >/dev/null 2>&1; die "pane $pane never reached a shell"; }

  if ! export_account "$pane" "$acct"; then
    herdr pane read "$pane" --source visible --lines 10 --format text >&2
    die "start: aborted before launch — the tab is left open at $pane for inspection"
  fi

  local -a extra=(--permission-mode "$pmode")
  [ -n "$sname" ] && extra+=(--name "$sname")
  [ -n "$model" ] && extra+=(--model "$model")
  [ -n "$effort" ] && extra+=(--effort "$effort")

  # agent start races the shell it is supposed to run in and is refused with
  # agent_pane_busy; only that error is retried, every other one stops here.
  local out i
  for i in 1 2 3; do
    out=$(api agent start "$aname" --kind claude --pane "$pane" --timeout "$tmo" -- "${extra[@]}")
    grep -q agent_pane_busy <<<"$out" || break
    sleep 2
  done
  grep -q '"result"' <<<"$out" || die "agent start failed: $out"

  local uuid; uuid=$(printf '%s' "$out" | jget agent.agent_session.value)
  [ -n "$uuid" ] || die "agent started but herdr reports no session id"

  # The SessionStart hook owns the account sidecar. Verify, never write it.
  local got; got=$(sidecar_account "$uuid")
  [ "$got" = "$acct" ] || echo "WARNING: running on '$acct' but ~/.claude/state/state_claude_session_accounts.json says '$got' — cr will resume it on '$got' until that row is fixed" >&2
  [ -n "$model" ] && warn_model "$pane" "$model"   # same soft failure here as on resume

  echo "pane=$pane tab=$(printf '%s' "$out" | jget agent.tab_id) agent=$aname account=$acct uuid=$uuid"
}

# ---------------------------------------------------------------- where a session lives
# Without a record, a resurrect would open its tab in whatever workspace the CALLER is in, so a
# session would come back in a stranger's workspace. herdr cannot answer "where did this session
# live": `agent list` only covers LIVE agents, session.json records a pane's cwd, never its
# session, and the hourly agents backup holds only agents herdr REGISTERED. So the panes are
# recorded here, out of the listing this script already fetches, and read back at resume time.
# A pane id carries its workspace as its prefix (w15:pZ -> w15), so ONE value holds both facts and
# the two can never drift apart.
# HERDR_PANE_STORE redirects that file, and nothing else, so a test can drive the REAL verbs against
# REAL herdr panes without writing your live store. Read by this script alone — herdr itself never
# sees it.
PANE_STORE="${HERDR_PANE_STORE:-$HOME/.claude/state/state_claude_session_last_herdr_pane.json}"

record_panes() {  # merge every live session's pane into the store — best-effort, never fatal
  herdr agent list 2>/dev/null | python3 -c '
import fcntl, json, os, sys
store = sys.argv[1]
# Unguarded on purpose: a listing that is not JSON raises, the caller absorbs it with
# `|| true`, and nothing is written. A try/except here as WELL would be a second mechanism
# for one failure, and the pair makes either one impossible to test by removing it.
agents = json.load(sys.stdin).get("result", {}).get("agents", [])
# One line at the top of the store so a person opening it knows what it is, re-seeded on every
# write. NB this python body is inside a single-quoted python3 -c, so it carries NO apostrophes.
README = "The herdr pane each Claude Code session last occupied, so a session can be found again after it is resumed. Keys are Claude Code session ids; the value is a herdr pane id such as wA:pJ. Written by herdr_session_manage.sh. Safe to delete -- it refills as sessions are seen."
rows = {}
for a in agents:
    u = ((a.get("agent_session") or {}).get("value") or ""); p = a.get("pane_id") or ""
    if len(u) == 36 and ":" in p: rows[u] = p
if not rows: sys.exit(0)
os.makedirs(os.path.dirname(store), exist_ok=True)
with open(store + ".lock", "w") as lk:                 # flock on one lock file beside the store
    fcntl.flock(lk, fcntl.LOCK_EX)
    try: cur = json.load(open(store))
    except Exception: cur = {}
    if not isinstance(cur, dict): cur = {}
    if cur.get("_readme") == README and all(cur.get(k) == v for k, v in rows.items()): sys.exit(0)
    cur.update(rows)                                   # else: new panes, or a header to re-seed
    cur.pop("_readme", None)
    out = {"_readme": README}                          # header FIRST; sort_keys would bury it
    out.update({k: cur[k] for k in sorted(cur)})       # rows still sorted, so diffs stay stable
    tmp = store + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(out, fh, indent=1); fh.write("\n")
    os.replace(tmp, store)                             # replace, never truncate-in-place
' "$PANE_STORE" 2>/dev/null || true
}

recorded_pane() {  # <uuid> -> the pane it last occupied, empty when it was never recorded
  # No 2>/dev/null here, deliberately. The try/except IS the guard against a missing or corrupt
  # store, and a redirect on top of it would swallow the traceback that proves the guard is doing
  # the work — the test would then pass against a copy with the guard removed, which is how a
  # fix with two mechanisms makes its own test unfalsifiable.
  python3 -c '
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
v = d.get(sys.argv[2], "") if isinstance(d, dict) else ""
print(v if isinstance(v, str) else "")' "$PANE_STORE" "$1"
}

# <uuid> -> "<uuid> <number> <title>" for the LATEST member of this session's series, or nothing
# when this session already IS the latest. Ordered by the trailing NUMBER, not by mtime: an old
# member resumed five minutes ago has the newest mtime and is still not the latest.
series_latest() {
  local all lat_uuid lat_num lat_title my_num
  all=$(series_members "$1"); [ -n "$all" ] || return 0
  IFS=$'\t' read -r lat_uuid lat_num lat_title <<<"$(head -1 <<<"$all")"
  [ "$lat_uuid" = "$1" ] && return 0
  # Never hand back something OLDER than what was asked for. A day that restarted the numbering
  # at 01 would otherwise send a caller backwards, and backwards is worse than not redirecting.
  my_num=$(awk -F'\t' -v u="$1" '$1==u{print $2}' <<<"$all")
  [ -n "$my_num" ] && [ "$lat_num" -lt "$my_num" ] && return 0
  printf '%s %s %s' "$lat_uuid" "$lat_num" "$lat_title"
}

grid_row() {  # <uuid>... -> "<row label>\t<cell label>" of the grid row holding any of these sessions, else empty
  # The cell label is the tab label the session last had ("notes 05"); the first uuid given is
  # the one being resumed, so its own cell wins over a sibling's.
  # The grid file (herdr/grid/) is the durable map of where a lineage LIVES; herdr's own workspace
  # list is not, since a restart empties it. A resume that finds no workspace reopens the row by
  # label instead of inventing one named after the uuid. No grid file: this answers nothing.
  python3 - "$@" <<'PYEOF' 2>/dev/null
import json, os, sys
try: d = json.load(open(os.path.expanduser("~/.claude/state/state_claude_session_grid.json")))
except Exception: raise SystemExit(0)
want = set(sys.argv[1:]); me = sys.argv[1] if len(sys.argv) > 1 else ""
for w in d.get("order", []):
    e = d["workspaces"].get(w) or {}
    hits = [c for c in e.get("cells", []) if (c.get("uuid") or "") in want]
    if hits:
        lbl = (e.get("label") or "").strip()
        if lbl and not (len(lbl) == 8 and all(ch in "0123456789abcdef" for ch in lbl)):
            mine = next((c for c in hits if c.get("uuid") == me), None)
            print(lbl + "\t" + ((mine or {}).get("label") or "")); break
PYEOF
}

workspace_by_label() {  # <label> -> a LIVE workspace id carrying it, else empty
  herdr workspace list 2>/dev/null | python3 -c '
import json, sys
w = json.load(sys.stdin).get("result", {}); w = w.get("workspaces", w) if isinstance(w, dict) else w
for x in (w or []):
    if (x.get("label") or "") == sys.argv[1]: print(x.get("workspace_id")); break' "$1" 2>/dev/null
}

workspace_exists() {  # <ws> -> the id back, empty if herdr no longer has it
  herdr workspace list 2>/dev/null | python3 -c '
import json, sys
w = json.load(sys.stdin).get("result", {})
w = w.get("workspaces", w) if isinstance(w, dict) else w
for x in (w or []):
    if x.get("workspace_id") == sys.argv[1]: print(sys.argv[1])' "$1" 2>/dev/null
}

new_workspace() {  # <label> -> "<workspace> <pane> <tab>", all empty on failure: the caller then
  # falls back to herdr's default placement, which is the bug this avoids but beats no resume.
  # A new workspace arrives WITH a root pane already at a shell, so that pane is the one to use —
  # opening a second tab in it would leave an empty tab "1" behind on every resume.
  local out; out=$(api workspace create --label "$1" --no-focus 2>/dev/null) || return 0
  printf '%s %s %s' "$(printf '%s' "$out" | jget workspace.workspace_id)" \
                    "$(printf '%s' "$out" | jget root_pane.pane_id)" \
                    "$(printf '%s' "$out" | jget root_pane.tab_id)"
}

# <uuid> -> the workspace this session's SERIES lives in, empty if none of its members can be
# placed. Used only when the session itself was never recorded: a sibling's workspace is a far
# better guess than the caller's, because a series is worked in one place.
series_workspace() {
  local members m p
  members=$(series_members "$1" | cut -f1 | grep -v "^$1$")
  [ -n "$members" ] || return 0
  for m in $members; do                     # a LIVE sibling is the strongest signal
    p=$(pane_of_uuid "$m"); [ -n "$p" ] && { printf '%s' "${p%%:*}"; return 0; }
  done
  for m in $members; do                     # else the last place any sibling was seen
    # ...if herdr still has that workspace. A recorded pane can name one closed since; returned as-is
    # it would reach tab create and fail with workspace_not_found. Skip it, try the next sibling.
    p=$(recorded_pane "$m"); [ -n "$p" ] && [ -n "$(workspace_exists "${p%%:*}")" ] && { printf '%s' "${p%%:*}"; return 0; }
  done
}

# Claude Code files a transcript under the project folder of the directory the session was
# STARTED in, so a session launched with --cwd lands somewhere else entirely, and a verb that
# assumed one folder would call a delivered message undelivered — which invites a resend and
# double-prompts the session. Every account's config dir is searched, and folders are deduplicated
# on realpath, because a symlinked project folder would otherwise return its transcripts twice.
project_dirs() {
  python3 -c '
import json, os, sys
home = os.path.expanduser("~")
cfgs = [os.path.join(home, ".claude")]
try: acc = json.load(open(os.path.join(home, ".config/knowledge-worker-stack/accounts.json")))
except Exception: acc = {}
if isinstance(acc, dict): cfgs += [os.path.expanduser(v) for v in acc.values() if isinstance(v, str)]
seen, out = set(), []
for cfg in cfgs:
    root = os.path.join(cfg, "projects")
    try: names = sorted(os.listdir(root))
    except OSError: continue
    for name in names:
        # Dot folders belong to sync tools (version stores); a stale copy answering as the live
        # transcript is worse than not finding it at all.
        if name.startswith("."): continue
        p = os.path.join(root, name)
        if not os.path.isdir(p): continue
        r = os.path.realpath(p)
        if r in seen: continue
        seen.add(r); out.append(r)
print("\n".join(out))' 2>/dev/null
}

# <uuid> -> the full path of its transcript, empty and non-zero if none can be named.
# DELEGATES to claude_session_transcript.sh, which cr also calls: the folder rule (every account,
# dot folders skipped, an ambiguous uuid refused rather than guessed) is one implementation on
# purpose, because two copies of it drift. Fail-soft: if that resolver is not on PATH this
# degrades to the first match under ~/.claude/projects rather than breaking every verb here.
transcript_path() {
  local uuid="$1" p
  if command -v claude_session_transcript.sh >/dev/null 2>&1; then
    p=$(claude_session_transcript.sh "$uuid" 2>/dev/null) || return 1
    [ -n "$p" ] || return 1
    printf '%s' "$p"; return 0
  fi
  for p in "$HOME"/.claude/projects/*/"$uuid".jsonl; do
    [ -f "$p" ] && { printf '%s' "$p"; return 0; }
  done
  return 1
}

series_members() {  # <uuid> -> "uuid<TAB>number<TAB>title" per member, highest number first
  python3 -c '
import json, mmap, os, re, sys
uuid, me, bases = sys.argv[1], sys.argv[2], sys.argv[3:]
SPLIT = re.compile(r"^(\d{8}\s+)?((?:⭐|[1-9]️⃣)\s+)?(.*?)(\s+\d{1,3})?(,\s+originally:.*?)?(\s+\d{1,3})?$")   # the number sits LAST, after any ", originally: …" breadcrumb; group 4 reads the older shape
def parts(t):
    m = SPLIT.match(t or ""); n = (m.group(4) or m.group(6) or "").strip()
    return m.group(3).strip(), (int(n) if n else -1)
def title(p):
    if not os.path.getsize(p): return ""
    with open(p, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        pos, needle = len(mm), b"\"custom-title\""
        while True:
            i = mm.rfind(needle, 0, pos)
            if i < 0: return ""
            s = mm.rfind(b"\n", 0, i) + 1
            e = mm.find(b"\n", i)
            try: d = json.loads(mm[s:e if e >= 0 else len(mm)])
            except Exception: d = None
            if isinstance(d, dict) and d.get("type") == "custom-title": return d.get("customTitle", "")
            pos = i
if not me or not os.path.exists(me): raise SystemExit(0)
want, _ = parts(title(me))
if not want: raise SystemExit(0)
# A series is defined by its TITLE, not by where its members were started, so a member filed
# under another project folder is still a member and must be found.
rows, seen = [], set()
for base in bases:
    try: names = os.listdir(base)
    except OSError: continue
    for f in names:
        if not f.endswith(".jsonl") or f[:-6] in seen: continue
        p = os.path.join(base, f)
        try:
            t = title(p); k, n = parts(t)
            if k and k == want: seen.add(f[:-6]); rows.append((n, os.path.getmtime(p), f[:-6], t))
        except Exception: pass
for r in sorted(rows, reverse=True): print(f"{r[2]}\t{r[0]}\t{r[3]}")' "$1" "$(transcript_path "$1")" $(project_dirs) 2>/dev/null
}

# ---------------------------------------------------------------- resume
cmd_resume() {
  local uuid="" pane="" ws="" label="" aname="" tab="" model="" exact=no reuse=yes
  local -a pass=()
  uuid="${1:-}"; shift || true
  [[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || die_usage "resume needs the FULL 36-character session UUID (the transcript's file name under ~/.claude/projects)"
  while [ $# -gt 0 ]; do
    case "$1" in
      --pane) pane="$2"; shift 2;;
      --workspace) ws="$2"; shift 2;;
      --label) label="$2"; shift 2;;
      --agent-name) aname="$2"; shift 2;;
      # Resurrecting an old member of a series is almost always a mistake — the work moved on to
      # the newest one. These two turn the corrections off for the caller who really does mean
      # this session, in this new tab.
      --exact) exact=yes; shift;;
      --new-tab) reuse=no; shift;;
      --model) model="$2"; pass+=(--model "$2"); shift 2;;
      --effort) pass+=(--effort "$2"); shift 2;;
      --permission-mode) check_mode resume "$2"; pass+=(--permission-mode "$2"); shift 2;;
      *) die "resume: unknown option $1";;
    esac
  done
  transcript_path "$uuid" >/dev/null \
    || die "no transcript for $uuid under any Claude Code projects folder — cr would open the picker instead of resuming"

  # Record first: this is the one moment we are certain to be looking at the live listing, and a
  # session about to be resurrected needs its SIBLINGS' panes known, not just its own.
  record_panes

  # A session is resurrected to carry work forward, so the member that holds the work is the one
  # to bring back — not whichever id the caller happened to be holding. A lineage is the sessions
  # sharing one title with a trailing number ("Notes 24", "Notes 25"); /successor numbers them.
  if [ "$exact" = no ] && [ -z "$(pane_of_uuid "$uuid")" ]; then
    local latest lat_uuid lat_num lat_title
    latest=$(series_latest "$uuid")
    if [ -n "$latest" ]; then
      lat_uuid=${latest%% *}; latest=${latest#* }
      lat_num=${latest%% *}; lat_title=${latest#* }
      if [ "$lat_uuid" != "$uuid" ]; then
        local lat_pane; lat_pane=$(pane_of_uuid "$lat_uuid")
        # Already running: there is nothing to resurrect, and starting the older one alongside it
        # splits a series across two live panes. Say where the work is instead.
        [ -n "$lat_pane" ] && die "resume: $uuid is not the latest of its series — '$lat_title' ($lat_num) is ALREADY LIVE in $lat_pane. Send there, or pass --exact to resurrect this older member anyway."
        echo "resume: redirected to the latest of the series — '$lat_title' ($lat_num), $lat_uuid (--exact overrides)" >&2
        uuid="$lat_uuid"
        transcript_path "$uuid" >/dev/null || die "no transcript anywhere for the latest member $uuid"
      fi
    fi
  fi

  # Where it comes back. A caller who named a pane or a workspace has already decided; otherwise
  # the session goes HOME — the pane it last occupied, or at least that pane's workspace. Landing
  # in the caller's workspace is never a fallback: a new workspace is less disorienting than
  # someone else's.
  if [ -z "$pane" ] && [ -z "$ws" ]; then
    local home_pane; home_pane=$(recorded_pane "$uuid")
    if [ -n "$home_pane" ]; then
      local home_cmd; home_cmd=$(pane_shell_cmd "$home_pane")
      case "$home_cmd" in
        # Still there and sitting at a shell: come back in the very pane it died in, scrollback
        # and all. Not a tab WE created, so it is not ours to close if the resume fails.
        ""|claude*) : ;;
        *) if [ "$reuse" = yes ] && [ -z "$(pane_session_uuid "$home_pane")" ]; then
             pane="$home_pane"; echo "resume: reusing $pane, where this session last ran (--new-tab overrides)" >&2
           fi;;
      esac
      [ -z "$pane" ] && ws="${home_pane%%:*}"      # pane gone or busy: at least its workspace
    fi
    # A workspace that has since been closed would send the tab back to herdr's default, which is
    # the CALLER'S workspace — the exact bug this block exists to stop. Check before trusting it.
    [ -n "$ws" ] && [ -z "$(workspace_exists "$ws")" ] && ws=""
    if [ -z "$pane" ] && [ -z "$ws" ]; then
      ws=$(series_workspace "$uuid")               # a live sibling knows where the series lives
      local row_label="" cell_label=""
      if [ -z "$ws" ]; then                        # the grid row of this session or any lineage member
        IFS=$'\t' read -r row_label cell_label <<<"$(grid_row "$uuid" $(series_members "$uuid" | cut -f1))"
        [ -n "$row_label" ] && ws=$(workspace_by_label "$row_label")
        [ -n "$ws" ] && echo "resume: its grid row '$row_label' is live as $ws — going there" >&2
      fi
      if [ -z "$ws" ]; then
        read -r ws pane tab <<<"$(new_workspace "${label:-${row_label:-${uuid:0:8}}}")"
        if [ -n "$pane" ]; then
          if [ -n "$row_label" ]; then echo "resume: reopened its grid row '$row_label' as the new workspace $ws" >&2
          else echo "resume: no record of where this session lived — opened the new workspace $ws for it" >&2; fi
          # The root tab arrives labeled "1"; give it back the label its grid cell had, so the cell reads
          # "notes 05" again rather than "1" (the grid's cell label IS the tab label).
          [ -n "$cell_label" ] && [ -n "$tab" ] && herdr tab rename "$tab" "$cell_label" >/dev/null 2>&1
          # Its root pane is brand new and reports revision 0 until the terminal paints; running
          # cr before then loses the command into a shell that is not listening yet.
          wait_for_shell "$pane" || { herdr tab close "$tab" >/dev/null 2>&1; die "the new workspace's pane $pane never reached a shell"; }
        fi
      fi
    fi
  fi

  if [ -z "$pane" ]; then
    # No caller label: the name its grid cell had, else its title without the date, and only then
    # "resume <sid8>".
    local tab_name="${label:-${cell_label:-}}"
    [ -n "$tab_name" ] || IFS=$'\t' read -r _ tab_name <<<"$(grid_row "$uuid")"
    [[ "$tab_name" =~ ^(resume\ [0-9a-f]{8}|[0-9]+)$ ]] && tab_name=""   # a cell that inherited this placeholder, or a root tab's "1"
    [ -n "$tab_name" ] || tab_name=$(series_members "$uuid" | awk -F'\t' -v u="$uuid" '$1 == u { print $3; exit }' \
                                     | sed -E 's/^[0-9]{8} +//')
    read -r pane tab < <(new_tab_pane "${tab_name:-resume ${uuid:0:8}}" "$ws")
    [ -n "$pane" ] && [ -n "$tab" ] || die "tab create returned no pane/tab ($pane/$tab)"
    wait_for_shell "$pane" || { herdr tab close "$tab" >/dev/null 2>&1; die "pane $pane never reached a shell"; }
  else
    local cmd; cmd=$(pane_shell_cmd "$pane")
    case "$cmd" in claude*) die "pane $pane is already running claude — quit it first";; esac
  fi

  # cr, not agent start -- --resume: cr is the only path that refuses a second live copy of
  # the same session, and it also resolves the session's account and stored title. cr forwards
  # its trailing arguments to claude, so they need only quoting here, because pane run takes one
  # command LINE, not an argv. cr is a script on PATH, so it works in bash and zsh panes.
  local crcmd="cr $uuid" a
  for a in ${pass[@]+"${pass[@]}"}; do crcmd+=" $(printf '%q' "$a")"; done
  # `pane run` TYPES the command, so anything already on that shell's line comes first and the two
  # concatenate: a staged `cr <uuid>` would become `cr <uuid>cr <uuid>`, and cr would open the
  # PICKER instead of resuming. ctrl+u clears the line; the pane has already been proven to be at a
  # shell.
  herdr pane send-keys "$pane" ctrl+u >/dev/null 2>&1
  herdr pane run "$pane" "$crcmd" >/dev/null 2>&1
  local i got="" good=no trusted=no
  for i in $(seq 1 30); do
    sleep 1; got=$(pane_session_uuid "$pane")
    # Trust is per CONFIG DIR, so a session filed outside the shared home that comes back on
    # another account (an account switch) meets claude's "Is this a project you trust?" box and
    # sits there until the poll budget ends. The folder is the session's own recorded launch
    # cwd, already trusted under the account it was born on, so answer it once: Down + Enter.
    if [ "$trusted" = no ] && herdr pane read "$pane" --source visible --lines 12 --format text 2>/dev/null | grep -q 'Yes, I trust this folder'; then
      herdr pane send-keys "$pane" down enter >/dev/null 2>&1; trusted=yes
      echo "resume: answered claude's trust-this-folder box in $pane (the session's own launch dir)" >&2
    fi
    [ "$got" = "$uuid" ] && { good=yes; break; }
  done
  if [ "$good" != yes ]; then
    echo "resume did not take in $pane — the pane says:" >&2
    herdr pane read "$pane" --source visible --lines 12 --format text >&2
    # Close only a tab THIS call created; a caller-supplied --pane is not ours to close.
    [ -n "$tab" ] && herdr tab close "$tab" >/dev/null 2>&1
    exit 1
  fi
  [ -n "$model" ] && warn_model "$pane" "$model"
  if [ -n "$aname" ]; then
    [[ "$aname" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "agent name '$aname' fails herdr's [a-z][a-z0-9_-]{0,31}"
    # A cr resume is screen-detected and unnamed until this rename, and herdr can still be
    # registering the agent when we arrive — so retry, and read the name back rather than
    # trusting the call. Discarding this error is what left a caller's next `herdr agent
    # prompt` failing with agent_not_found against a pane we had already reported as named.
    local j ren
    for j in 1 2 3 4 5; do
      ren=$(api agent rename "$pane" "$aname")
      [ "$(pane_agent_name "$pane")" = "$aname" ] && break
      sleep 1
    done
  fi
  # Report the name herdr actually holds, never the one that was asked for: a caller reads
  # this line to address the agent, so a name we failed to set must not appear here.
  local shown; shown=$(pane_agent_name "$pane")
  if [ -n "$aname" ] && [ "$shown" != "$aname" ]; then
    echo "WARNING: rename to '$aname' did not take in $pane — herdr reports '${shown:-<unnamed>}' and said: $ren" >&2
  fi
  echo "pane=$pane agent=${shown:-<unnamed>} uuid=$got model=$(pane_model "$pane")"
}

# ---------------------------------------------------------------- tell
agent_status_of() {  # <pane> — herdr's own agent_status, the signal the sidebar colors are painted from
  herdr agent list 2>/dev/null | python3 -c '
import json,sys
pid=sys.argv[1]
for a in json.load(sys.stdin).get("result",{}).get("agents",[]):
    if a.get("pane_id")==pid: print(a.get("agent_status") or "")' "$1"
}
pane_of_uuid() {  # <uuid> — the pane a LIVE session occupies, empty if it is not running.
  # Matched on agent_session.value, never on a remembered pane id: a pane addresses a
  # LOCATION, and the next agent started there inherits the same id.
  herdr agent list 2>/dev/null | python3 -c '
import json,sys
u=sys.argv[1]
for a in json.load(sys.stdin).get("result",{}).get("agents",[]):
    if ((a.get("agent_session") or {}).get("value") or "")==u: print(a.get("pane_id") or "")' "$1"
}

# <pane> <timeout-ms> — block until the pane is safe to send into, and print what it settled on.
# herdr agent wait's own exit code is NOT the decider: it can return on a state that has since
# moved on, and a timeout tells you it did not match without saying what the agent is doing
# instead. So wait on the status, then READ THE STATUS BACK and judge that.
wait_ready() {
  local st="" i
  # Looped only while the status comes back EMPTY: a pane whose agent has just registered can
  # answer agent_not_found once and be fine a second later, and those calls fail fast. Any real
  # status breaks out immediately, so a genuinely working agent is waited on once, not five times.
  for i in 1 2 3 4 5; do
    herdr agent wait "$1" --until idle --until done --timeout "$2" >/dev/null 2>&1
    st=$(agent_status_of "$1")
    [ -n "$st" ] && break
    sleep 1
  done
  printf '%s' "$st"
  case "$st" in idle|done) return 0;; *) return 1;; esac
}

cmd_tell() {
  local target="" msg="" tmo=300000 ws="" label="" aname="" may_resume=yes exact=no newtab=no
  target="${1:-}"; shift || true
  msg="${1:-}";    shift || true
  [ -n "$target" ] || die_usage "tell needs a target — a 36-character session UUID, or a pane id like w8:p3"
  [ -n "$msg" ]    || die_usage "tell needs a message; an empty one would submit a bare Enter into the target"
  # The message is POSITIONAL and comes second, so `tell <uuid> --no-resume "the real message"`
  # would send the literal string "--no-resume" and drop the message. Refuse that shape rather
  # than deliver a flag to a session as if it were a sentence.
  case "$msg" in --*) die_usage "tell: the message comes BEFORE the options — '$msg' looks like a flag, and sending it as the message would drop the real one";; esac
  # A prompt that is only `skip` is the user's own command to restart that session in skip mode
  # (restart-in-skip-mode-on-skip.sh). Only the user may give it, so tell never delivers it.
  local bare; bare=$(printf '%s' "$msg" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  [ "$bare" = skip ] && die "tell: refusing to send 'skip' — it would switch the target to skip mode, which only the user may do"
  while [ $# -gt 0 ]; do
    case "$1" in
      # Validated rather than passed through: a non-numeric timeout makes `herdr agent wait`
      # error out instantly, and tell then judges whatever status the target happens to be in
      # right now. That degrades SAFELY — it still never sends into a blocked or working
      # session — but it silently stops waiting, which is not what the flag was asked for.
      --timeout)    tmo="$2"; [[ "$tmo" =~ ^[0-9]+$ ]] || die_usage "tell: --timeout takes milliseconds, got '$tmo'"; shift 2;;
      --workspace)  ws="$2"; shift 2;;
      --label)      label="$2"; shift 2;;
      --agent-name) aname="$2"; shift 2;;
      --no-resume)  may_resume=no; shift;;
      --exact)      exact=yes; shift;;
      --new-tab)    newtab=yes; shift;;
      *) die "tell: unknown option $1";;
    esac
  done

  local uuid="" pane="" resumed=no
  if [[ "$target" =~ ^[0-9a-f-]{36}$ ]]; then
    uuid="$target"; pane=$(pane_of_uuid "$uuid")
  elif [[ "$target" =~ ^[A-Za-z0-9]+:p[A-Za-z0-9]+$ ]]; then
    pane="$target"; uuid=$(pane_session_uuid "$pane")
    # A pane with no live agent cannot be woken from its own id. herdr drops agent_session when
    # an agent exits, so the pane no longer knows what used to run in it, and resuming "whatever
    # was here" would be a guess. The UUID is the only durable handle.
    [ -n "$uuid" ] || die "tell: $pane holds no live session — a pane id names a LOCATION, not a session, so there is nothing here to resume. Pass the session UUID instead."
  else
    die_usage "tell: '$target' is neither a 36-character session UUID nor a pane id like w8:p3"
  fi

  # A message for a series belongs to the member that holds the work, and resurrecting an old
  # member to read it strands the message in a session nobody will open again. Applied ONLY when
  # the addressed session is not running: a LIVE session was addressed deliberately, and a live
  # 24 asking a live 25 something is an ordinary conversation, not a misdirection.
  if [ -z "$pane" ] && [ "$exact" = no ]; then
    local latest lat_uuid lat_num lat_title
    latest=$(series_latest "$uuid")
    if [ -n "$latest" ]; then
      lat_uuid=${latest%% *}; latest=${latest#* }
      lat_num=${latest%% *}; lat_title=${latest#* }
      echo "tell: $uuid is a stopped, older member of its series — delivering to '$lat_title' ($lat_num), $lat_uuid, instead (--exact overrides)" >&2
      uuid="$lat_uuid"; pane=$(pane_of_uuid "$uuid")
    fi
  fi

  # Telling yourself submits a prompt into your own box mid-turn, which arrives as a user
  # message you did not write and cannot decline. Refuse it outright.
  if [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && [ "$uuid" = "$CLAUDE_CODE_SESSION_ID" ]; then
    die "tell: $uuid is THIS session — refusing to inject a prompt into my own input box"
  fi

  if [ -z "$pane" ]; then
    [ "$may_resume" = yes ] || die "tell: session $uuid is not running, and --no-resume was given — nothing was sent"
    # --exact unconditionally: the series was already resolved above, and letting resume resolve
    # it a second time would race a sibling that started in between and redirect twice.
    local -a ra=("$uuid" --exact)
    [ -n "$ws" ]    && ra+=(--workspace "$ws")
    [ -n "$label" ] && ra+=(--label "$label")
    [ -n "$aname" ] && ra+=(--agent-name "$aname")
    [ "$newtab" = yes ] && ra+=(--new-tab)
    # cmd_resume runs in a subshell here, so its own `exit 1` lands on the || rather than
    # taking this process with it. Its diagnostics go to stderr and are left to pass through.
    local rout; rout=$(cmd_resume "${ra[@]}") || die "tell: the resume failed — nothing was sent"
    pane=$(sed -n 's/.*pane=\([^ ]*\).*/\1/p' <<<"$rout")
    local got; got=$(sed -n 's/.*uuid=\([^ ]*\).*/\1/p' <<<"$rout")
    [ -n "$pane" ] || die "tell: the resume reported no pane ($rout) — nothing was sent"
    # Belt and braces: a resume that came back on a DIFFERENT id is the wrong session to deliver to.
    [ "$got" = "$uuid" ] || die "tell: the resume came back on '$got', not $uuid — refusing to send into a different session"
    resumed=yes
  fi

  # The readiness gate. blocked is the one that has to be named rather than waited out: the
  # session is stopped on a question it needs answered, and a message sent into that queues
  # behind the question instead of being read. Queued is not delivered.
  local st rc
  st=$(wait_ready "$pane" "$tmo"); rc=$?
  case "$st" in
    blocked) die "tell: $pane is BLOCKED on a prompt it needs answered — a message sent now would queue behind that question rather than be read. Answer it first; nothing was sent.";;
  esac
  [ "$rc" = 0 ] || die "tell: $pane settled at '${st:-<no live agent>}' rather than idle within ${tmo}ms — nothing was sent"

  # Same box check quit uses, and for the same reason: herdr agent prompt APPENDS to whatever
  # is already in the input box and submits both together, so a send into a pane holding an
  # unsent draft submits your draft for you.
  local draft drc
  draft=$(pane_draft "$pane"); drc=$?
  [ "$drc" = 2 ] && die "tell: cannot read the input box in $pane — refusing to send"
  if [ -n "$draft" ]; then
    # Printed BEFORE anything is touched, so that if every step after this fails the text still
    # exists somewhere the caller can read it back out of.
    # Captured with the FAITHFUL reader, not the detector: what goes back must keep the author's
    # indentation and blank lines. Falls back to the detector's text if that read fails, because
    # a flattened restore still beats losing the text.
    local lifted; lifted=$(pane_draft_raw "$pane") || lifted="$draft"
    [ -n "$lifted" ] || lifted="$draft"
    echo "tell: $pane holds unsent text — lifting it out, sending, then putting it back. Its text:" >&2
    printf '%s\n' "$lifted" >&2
    _TELL_DRAFT_PANE="$pane"; _TELL_DRAFT_TEXT="$lifted"
    trap tell_restore_draft EXIT INT TERM          # armed FIRST: any exit from here puts it back
    if ! pane_clear_box "$pane"; then
      _TELL_DRAFT_PANE=""                          # a restore now would append to text still there
      die "tell: could not empty the input box in $pane — nothing was sent, and the box may hold only part of your text. The whole of it is printed above."
    fi
  fi

  # Baseline the transcript BEFORE the send, so the check below can only match a record written
  # after it. Without this an identical message sent an hour ago would pass for this one.
  #
  # A session that has never taken a turn HAS NO TRANSCRIPT AT ALL. Claude Code writes the file
  # when the first user record is committed, not when the session starts. So an empty path here
  # is normal, before=0 is the right baseline, and the verifier below must RE-RESOLVE the path on
  # every attempt rather than hold this one, or `tell` into a freshly started target would report
  # a false negative every time.
  local tr; tr=$(transcript_path "$uuid" 2>/dev/null) || tr=""
  local before=0; [ -f "$tr" ] && before=$(wc -l < "$tr" | tr -d ' ')

  herdr agent prompt "$pane" "$msg" --wait --until working --timeout 30000 >/dev/null 2>&1

  # Put the lifted text back now rather than at exit: the box is free the moment the prompt is
  # submitted, and the verification below can take time you would spend looking at an input box
  # your words have vanished from.
  tell_restore_draft
  trap - EXIT INT TERM

  # Confirm delivery by reading the TARGET'S TRANSCRIPT, never the return value of the send:
  # a send that returns 0 has proved that herdr accepted a string, not that a session received
  # a prompt. The negative control — the finder run against a one-character mutation — must NOT
  # match, or the finder is blind and its positive means nothing.
  #
  # THREE outcomes, not two. "I could not confirm" is not "it did not arrive", the same
  # distinction `draft` makes with exit 2 meaning "I could not look". Reporting a timeout as a
  # failure invites a resend, and a resend double-prompts a session that has already started
  # acting — the exact harm this check exists to prevent, so that failure mode is worse than
  # having no check. The discriminator is whether ANY new human record exists: none at all means
  # nothing has been written yet and the answer is unknown; one that differs means something
  # arrived and it was wrong.
  local verdict
  verdict=$(TELL_VERIFY_SECONDS="${TELL_VERIFY_SECONDS:-30}" python3 -c '
import hashlib, json, os, subprocess, sys, time
uuid, tr, before, msg = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4].rstrip("\n")
budget = float(os.environ.get("TELL_VERIFY_SECONDS", "30"))
def resolve():
    # Re-resolve rather than trust the path taken before the send: the file may not have existed
    # then. One folder rule, shared with cr.
    global tr
    if tr and os.path.exists(tr): return tr
    try:
        p = subprocess.run(["claude_session_transcript.sh", uuid],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip(): tr = p.stdout.strip()
    except Exception: pass
    return tr
def escape(s): return s.replace("</pasted_content", "<\\/pasted_content").replace("<pasted_content", "<\\pasted_content")   # what Claude Code does to a literal mention of the tag INSIDE a paste; an already-escaped mention is left alone, so the record cannot be unescaped back
def unwrap(t):
    t = t.rstrip("\n")
    if t.lstrip().startswith("<pasted_content ") and "</pasted_content" in t:   # Claude Code 2.1.277+ records a pasted prompt inside this element (the closing tag repeats the id); what was SENT is the text inside
        t = t.lstrip(); t = t[t.index(">") + 1:]; t = t[:t.rfind("</pasted_content")].strip("\n")
    return t
def humans():
    # (record, text) of every prompt the target has READ since the send, and separately of every
    # prompt it has only QUEUED. A prompt typed while the target is mid-turn is not a user record:
    # Claude Code logs a queue-operation enqueue, then hands it to the running turn as a
    # queued_command attachment (read there, never a user record), or submits it as a plain user
    # record when the turn ends. Missing those would make a delivered message read as "did not
    # arrive". The bare enqueue only proves it is waiting, not read.
    p = resolve()
    out, queued = [], []
    if not p: return out, queued
    try: f = open(p, encoding="utf-8")
    except OSError: return out, queued
    for n, line in enumerate(f, 1):
        if n <= before: continue                                 # predates the send, cannot be it
        try: r = json.loads(line)
        except Exception: continue
        a = r.get("attachment") or {}
        if r.get("type") == "attachment" and a.get("type") == "queued_command" and isinstance(a.get("prompt"), str):
            out.append((n, unwrap(a["prompt"]))); continue
        if r.get("type") == "queue-operation" and r.get("operation") == "enqueue" and isinstance(r.get("content"), str):
            queued.append((n, unwrap(r["content"]))); continue
        if r.get("type") != "user" or r.get("isMeta"): continue   # hook-injected context is user-type and isMeta
        c = r.get("message", {}).get("content")
        t = unwrap(c if isinstance(c, str) else "".join(b.get("text", "") for b in c if isinstance(b, dict)))
        if t.startswith("<system-reminder>"): continue
        out.append((n, t))
    return out, queued
h = lambda s: hashlib.md5(s.encode()).hexdigest()
# The socket returns before the file is on disk, and a brand-new target has no file yet, so read
# until the budget runs out. A hit breaks immediately, so a longer budget costs a delivery
# nothing and only ever buys a slow one more room.
t0 = time.time(); cands = []; queued = []; hit = None
while True:
    cands, queued = humans()
    hit = next((n for n, t in cands if t in (msg, escape(msg))), None)   # the SENT text, or the SENT text as the paste layer stores it
    if hit is not None or time.time() - t0 >= budget: break
    time.sleep(0.5)
waited = time.time() - t0
control = msg[:-1] + ("X" if msg[-1:] != "X" else "Y")
ctrl = next((n for n, t in cands + queued if t in (control, escape(control))), None)
inq = next((n for n, t in queued if t in (msg, escape(msg))), None)
# An arrival that is THIS message damaged: cut short (a newline submitted early), run on (a
# draft glued to it), or with its whitespace changed. Anything else is some other prompt — a
# busy target takes them all the time — and proves nothing about this one.
sq = lambda x: " ".join(x.split())
def damaged(t):
    return any(t != m and (m in t or (len(t) >= 20 and m.startswith(t)) or sq(t) == sq(m)) for m in (msg, escape(msg)))
bad = [n for n, t in cands if damaged(t)]
print(f"scanned {len(cands)} new human record(s) past line {before} in {waited:.1f}s of {budget:.0f}s; "
      f"transcript {tr or chr(40)+chr(110)+chr(111)+chr(110)+chr(101)+chr(41)}; sent {len(msg)} chars md5 {h(msg)}")
for n, t in cands: print(f"  record {n}: {len(t)} chars md5 {h(t)}")
for n, t in queued: print(f"  queued {n}: {len(t)} chars md5 {h(t)}")
print(f"EXACT MATCH {hit is not None} at record {hit}")
print(f"negative control found (must be False): {ctrl is not None}")
if ctrl is not None:
    raise SystemExit("VERDICT_BLIND the finder matched a mutated copy of the message, so its positive proves nothing")
if hit is not None:
    print(f"record={hit} md5={h(msg)}"); raise SystemExit(0)
if bad:
    raise SystemExit(f"VERDICT_CORRUPT record {bad[0]} is this message altered, not what was sent")
if inq is not None:
    raise SystemExit(f"VERDICT_UNCONFIRMED queued intact at record {inq}; the target has not read it yet")
raise SystemExit("VERDICT_UNCONFIRMED no record of this message yet (other prompts that arrived are not it)")' \
    "$uuid" "$tr" "$before" "$msg" 2>&1)

  if grep -q '^record=' <<<"$verdict"; then
    echo "pane=$pane uuid=$uuid resumed=$resumed status=$st $(grep '^record=' <<<"$verdict")"
    return 0
  fi
  printf '%s\n' "$verdict" >&2
  if grep -q 'VERDICT_UNCONFIRMED' <<<"$verdict"; then
    # SENT, outcome unknown. Never say "not delivered" here: the send itself did not fail, and a
    # caller that resends on this double-prompts a session that may already be acting on it.
    echo "herdr_session_manage: tell: SENT to $uuid but NOT CONFIRMED within ${TELL_VERIFY_SECONDS:-30}s — the message probably arrived. Read the target's transcript before you even consider resending; a resend double-prompts a session that has already started. Raise TELL_VERIFY_SECONDS to wait longer." >&2
    exit 3
  fi
  die "tell: the message did not arrive intact in $uuid — treat it as NOT delivered"
}

# ---------------------------------------------------------------- move
# "Move this session to the project-a workspace." The TAB is the unit meant by that: a tab holds
# a pane holds a session, so the session arriving without its tab name is not the move asked for.
# herdr cannot do it directly — tab.move carries insert_index and no workspace_id, so a tab never
# leaves the workspace it was born in. The PANE is what moves, and the tab on the far side is a
# NEW one built around it. Everything you would notice — the label, the other panes, the live
# session — is carried by this verb, because herdr carries none of it.

pane_exists() {  # <pane> -> the id back, empty if herdr no longer has it
  herdr pane list 2>/dev/null | python3 -c '
import json,sys
for p in json.load(sys.stdin).get("result",{}).get("panes",[]):
    if p.get("pane_id")==sys.argv[1]: print(sys.argv[1])' "$1" 2>/dev/null
}

self_pane() {  # the pane THIS process runs in, empty if it is not in one
  # HERDR_PANE_ID is exported into a pane when the pane is created and is NEVER rewritten, so a
  # session that has been moved once carries an id that no longer exists. Verify it against the
  # live list before trusting it, then fall back to the agent registry, which is keyed on the
  # session id and cannot go stale. Both paths are kept: the registry has no row for a pane
  # sitting at a plain shell, and the env var is the only answer there.
  local p="${HERDR_PANE_ID:-}"
  if [ -n "$p" ] && [ -n "$(pane_exists "$p")" ]; then printf '%s' "$p"; return 0; fi
  [ -n "${CLAUDE_CODE_SESSION_ID:-}" ] && pane_of_uuid "$CLAUDE_CODE_SESSION_ID"
}

tab_of_pane() {  # <pane> -> the tab holding it
  herdr pane list 2>/dev/null | python3 -c '
import json,sys
for p in json.load(sys.stdin).get("result",{}).get("panes",[]):
    if p.get("pane_id")==sys.argv[1]: print(p.get("tab_id") or "")' "$1" 2>/dev/null
}

tab_label() {  # <tab> -> its label
  herdr tab list 2>/dev/null | python3 -c '
import json,sys
for t in json.load(sys.stdin).get("result",{}).get("tabs",[]):
    if t.get("tab_id")==sys.argv[1]: print(t.get("label") or "")' "$1" 2>/dev/null
}

tab_panes() {  # <tab> -> its pane ids, one per line, in herdr's own order
  herdr pane list 2>/dev/null | python3 -c '
import json,sys
for p in json.load(sys.stdin).get("result",{}).get("panes",[]):
    if p.get("tab_id")==sys.argv[1]: print(p.get("pane_id") or "")' "$1" 2>/dev/null
}

# <text> <kind> -> "OK <id>" or "NONE|AMBIGUOUS <candidates>". One matcher for both workspaces
# and tabs, because people name them the same way and a near-miss must fail the same way too:
# exact label first, then a unique substring, and an ambiguous substring is REFUSED with the
# candidates rather than resolved to whichever came back first. The substring pass exists for
# labels carrying a marker nobody types — "★project-a" is unreachable without it.
match_label() {
  local want="$1" kind="$2"
  herdr "$kind" list 2>/dev/null | python3 -c '
import json,sys
want=sys.argv[1].strip().lower(); kind=sys.argv[2]
key,idk=(("workspaces","workspace_id") if kind=="workspace" else ("tabs","tab_id"))
rows=[(r.get(idk) or "", r.get("label") or "") for r in json.load(sys.stdin).get("result",{}).get(key,[])]
exact=[r for r in rows if r[1].strip().lower()==want]
if len(exact)==1:
    print("OK",exact[0][0]); raise SystemExit
sub=[r for r in rows if want and want in r[1].lower()]
if len(sub)==1:
    print("OK",sub[0][0]); raise SystemExit
print("AMBIGUOUS" if sub else "NONE","; ".join("%s %s"%(i,l) for i,l in (sub or rows)))' "$want" "$kind" 2>/dev/null
}

cmd_move() {
  local -a pos=(); local lbl_override="" focus=no allow_new=no
  while [ $# -gt 0 ]; do
    case "$1" in
      --label)    lbl_override="${2:-}"; shift 2;;
      --focus)    focus=yes; shift;;
      --no-focus) focus=no;  shift;;
      --new)      allow_new=yes; shift;;
      to|into)    shift;;   # so `move this to project-a` reads on the command line as it is said out loud
      -*)         die_usage "move: unknown flag '$1'";;
      *)          pos+=("$1"); shift;;
    esac
  done
  local target dest
  case "${#pos[@]}" in
    1) target=self;       dest="${pos[0]}";;
    2) target="${pos[0]}"; dest="${pos[1]}";;
    *) die_usage "move needs a destination workspace, with an optional target before it: move [<target>] <workspace>";;
  esac

  # ---- resolve the target to a pane, a tab, and whether the WHOLE tab was asked for.
  # A tab named by id or by label moves entire. A session, a pane, or "this" moves that pane
  # alone: a tab can hold two sessions, and "move this session" must not carry off the other.
  local pane="" tab="" whole=no m
  case "$target" in
    self|this|me)
      pane=$(self_pane)
      [ -n "$pane" ] || die "move: this process is not in a herdr pane — HERDR_PANE_ID is '${HERDR_PANE_ID:-unset}' and no live agent row matches session '${CLAUDE_CODE_SESSION_ID:-none}'. Name the target explicitly."
      ;;
    *:p*) pane="$target"; [ -n "$(pane_exists "$pane")" ] || die "move: there is no pane $pane";;
    *:t*) tab="$target"; whole=yes; [ -n "$(tab_label "$tab")" ] || [ -n "$(tab_panes "$tab")" ] || die "move: there is no tab $tab";;
    ????????-????-????-????-????????????)
      pane=$(pane_of_uuid "$target")
      [ -n "$pane" ] || die "move: session $target is not running in any pane, so there is nothing to carry. Resume it first, or name the pane you want moved."
      ;;
    *)  # a tab label, the way people refer to another session: "move the notes tab to project-a"
      m=$(match_label "$target" tab)
      case "$m" in
        OK\ *) tab="${m#OK }"; whole=yes;;
        AMBIGUOUS\ *) die "move: '$target' matches more than one tab — ${m#AMBIGUOUS }";;
        *)     die "move: no tab matches '$target'. Name a tab label, a tab id (wN:tM), a pane id (wN:pM), a 36-character session id, or 'this'.";;
      esac
      ;;
  esac
  [ -n "$tab" ] || tab=$(tab_of_pane "$pane")
  [ -n "$tab" ] || die "move: could not find the tab holding $pane"

  # ---- resolve the destination workspace
  local dst="" dst_label="$dest" make_ws=no
  if [[ "$dest" =~ ^w[0-9A-Za-z]+$ ]] && [ -n "$(workspace_exists "$dest")" ]; then
    dst="$dest"
  else
    m=$(match_label "$dest" workspace)
    case "$m" in
      OK\ *)        dst="${m#OK }";;
      AMBIGUOUS\ *) die "move: '$dest' matches more than one workspace — ${m#AMBIGUOUS }";;
      *)            if [ "$allow_new" = yes ]; then make_ws=yes
                    else die "move: no workspace matches '$dest'. Add --new to make one, or pick from — ${m#NONE }"; fi;;
    esac
  fi

  local src_ws="${tab%%:*}"
  if [ "$make_ws" = no ] && [ "$src_ws" = "$dst" ]; then
    echo "move: $tab is already in workspace $dst — nothing to do"; return 0
  fi

  # ---- what travels
  local -a panes=(); local p
  # A while-read loop rather than mapfile: nothing else in this file uses a bash-4-only
  # builtin, and the discipline is worth more than the line it saves.
  if [ "$whole" = yes ]; then
    while IFS= read -r p; do [ -n "$p" ] && panes+=("$p"); done < <(tab_panes "$tab")
  else panes=("$pane"); fi
  [ "${#panes[@]}" -gt 0 ] || die "move: $tab holds no panes"
  local total; total=$(tab_panes "$tab" | grep -c .)
  local left=$(( total - ${#panes[@]} ))

  local lbl="${lbl_override:-$(tab_label "$tab")}"
  # herdr labels an unnamed tab with its POSITION, so carrying that number across would plant a
  # wrong and confusing number in the destination's own sequence. Only a chosen name travels;
  # anything else is dropped and herdr numbers the arrival itself. herdr never gives a moved tab
  # its old label back, so an empty label here means a numbered tab.
  [[ "$lbl" =~ ^[0-9]+$ ]] && lbl=""

  # Record the sessions BEFORE the move. The one thing worth proving afterwards is that the
  # SAME conversation arrived — a pane appearing at the destination proves only that herdr made
  # a pane, and a restarted claude would look identical in every field except this one.
  local -a was=()
  for p in "${panes[@]}"; do was+=("$(pane_session_uuid "$p")"); done

  # ---- move the first pane, which is what creates the tab on the far side
  local out new_pane new_tab closed_ws
  local -a mv=(pane move "${panes[0]}")
  if [ "$make_ws" = yes ]; then
    mv+=(--new-workspace --label "$dst_label")
    [ -n "$lbl" ] && mv+=(--tab-label "$lbl")
  else
    mv+=(--new-tab --workspace "$dst")
    [ -n "$lbl" ] && mv+=(--label "$lbl")
  fi
  mv+=(--no-focus)     # focus is applied at the END, through workspace focus, for the reason cmd_goto documents
  out=$(api "${mv[@]}") || die "move: herdr refused the move of ${panes[0]}: $out"
  new_pane=$(printf '%s' "$out" | jget move_result.pane.pane_id)
  new_tab=$(printf  '%s' "$out" | jget move_result.created_tab.tab_id)
  closed_ws=$(printf '%s' "$out" | jget move_result.closed_workspace_id)
  [ -n "$new_pane" ] && [ -n "$new_tab" ] || die "move: herdr accepted the move but named no new pane or tab: $out"
  [ -n "$dst" ] || dst="${new_tab%%:*}"

  # ---- the rest of the tab follows into the tab the first pane just made
  # An arithmetic for-loop, NOT seq: macOS seq is the BSD one, and `seq 1 0` COUNTS DOWN and
  # prints "1 0" where GNU seq prints nothing. A single-pane tab would enter the loop and die on
  # an unbound panes[1] after the first pane had already moved — a completed move reported as a
  # failure.
  local i rest_out
  for (( i=1; i<${#panes[@]}; i++ )); do
    rest_out=$(api pane move "${panes[$i]}" --tab "$new_tab" --split right --no-focus) \
      || die "move: ${panes[0]} arrived at $new_tab but ${panes[$i]} was refused, so the tab is now split across two workspaces: $rest_out"
  done

  # ---- verify, rather than trust the call that just returned 0
  local arrived; arrived=$(tab_panes "$new_tab" | grep -c .)
  [ "$arrived" = "${#panes[@]}" ] || die "move: expected ${#panes[@]} pane(s) in $new_tab, herdr reports $arrived"
  local got_lbl; got_lbl=$(tab_label "$new_tab")
  if [ -n "$lbl" ] && [ "$got_lbl" != "$lbl" ]; then
    die "move: the panes arrived in $new_tab but it is labeled '$got_lbl', not '$lbl'"
  fi
  local now; now=$(pane_session_uuid "$new_pane")
  if [ -n "${was[0]}" ] && [ "$now" != "${was[0]}" ]; then
    die "move: $new_tab holds session '${now:-none}', not the '${was[0]}' that set out — the conversation did not ride along"
  fi

  # Focus LAST, and inside a SUBSHELL: cmd_goto calls die on a refused focus, and die exits —
  # which from here aborts this function AFTER the move has already landed, printing no report
  # at all. Exactly the seq-loop failure above wearing a different hat: a completed move
  # reported as a failure. A focus that does not take is worth one line of report; it is never
  # worth losing the result of the move itself.
  local focused=""
  if [ "$focus" = yes ]; then
    if ( cmd_goto "$new_tab" ) >/dev/null 2>&1; then focused=yes; else focused=no; fi
  fi

  # ---- report, including the side effects herdr performed without being asked
  printf 'moved %s pane(s) %s -> %s in workspace %s' "${#panes[@]}" "$tab" "$new_tab" "$dst"
  [ -n "$got_lbl" ] && printf ' labeled "%s"' "$got_lbl"
  [ -n "${was[0]}" ] && printf ' carrying session %s' "${was[0]}"
  printf '\n'
  [ -n "$closed_ws" ] && echo "move: workspace $closed_ws held nothing else and herdr closed it"
  [ "$left" -gt 0 ] && echo "move: $left other pane(s) stayed behind in $tab — name the TAB, not the session, to carry the whole tab"
  [ "$focused" = yes ] && echo "move: focused workspace $dst then tab $new_tab — no flag proves the screen followed, only your eyes"
  [ "$focused" = no ]  && echo "move: the move LANDED, but herdr refused the focus — your screen did not follow it"
  return 0
}

case "${1:-}" in
  start)  shift; cmd_start "$@";;
  resume) shift; cmd_resume "$@";;
  quit)   shift; cmd_quit "$@";;
  draft)  shift; cmd_draft "$@";;
  goto)   shift; cmd_goto "$@";;
  move)   shift; cmd_move "$@";;
  tell)   shift; cmd_tell "$@";;
  ""|-h|--help|help) usage; exit 0;;
  *) die_usage "unknown verb '${1}'";;
esac
