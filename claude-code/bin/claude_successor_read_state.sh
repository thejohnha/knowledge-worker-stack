#!/usr/bin/env bash
# Step 1 of /successor: read the retiring session's own state and write it to a run file that every
# later step sources. Run from INSIDE the Claude Code session being retired (it needs
# CLAUDE_CODE_SESSION_ID, which Claude Code exports into every Bash call).
#
#   claude_successor_read_state.sh
#
# Prints what it derived, and the path of the run file. Nothing here changes anything.
#
# Environment:
#   CLAUDE_CONFIG_DIR   Claude Code's config dir (default ~/.claude)
#   SUCCESSOR_CWD       working directory for the successor (default: the predecessor's own)

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
uuid="${CLAUDE_CODE_SESSION_ID:-}"
[[ "$uuid" =~ ^[0-9a-f-]{36}$ ]] || { echo "no CLAUDE_CODE_SESSION_ID — run this from inside the Claude Code session being retired. Guessing the newest transcript would target another live session, STOP"; exit 1; }
jsonl=$(ls "$CLAUDE_HOME"/projects/*/"$uuid".jsonl 2>/dev/null | head -1)
[[ -f "$jsonl" ]] || { echo "no transcript for $uuid under $CLAUDE_HOME/projects — STOP"; exit 1; }
for c in herdr jq python3; do command -v "$c" >/dev/null 2>&1 || { echo "missing dependency: $c — STOP"; exit 1; }; done
if tail -r /dev/null >/dev/null 2>&1; then revlines() { tail -r "$@"; }; else revlines() { tac "$@"; }; fi   # BSD tail -r, else GNU tac

# A long session's transcript is large, so it is read BACKWARDS from its end, never whole.
title=$(revlines "$jsonl" | jq -r 'select(.type=="custom-title")|.customTitle' | head -1)
cwd=${SUCCESSOR_CWD:-$(revlines "$jsonl" | jq -r 'select(.cwd)|.cwd' | head -1)}
[[ -d "$cwd" ]] || { echo "the successor's working directory \"$cwd\" does not exist — set SUCCESSOR_CWD, STOP"; exit 1; }

# ---- model: the LAST DELIBERATE CHOICE, not whatever is being served right now.
# An automatic fallback (overload, rate limit) can move a session to another model mid-run. Taking
# the SERVED model would convert the whole lineage on one automatic switch, so the successor runs on
# the later of the two deliberate choices — the --model launch flag or a /model the user typed —
# each accepted only if the transcript actually served that model afterwards (--model fails soft).
# With neither, the transcript's FIRST model, which is the original.
txmodel=$(revlines "$jsonl" | jq -r 'select(.type=="assistant")|.message.model // empty' | grep -m1 '^claude-')
firstmodel=$(jq -r 'select(.type=="assistant")|.message.model // empty' "$jsonl" 2>/dev/null | grep -m1 '^claude-')
ownpid=${CLAUDE_PID:-}
if ! kill -0 "${ownpid:-0}" 2>/dev/null; then
  ownpid=
  for f in "$CLAUDE_HOME"/sessions/*.json; do
    [[ -e "$f" ]] || continue; p=${f##*/}; p=${p%.json}
    kill -0 "$p" 2>/dev/null || continue
    [[ "$(jq -r '.sessionId // empty' "$f" 2>/dev/null)" == "$uuid" ]] && { ownpid=$p; break; }
  done
fi
argvmodel=$(ps -ww -o command= -p "${ownpid:-0}" 2>/dev/null | grep -oE '\-\-model [^ ]+' | awk '{print $NF}')
launched=$(ps -o lstart= -p "${ownpid:-0}" 2>/dev/null | sed 's/ *$//')
IFS=$'\t' read -r modelsrc chosen modelnote < <(revlines "$jsonl" | python3 -c '
import sys, json, re, datetime
lstart, argvmodel, firstmodel = (list(sys.argv[1:4]) + ["", "", ""])[:3]
FAM = re.compile(r"(opus|sonnet|haiku|fable)", re.I)
def fam(v):
    m = FAM.search(v or ""); return m.group(1).lower() if m else ""
def iso(ts):
    try: return datetime.datetime.fromisoformat((ts or "").replace("Z", "+00:00")).timestamp()
    except Exception: return None
launchep = None
try: launchep = datetime.datetime.strptime(" ".join(lstart.split()), "%a %b %d %H:%M:%S %Y").astimezone().timestamp()
except Exception: pass
# One backward pass. `served` is the newest model seen so far, so when the newest /model record
# turns up it holds the model served right AFTER it: the proof the choice took.
rxn = re.compile(r"<command-name>/model</command-name>")
rxa = re.compile(r"<command-args>(.*?)</command-args>", re.S)
served = launchmodel = modts = modargs = modserved = ""; found = False
for line in sys.stdin:
    if "\"assistant\"" not in line and "/model" not in line: continue
    try: r = json.loads(line)
    except Exception: continue
    if r.get("type") == "assistant":
        m = r.get("message", {}).get("model", "")
        if not (isinstance(m, str) and m.startswith("claude-")): continue
        served = m
        ep = iso(r.get("timestamp", ""))
        if launchep is not None and ep is not None and ep >= launchep: launchmodel = m
        continue
    if found or r.get("type") != "user" or r.get("isMeta"): continue
    c = r.get("message", {}).get("content")
    if isinstance(c, list): c = "".join(b.get("text", "") for b in c if isinstance(b, dict))
    if not isinstance(c, str) or not rxn.search(c): continue
    a = rxa.search(c); modargs = (a.group(1).strip() if a else "")
    modts, modserved, found = r.get("timestamp", ""), served, True
notes, cands = [], []
if found: cands.append(("model-command", iso(modts) or 0.0, (modargs if fam(modargs) else modserved), modserved))
if argvmodel: cands.append(("launch-flag", launchep if launchep is not None else 0.0, argvmodel, launchmodel or firstmodel))
cands.sort(key=lambda c: -c[1])                    # the LATER deliberate choice wins
src = val = ""
for name, _w, want, proof in cands:
    if not want or not proof: notes.append(f"{name} could not be checked against a served model"); continue
    if fam(want) != fam(proof): notes.append(f"{name} asked for {want} but {proof} was served — it did not take"); continue
    src, val = name, (want if want.startswith("claude-") else proof); break
if not val: src, val = "transcript-original", firstmodel
print("\t".join([src, val, "; ".join(notes)]))' "$launched" "$argvmodel" "$firstmodel")
model=${SUCCESSOR_MODEL:-$chosen}
[[ "$model" == claude-* ]] || { echo "could not resolve a model id (got \"$model\") — --model fails soft, set SUCCESSOR_MODEL, STOP"; exit 1; }
# CLAUDE_EFFORT is this session's RESOLVED effort, exported into every Bash call; settings is the fallback.
effort=${SUCCESSOR_EFFORT:-${CLAUDE_EFFORT:-$(jq -r '.effortLevel // empty' "$CLAUDE_HOME/settings.json" 2>/dev/null)}}
[[ -z "$effort" || " low medium high xhigh max " == *" $effort "* ]] || { echo "effort \"$effort\" is not a level --effort accepts — STOP"; exit 1; }

# ---- where this session lives in herdr
pane=$(herdr agent list | jq -r --arg s "$uuid" '.result.agents[]|select(.agent_session.value==$s)|.pane_id')
[[ "$pane" == *:* ]] || { echo "herdr knows no pane for session $uuid — STOP"; exit 1; }
ws=${pane%%:*}
tab=$(herdr pane list --workspace "$ws" | jq -r --arg p "$pane" '.result.panes[]|select(.pane_id==$p)|.tab_id')
[[ -n "$tab" ]] || { echo "pane $pane is in no tab — STOP"; exit 1; }
tabname=$(herdr tab get "$tab" | jq -r '.result.tab.label')

# ---- permission mode, off the transcript's newest prompt record (Claude Code writes it; the screen
# is not read, since anything printed there can imitate the mode line). auto and accept-edits are
# inherited. Skip mode is NOT: a successor of a skip-mode session starts in auto, and only the user
# can turn skip mode on (by typing `skip` there). Plan mode and anything unreadable become default.
case "$(revlines "$jsonl" | jq -r 'select(.permissionMode)|.permissionMode' 2>/dev/null | head -1)" in
  bypassPermissions|auto) predmode=auto;;
  acceptEdits) predmode=acceptEdits;;
  *) predmode=default;;
esac

# ---- numbering. The index is the title's trailing number: EXACTLY two digits, or a zero-led three.
# Any other trailing number ("July 2026", "error 500") is part of the topic, not an index.
[[ -n "$title" ]] || title="$tabname"
[[ -n "$title" ]] || title=session
titleidx=$(sed -nE 's/^.* (0[0-9]{2}|[0-9]{2})$/\1/p' <<<"$title")
if [[ -n "$titleidx" ]]; then base="${title% *}"; idx="$titleidx"; numbered=yes
else                          base="$title";      idx=01;          numbered=no
fi
next=$(printf '%02d' $((10#$idx + 1)))            # past 99 the series gets a NEW NAME, not a wider number
predtitle=; [[ "$numbered" == no ]] && predtitle="$base $idx"   # the watcher renames it after it quits

# The tab label carries the same number. A bare-number label (herdr's default "1") has no base,
# so the base is the longest non-stopword in the title.
tabbase=$(sed -E 's/ (0[0-9]{2}|[0-9]{2})$//' <<<"$tabname")
if [[ -z "$tabbase" || "$tabbase" =~ ^[0-9]+$ ]]; then
  tabbase=$(printf '%s' "$base" | tr -c 'A-Za-z0-9' '\n' \
    | grep -viE '^(the|a|an|and|or|of|for|from|with|to|in|on|at|by|build|fix|make|add|new|via|its|this|that|into|over|per|use|using|run)$' \
    | awk '{ if (length($NF) > length(m)) m=$NF } END { print tolower(m) }')
  [[ "$tabbase" =~ ^[a-z][a-z0-9]*$ ]] || tabbase=session
fi

# The herdr agent name: whole words from the base, short enough that the sidebar still shows the
# index (a label around 20 characters loses its tail on screen).
short=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | tr -s '-' | sed 's/^-//;s/-$//' \
  | sed -E 's/^([0-9]+-)+//' \
  | awk -F- '{s="";for(i=1;i<=NF;i++){c=(s==""?$i:s"-"$i); if(length(c)>16) break; s=c} print s}')
[[ "$short" =~ ^[a-z][a-z0-9_-]{0,27}$ ]] || short=session

# The run file is SOURCED by every later step, so it lives in a folder only you can write.
rundir=$HOME/.claude/state/state_claude_successor_runs
mkdir -p "$rundir" && chmod 700 "$rundir" || { echo "cannot create $rundir — STOP"; exit 1; }
run=$rundir/${uuid:0:8}
statefile=$run-state.sh
{ echo 'need() { for v; do [[ -n "${!v}" ]] || { echo "$v is empty — Step 1 did not run, STOP"; return 1; }; done; }'
  for v in statefile run uuid jsonl cwd title base idx next numbered predtitle pane ws tab tabname tabbase short \
           txmodel firstmodel argvmodel model modelsrc modelnote effort predmode; do
    printf '%s=%q\n' "$v" "${!v}"
  done
} > "$statefile"

printf 'title        %s\nnumbered     %s (index %s, successor %s)\nsuccessor    "%s %s", tab "%s %s", agent %s-%s\n' \
  "$title" "$numbered" "$idx" "$next" "$base" "$next" "$tabbase" "$next" "$short" "$next"
printf 'pane         %s   tab %s "%s"\ncwd          %s\n' "$pane" "$tab" "$tabname" "$cwd"
printf 'model        %s (via %s; serving now %s)%s\neffort       %s\nmode         %s\n' \
  "$model" "$modelsrc" "$txmodel" "${modelnote:+ — $modelnote}" "${effort:-(default)}" "$predmode"
[[ "$model" == "$txmodel" ]] || echo "NOTE: the transcript is serving $txmodel but the last deliberate choice was $model — the successor takes the choice. Set SUCCESSOR_MODEL to override."
[[ "$numbered" == yes ]] || echo "NOTE: the title has no index — this session becomes \"$predtitle\" once it has quit."
echo "run file     $statefile"
