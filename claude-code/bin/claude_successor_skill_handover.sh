#!/usr/bin/env bash
# Step 5 of /successor, as one command: launch the successor in a new herdr tab, place that
# tab beside the predecessor's, verify the successor was launched as intended, carry the open task
# items, and deliver the first prompt — then prove it arrived.
#
#   claude_successor_skill_handover.sh                     launch, place, verify, carry tasks, deliver
#   claude_successor_skill_handover.sh --dry-run           the same path with every mutation skipped
#   claude_successor_skill_handover.sh --rollback          close a half-built successor after a stop
#   claude_successor_skill_handover.sh --goal '<sentence>' re-arm an inherited /goal in the successor
#
# It is a script rather than blocks in SKILL.md because blocks retyped by hand at every handover
# lose pieces silently, and a guard nobody retypes is a guard. The skill owns every judgment (what
# the first prompt says); this owns the machine work. State comes from the run file that
# claude_successor_read_state.sh wrote; every step re-sources it.

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

dry=no; mode=run; goal=
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  dry=yes; shift ;;
    --rollback) mode=rollback; shift ;;
    --goal)     [ $# -ge 2 ] || { echo "${0##*/}: --goal needs the goal sentence" >&2; usage; }
                mode=goal; goal=$2; shift 2 ;;
    -h|--help)  usage 0 ;;
    *) echo "${0##*/}: unknown argument \"$1\"" >&2; usage ;;
  esac
done
case "$goal" in *"<"*|*">"*) echo "${0##*/}: refusing: the goal is still a placeholder — $goal" >&2; exit 2 ;; esac

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
statefile=$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh
load() { . "$statefile" 2>/dev/null || { echo "no run file at $statefile — run claude_successor_read_state.sh first, STOP"; exit 1; }; }

# Which step a run died on. A stop leaves a tab or a session behind depending on how far it got.
step="startup"
trap 'rc=$?; [ "$rc" -eq 0 ] || printf "%s: STOPPED in %s (exit %s) — nothing after it ran\n" "${0##*/}" "$step" "$rc" >&2' EXIT

successor_jsonl() { ls "$CLAUDE_HOME"/projects/*/"$1".jsonl 2>/dev/null | head -1; }

# ------------------------------------------------------------------ --rollback
if [ "$mode" = rollback ]; then
  step="rollback — close the half-built successor"
  load; need newtabid || exit 1                      # a close with an empty id is not a no-op
  if [ "$dry" = yes ]; then echo "DRY RUN: would close tab $newtabid"; exit 0; fi
  herdr tab close "$newtabid" >/dev/null            # closes the pane and the session in it
  printf 'newtabid=\n' >> "$statefile"
  echo "closed tab $newtabid — the first prompt is still on disk; fix the cause and re-run"
  exit 0
fi

# ------------------------------------------------------------------ --goal
# A raw prompt, not `tell`: a typed slash command lands in the transcript as a command record, not a
# human prompt, so tell's proof would fail on a delivery that worked. Proof is Claude Code's own
# "Goal set: <sentence>" line in the successor's transcript. Reported, never retried: a resend
# lands two goals.
if [ "$mode" = goal ]; then
  step="re-arm the inherited /goal"
  load; need newuuid short next || exit 1
  if [ "$dry" = yes ]; then echo "DRY RUN: would deliver: /goal $goal"; exit 0; fi
  herdr agent prompt "$short-$next" "/goal $goal" >/dev/null
  python3 - "$(successor_jsonl "$newuuid")" "$goal" <<'PY'
import sys, time
jsonl, goal = sys.argv[1], sys.argv[2]
want = f"Goal set: {goal}"
control = want[:-1] + ("X" if want[-1:] != "X" else "Y")
def seen(needle):
    try:
        with open(jsonl, encoding="utf-8") as f: return any(needle in line for line in f)
    except (FileNotFoundError, IsADirectoryError): return False
for _ in range(30):
    if seen(want): break
    time.sleep(1)
else:
    raise SystemExit("no 'Goal set' record after 30s — the goal did NOT arm; do not resend, name it in the closing report")
if seen(control): raise SystemExit("negative control matched — the finder is broken, the goal is UNPROVEN")
print(f"goal re-armed: {goal}")
PY
  exit $?
fi

# ------------------------------------------------------------------ launch
step="launch — create the successor's tab and start claude in it"
load; need ws tabbase next short base model cwd predmode || exit 1
[[ -z "$effort" || " low medium high xhigh max " == *" $effort "* ]] \
  || { echo "\"$effort\" is not a level --effort accepts — it fails soft, STOP"; exit 1; }
[[ -z "$CLAUDE_CODE_EFFORT_LEVEL" ]] \
  || { echo "CLAUDE_CODE_EFFORT_LEVEL=$CLAUDE_CODE_EFFORT_LEVEL is set and silently outranks --effort — unset it and re-run, STOP"; exit 1; }
t_start=$(date +%s)
label="$tabbase $next"
tabs_matching() { herdr tab list --workspace "$ws" | jq -r --arg l "$label" '[.result.tabs[]|select(.label==$l).tab_id]|join(" ")'; }
# The clash check on the LABEL is what makes a re-run safe: it stops before anything is created.
clash=$(tabs_matching)
[[ -z "$clash" ]] || { echo "tab \"$label\" already exists ($clash) — an earlier run got this far; --rollback it or close it, STOP"; exit 1; }
effortflag=(); [[ -n "$effort" ]] && effortflag=(--effort "$effort")
# The successor bills the same account as the predecessor: its row in the account sidecar (no row = default).
acct=$(jq -r --arg s "$uuid" 'if type=="object" then .[$s] // empty else empty end' "$HOME/.claude/state/state_claude_session_accounts.json" 2>/dev/null)
acctflag=(); [[ -n "$acct" ]] && acctflag=(--account "$acct")

if [ "$dry" = yes ]; then
  started="pane=$pane tab=$tab uuid=$uuid"
  echo "DRY RUN: would launch agent $short-$next in tab \"$label\" as \"$base $next\" on $model ${effort:+/$effort} mode $predmode, account ${acct:-default}, cwd $cwd"
else
  started=$(herdr_session_manage.sh start "$label" --workspace "$ws" --cwd "$cwd" \
              --agent-name "$short-$next" --session-name "$base $next" "${acctflag[@]}" \
              --model "$model" "${effortflag[@]}" --permission-mode "$predmode" 2>&1)
fi
printf '%s\n' "$started"
kv() { printf '%s\n' "$started" | tr ' ' '\n' | sed -n "s/^$1=//p" | tail -1; }   # whole tokens only
newpane=$(kv pane); newtabid=$(kv tab); newuuid=$(kv uuid)
if [[ ! "$newuuid" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "the launch reported no session id — STOP"
  for t in $(tabs_matching); do
    herdr tab close "$t" >/dev/null 2>&1 && echo "closed the half-built tab $t — re-run when the cause is fixed"
  done
  exit 1
fi
if [ "$dry" = no ]; then
  printf '%s=%q\n' newpane "$newpane" newtabid "$newtabid" newuuid "$newuuid" t_start "$t_start" t_up "$(date +%s)" >> "$statefile"
fi
echo "successor session $newuuid in $newpane, tab $newtabid"

# ------------------------------------------------------------------ place
# `tab create` always appends. When the predecessor's tab is not last, one socket request moves the
# new tab beside it. herdr has no CLI verb for this; the socket's tab.move is what a drag uses.
# Cosmetic: a failed move is reported and the run carries on.
step="place — move the successor's tab beside the predecessor's"
load
tabs=$(herdr tab list --workspace "$ws")
pos=$(jq  --arg t "$tab" '[.result.tabs[].tab_id]|index($t)' <<<"$tabs")
last=$(jq '(.result.tabs|length) - 1' <<<"$tabs")
[[ "$pos" =~ ^[0-9]+$ ]] || { echo "the predecessor tab $tab is no longer in workspace $ws — STOP"; exit 1; }
if [[ "$pos" -lt $((last - 1)) ]]; then
  if [ "$dry" = yes ]; then echo "DRY RUN: would move tab $newtabid to index $((pos + 1))"
  else
    moved=$(python3 - "$newtabid" "$((pos + 1))" "${HERDR_SOCKET_PATH:-${HERDR_SOCKET:-$HOME/.config/herdr/herdr.sock}}" <<'PY' 2>&1
import json, socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(5)
try: s.connect(sys.argv[3])
except OSError as e: print(json.dumps({"error": f"herdr socket {sys.argv[3]}: {e}"})); raise SystemExit(0)
s.sendall((json.dumps({"id": "mv", "method": "tab.move",
                       "params": {"tab_id": sys.argv[1], "insert_index": int(sys.argv[2])}}) + "\n").encode())
s.shutdown(socket.SHUT_WR)
buf = b""
while b"\n" not in buf:
    chunk = s.recv(65536)
    if not chunk: break
    buf += chunk
print(buf.decode().splitlines()[0] if buf else "{}")
PY
)
    jq -e .result >/dev/null 2>&1 <<<"$moved" || echo "the tab move was refused: $moved — cosmetic, carrying on"
  fi
fi

# ------------------------------------------------------------------ verify
# The flags the successor was launched with, read off its own process, and the permission mode off
# Claude Code's own indicator line. --model, --effort and --permission-mode all fail SOFT, so a
# mismatch here stops the run before the first prompt goes anywhere.
step="verify — check the successor was launched as intended"
load; need newpane model || exit 1
if [ "$dry" = yes ]; then
  echo "DRY RUN: would verify $newpane runs --model $model ${effort:+--effort $effort} --permission-mode $predmode"
else
  argv=""
  for _ in $(seq 1 10); do
    argv=$(herdr pane process-info --pane "$newpane" 2>/dev/null | jq -r '[.result.process_info.foreground_processes[]?|(.cmdline // .argv0 // "")]|join(" ")')
    [[ "$argv" == *--model* ]] && break
    sleep 1
  done
  bad=
  [[ " $argv " == *" --model $model "* ]] || bad="$bad model"
  [[ -z "$effort" || " $argv " == *" --effort $effort "* ]] || bad="$bad effort"
  [[ " $argv " == *" --permission-mode $predmode "* ]] || bad="$bad mode"
  if [[ -n "$bad" ]]; then
    echo "the successor's command line does not carry the intended${bad} — STOP, do not deliver. Run: ${0##*/} --rollback"
    echo "  its command line: ${argv:-(unreadable)}"
    exit 1
  fi
  echo "successor launched with --model $model ${effort:+--effort $effort} --permission-mode $predmode"
fi

# ------------------------------------------------------------------ carry tasks
# Carry the open task-list items so the panel is populated before the first prompt lands. Never
# fatal: a blank panel is a small loss, a stopped handover a large one.
step="carry tasks — copy the open task-list items"
if [ "$dry" = yes ]; then echo "DRY RUN: would carry the open task items"
elif command -v claude_copy_task_list_to_successor.py >/dev/null 2>&1; then
  claude_copy_task_list_to_successor.py "$uuid" "$newuuid" || true
fi

# ------------------------------------------------------------------ carry the prime directive
# If the prime-directive piece is installed and the predecessor has both sentences, the successor
# starts with the same two. Never fatal, and a closed predecessor carries nothing.
step="carry the prime directive"
lin="$HOME/.claude/state/state_claude_session_title_lineage.json"
if command -v claude_session_prime_directive.sh >/dev/null 2>&1 && [ -f "$lin" ]; then
  pd=$(jq -r --arg s "$uuid" '.[$s] | select(type=="object" and (.closed|not)) | .prime_directive // empty' "$lin" 2>/dev/null)
  dw=$(jq -r --arg s "$uuid" '.[$s] | select(type=="object" and (.closed|not)) | .done_when // empty' "$lin" 2>/dev/null)
  if [ -n "$pd" ] && [ -n "$dw" ]; then
    if [ "$dry" = yes ]; then echo "DRY RUN: would carry the prime directive and done_when"
    else claude_session_prime_directive.sh set "$newuuid" "$pd" "$dw" >/dev/null 2>&1 \
           && echo "prime directive carried" || echo "the prime directive did NOT carry — say so in the closing report"
    fi
  fi
fi

# ------------------------------------------------------------------ deliver
step="deliver — send the first prompt and prove it arrived"
load; need short next run || exit 1
firstprompt=$run-first-prompt.md
[[ -s "$firstprompt" ]] || { echo "no first prompt at $firstprompt — STOP"; exit 1; }
# Every section a step fills must have something under it: an empty one reads as "found nothing"
# when it actually means "never ran".
for h in '## SWEEP FINDINGS — unverified, unfixed, and yours to fix' '### CARRY-CHECK — the inherited prompt, item by item'; do
  awk -v h="$h" '$0 == h {f=1; next} /^##/{f=0} f && NF {ok=1} END{exit !ok}' "$firstprompt" \
    || { echo "the first prompt's \"$h\" section is empty or missing — STOP"; exit 1; }
done
fpchars=$(wc -c < "$firstprompt" | tr -d ' ')
if [[ "$fpchars" -gt 10000 ]]; then
  printf 'first prompt: %s chars — past ~10k, replace restatement with pointers to the transcript\n' "$fpchars"
else
  printf 'first prompt: %s chars\n' "$fpchars"
fi
if [ "$dry" = yes ]; then echo "DRY RUN: would deliver the first prompt to $short-$next"; exit 0; fi
delivered=$(herdr agent prompt "$short-$next" "$(cat "$firstprompt")" --wait --until working --timeout 30000)
t_delivered=$(date +%s)
jq -e .result >/dev/null 2>&1 <<<"$delivered" || echo "herdr reported: $delivered — the check below decides"
echo "handover clock: launched in $(( t_up - t_start ))s, first prompt $(( t_delivered - t_up ))s later"

# The proof is the first prompt found, byte for byte, among the human records of the successor's
# own transcript — never the send's exit code. Hook context arrives as user-type records too, so
# every human record is scanned, and a one-character mutation must NOT be found (negative control).
python3 - "$CLAUDE_HOME" "$newuuid" "$firstprompt" "$base $next" <<'PY'
import glob, hashlib, json, os, sys, time
home, sid, fp, want_title = sys.argv[1:5]
firstprompt = open(fp, encoding="utf-8").read().rstrip("\n")
def escape(s): return s.replace("</pasted_content", "<\\/pasted_content").replace("<pasted_content", "<\\pasted_content")
def records():
    for p in glob.glob(os.path.join(home, "projects", "*", sid + ".jsonl")):
        with open(p, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                try: yield n, json.loads(line)
                except Exception: continue
def humans():
    out = []
    for n, r in records():
        if r.get("type") != "user" or r.get("isMeta"): continue
        c = r.get("message", {}).get("content")
        t = (c if isinstance(c, str) else "".join(b.get("text", "") for b in c if isinstance(b, dict))).rstrip("\n")
        if t.startswith("<system-reminder>"): continue
        if t.lstrip().startswith("<pasted_content ") and "</pasted_content" in t:   # a long prompt is recorded as a paste
            t = t.lstrip(); t = t[t.index(">") + 1:]; t = t[:t.rfind("</pasted_content")].strip("\n")
        out.append((n, t))
    return out
for attempt in range(21):                           # the send returns before the file is on disk
    cands = humans()
    if cands: break
    time.sleep(0.5)
else:
    raise SystemExit("no human messages in the successor's transcript after 10s — nothing was delivered, STOP")
h = lambda s: hashlib.md5(s.encode()).hexdigest()
control = firstprompt[:-1] + ("X" if firstprompt[-1:] != "X" else "Y")
hit  = next((n for n, t in cands if t in (firstprompt, escape(firstprompt))), None)
ctrl = next((n for n, t in cands if t in (control, escape(control))), None)
print(f"first prompt {len(firstprompt)} chars {h(firstprompt)}: EXACT MATCH {hit is not None} at record {hit}; negative control found (must be False): {ctrl is not None}")
if hit is None or ctrl is not None:
    raise SystemExit("the first prompt did not arrive intact — STOP")
titles = [r.get("customTitle") for _, r in records() if r.get("type") == "custom-title"]
print(f"successor title: {titles[-1] if titles else '(none recorded yet)'}" + ("" if titles and titles[-1] == want_title else f" — expected \"{want_title}\"; set it with /rename in the successor"))
PY
