#!/usr/bin/env bash
# UserPromptSubmit hook: keep Claude Code's session title prefixed with YYYYMMDD.
# Uses Claude Code's official hookSpecificOutput.sessionTitle field (same code
# path as /rename — updates jsonl + in-memory + UI emit).
#
# Behavior:
# - Brand-new session, no custom-title: stamp today's date + Claude Code's own
#   auto-title (ai-title).
# - Subsequent turns: keep the locked date, track ai-title's latest description.
# - Pre-existing custom-title on first encounter: mark overridden, never touch.
# - Latest custom-title differs from `last_written`: user /renamed, mark
#   overridden, never touch.
# - `pending_title` field (staged by the /retitle skill): apply unconditionally,
#   lock the description (description_locked=true) so subsequent turns don't
#   revert to the stale ai-title.
# - description_locked sessions: re-emit `last_written` every turn to win the
#   agent-name race (Claude Code re-derives agent-name from ai-title each turn
#   and would otherwise bury the locked title).
# - Priority marker (⭐/☑️/N️⃣): any marker in the current title is re-inserted
#   just after the date on every rewrite (auto-title or /retitle), so a marker
#   isn't silently dropped. A cleared marker stays cleared.
# - Category (optional): with ~/.config/knowledge-worker-stack/session-categories.txt in
#   place, an auto-titled session reads `YYYYMMDD <Category> <ai-title>`. Haiku is
#   asked ONCE per session, detached so the turn never waits (~1s, ~600 tokens,
#   no hooks or CLAUDE.md); the answer lands in `category` and shows from the
#   next turn. A failed ask is retried after 10 minutes; an answer off the list
#   is stored as `none` and the title stays bare. No file = no category, no ask.
#   File format, one per line:  WORD - what belongs there
#
# State: ~/.claude/state/state_claude_session_titles.json — dict keyed by session UUID.
# Cross-session writes serialized via mkdir lock, which SELF-HEALS: a lock older
# than 30s is treated as orphaned (its holder was killed before its trap ran)
# and removed.
#
# JSON: python3 only, no jq. The JSON work is BATCHED into three interpreter
# starts on a steady-state turn (read, scan-parse, cache write) because each
# python3 start costs ~15ms; one start per JSON operation would be ~16 a turn
# and would put real pressure on the 5s hook budget. Do NOT un-batch it.
#
# Budget: UserPromptSubmit hooks get 5s, and a long session's jsonl can reach
# hundreds of MB. Reading it whole each turn blows that twice over. So the transcript is
# scanned INCREMENTALLY: the jsonl is append-only, so each turn reads only the
# bytes added since last turn (scan_offset) through one grep, falling back to
# the cached values when the new slice holds no title event. Cost per turn is
# then independent of session size. Only the first encounter with a session
# pays a full read — required, because concluding "this session has no
# custom-title" (i.e. the user never /renamed it) is the one question a
# tail-scan cannot answer, and getting it wrong would let the hook overwrite a
# title the user set by hand.

set -euo pipefail

state_file="$HOME/.claude/state/state_claude_session_titles.json"
state_lock="$state_file.lock"

input=$(cat)

# The category ask below runs `claude -p`; never let that child title itself.
[[ -n "${DATE_PREFIX_TITLE_CLASSIFYING:-}" ]] && exit 0

# Fail-soft rather than exit 127: python3 is the only external dependency.
# Absent, the hook does nothing and the prompt still goes through, instead of
# printing a not-found line into the terminal on every single turn.
command -v python3 >/dev/null 2>&1 || exit 0

# One python3 pass for the hook's stdin JSON AND this session's state row.
# Fields come back NUL-terminated in a fixed
# order: NUL is the one byte a JSON string cannot contain, so a title carrying a
# newline can never desync the reads. A missing or unparseable state file reads
# as {}, exactly as the freshly-seeded '{}' below would. The trailing `|| true`
# suspends set -e across the whole group (verified on bash 3.2 and 5.3), so a
# python3 that dies leaves every field empty and the guard below exits 0 instead
# of aborting the hook halfway. scan_offset is coerced to an int HERE, because a
# poisoned value reaching (( )) below reads as an unset name and kills the shell
# under set -u.
{
  IFS= read -r -d '' session_id
  IFS= read -r -d '' transcript
  IFS= read -r -d '' pending_title
  IFS= read -r -d '' overridden
  IFS= read -r -d '' description_locked
  IFS= read -r -d '' locked_date
  IFS= read -r -d '' last_written
  IFS= read -r -d '' scan_offset
  IFS= read -r -d '' cached_ai
  IFS= read -r -d '' cached_custom
  IFS= read -r -d '' category
  IFS= read -r -d '' category_asked
  IFS= read -r -d '' prompt
} < <(python3 -c '
import json, sys
h = json.load(sys.stdin)
if not isinstance(h, dict): h = {}
sid = h.get("session_id") or ""
try:
    with open(sys.argv[1]) as f: st = json.load(f)
except Exception: st = {}
row = st.get(sid) if isinstance(st, dict) else None
if not isinstance(row, dict): row = {}
def s(v):   # jq -r with `// empty`: null and false render empty, strings raw
    return "" if v is None or v is False else (v if isinstance(v, str) else json.dumps(v))
def b(v):   # jq `// false`: downstream only ever tests against the literal "true"
    return "true" if v is True else "false"
off = row.get("scan_offset", 0)
if isinstance(off, bool) or not isinstance(off, int): off = 0
sys.stdout.write("".join(x + "\0" for x in [
    sid, h.get("transcript_path") or "", s(row.get("pending_title")),
    b(row.get("overridden")), b(row.get("description_locked")),
    s(row.get("locked_date")), s(row.get("last_written")), str(off),
    s(row.get("cached_ai")), s(row.get("cached_custom")),
    s(row.get("category")), s(row.get("category_asked")),
    s(h.get("prompt"))[:1500].replace("\0", "")]))   # a decoded \u0000 would desync the reads
' "$state_file" <<<"$input") || true

# A missing transcript is NOT an exit: on a new session's first prompt Claude Code
# has not written the file yet, and that turn must still start the category ask.
# Every read below already treats a missing file as empty.
[[ -z "$session_id" || -z "$transcript" ]] && exit 0

mkdir -p "$(dirname "$state_file")"
[[ -f "$state_file" ]] || echo '{}' > "$state_file"

# The lock covers WRITES only. Reads need none: every filter below touches just
# this session's own key, and only this process writes that key — so a read can
# never be stale in a way that matters, and keeping the transcript scan outside
# the lock keeps the held window at a few milliseconds. Holding it across the
# scan instead lets concurrent sessions starve each other out of their title
# update.
lock_is_orphaned() {
  local mtime now
  # GNU form FIRST here and at $size below — do not tidy it back to BSD-first.
  # BSD stat has no -c at all, so it fails cleanly and the fallback takes over.
  # GNU stat ACCEPTS -f (= --file-system, which takes no format arg), so a
  # BSD-first probe prints a block-usage blob for the file, exits 1 on the format
  # operand, and the fallback appends the real number AFTER it. The capture is
  # then blob+newline+value, and the next (( )) dies on `File: unbound variable`.
  mtime=$(stat -c %Y "$state_lock" 2>/dev/null || stat -f %m "$state_lock" 2>/dev/null || true)
  if [[ -z "$mtime" ]]; then return 1; fi
  now=$(date +%s)
  (( now - mtime > 30 ))
}

# Orphan recovery: a holder killed before its trap ran would otherwise strand
# the lock forever, and every later run would burn the whole retry loop.
with_lock() {
  local i
  for ((i = 0; i < ${lock_attempts:-20}; i++)); do
    if mkdir "$state_lock" 2>/dev/null; then
      local rc=0
      "$@" || rc=$?   # plain `"$@"` would trip set -e and skip the release below
      rmdir "$state_lock" 2>/dev/null || true
      return $rc
    fi
    if lock_is_orphaned; then rmdir "$state_lock" 2>/dev/null || true; continue; fi
    sleep 0.05
  done
  return 1   # contended: skip this write, fail-open. Next turn re-derives it.
}

size=$(stat -c %s "$transcript" 2>/dev/null || stat -f %z "$transcript" 2>/dev/null || echo 0)
# Same (( )) hazard as scan_offset above: a probe that returns anything but
# digits must fail closed to 0, not be handed to arithmetic.
case "$size" in ''|*[!0-9]*) size=0 ;; esac
# Shrunk = not the file we scanned (rotation, compaction, a reused path): the
# cached values may belong to another session's content, so start clean.
if (( scan_offset > size )); then scan_offset=0; cached_ai=""; cached_custom=""; fi

# Hard ceiling on how much any single turn reads. `tail -c +N` does seek, so the
# skipped prefix is free, but tail then pushes the bytes it DOES emit at only
# ~20MB/s of CPU — so the window, not the offset, is what has to be bounded.
# Without a cap a never-before-seen multi-hundred-MB session (or a multi-MB delta arriving
# at once from a file sync) can exceed the hook timeout, and a timed-out run is
# KILLED before it can checkpoint: the next turn rescans the same bytes and dies
# the same way, wedging that session's title permanently. Only the newest
# title event matters, so the tail of the window is always the answer — except
# for one question, "does this session have NO custom-title", which only arises
# on a first encounter. A session born after this hook was installed starts
# small and is tracked from turn 1, so it never arrives here needing a big read;
# an older session over 4MB is judged on its last 4MB only.
max_read=$((4 * 1024 * 1024))
if (( size - scan_offset > max_read )); then scan_offset=$((size - max_read)); fi

# One pass over just the new bytes. grep is a cheap superset filter; the python3
# pass below does the authoritative type check, so the prefilter cannot change
# the answer. -a keeps a stray NUL byte from making grep treat the jsonl binary.
new_lines=$(tail -c "+$((scan_offset + 1))" "$transcript" 2>/dev/null \
  | grep -aE '"(ai-title|custom-title)"' || true)
# Second and last batched pass: both title kinds out of one interpreter start,
# last-one-wins (what the old `| tail -1` did). A line that is not an object, or
# whose title field is not a string, is skipped rather than yielding jq's literal
# "null" — a non-string title could only ever be a corrupt event.
{
  IFS= read -r -d '' new_ai
  IFS= read -r -d '' new_custom
} < <(python3 -c '
import json, sys
ai = cu = ""
for line in sys.stdin:
    try: o = json.loads(line)
    except Exception: continue
    if not isinstance(o, dict): continue
    t, k = o.get("type"), None
    if t == "ai-title": k = "aiTitle"
    elif t == "custom-title": k = "customTitle"
    if k is None or not isinstance(o.get(k), str): continue
    if t == "ai-title": ai = o[k]
    else: cu = o[k]
sys.stdout.write(ai + "\0" + cu + "\0")
' <<<"$new_lines") || true

ai_title=${new_ai:-$cached_ai}
latest_custom=${new_custom:-$cached_custom}

# Claude Code disambiguates a session whose name collides with another LIVE
# session's by appending "-word-word" to the title — it says so in an
# informational line ("…so this session is now …-rustling-riddle") and then
# persists the suffixed string into BOTH the agent-name AND the custom-title
# events, once per title write, for the life of the process. Read straight back
# that is indistinguishable from a hand /rename, so the hook marks the session
# overridden and stops maintaining its title while the suffix stays on screen.
# Peel trailing lowercase hyphen-words off until
# what is left is a string this hook knows it wrote; keep the value whole if
# none matches, so a real title that merely ENDS in a hyphenated word ("… +
# pre-commit-hook") is never truncated. Pure bash — no fork, no budget cost.
clean_title=""
name_suffix=""
strip_name_suffix() {
  local t="$1" ref="$2" base="$1"
  clean_title="$t"
  if [[ -n "$ref" && "$t" != "$ref" ]]; then
    while [[ "$base" =~ ^(.+)-[a-z]+$ ]]; do
      base="${BASH_REMATCH[1]}"
      if [[ "$base" == "$ref" ]]; then clean_title="$base"; name_suffix="${t#"$base"}"; break; fi
    done
  fi
}
strip_name_suffix "$latest_custom" "$last_written"
latest_custom="$clean_title"
# A suffix proven to be Claude Code's own is stripped off the inbound titles too,
# so it can never be propagated back out: /retitle composes pending_title from
# the title on screen, which carries it. Exact-string removal, never a pattern.
if [[ -n "$name_suffix" ]]; then
  ai_title="${ai_title%"$name_suffix"}"
  pending_title="${pending_title%"$name_suffix"}"
fi

# Advance only when the file ends on a newline — mid-append, the tail of the
# file is a partial line, and resuming past it next turn would lose that event.
# ($() strips the trailing newline, so a clean ending reads as empty.)
if [[ -z "$(tail -c 1 "$transcript" 2>/dev/null)" ]]; then new_offset=$size; else new_offset=$scan_offset; fi

# Called as: rewrite_state replace|merge key=value ...
# `replace` sets this session's key to exactly these fields (what `.[$s] = {…}`
# did); `merge` adds them over whatever is already there (`(.[$s] // {}) + {…}`).
# Values arrive as flat strings, so the JSON type comes from the state schema
# itself rather than from each call site — the only three non-string fields are
# listed once, in the writer, beside the shape the header documents.
rewrite_state() {
  local tmp
  tmp=$(mktemp "$state_file.XXXXXX") || return 1
  # python3 re-reads the file here, inside the lock, so a sibling session's key
  # that landed since our unlocked read is carried through rather than clobbered.
  # Key order matches jq's: existing keys hold their position, new ones append.
  if python3 -c '
import json, sys
NONSTR = {"overridden": "bool", "description_locked": "bool", "scan_offset": "int"}
# One line at the top of the store so a person opening it knows what it is, re-seeded on
# every write. NB this python body is inside a single-quoted python3 -c, so it carries NO
# apostrophes.
README = "The title of each Claude Code session, and the state the titling hook needs to keep it. Keys are Claude Code session ids; field last_written is the title the session currently shows. Written by ~/.claude/hooks/date-prefix-title.sh on every turn, and rewritten by /retitle. Safe to delete: the hook starts over, at the cost of one full transcript read per session."
path, sid, mode = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f: st = json.load(f)
except Exception: st = {}
if not isinstance(st, dict): st = {}
row = {}
for kv in sys.argv[4:]:
    k, _, v = kv.partition("=")
    kind = NONSTR.get(k)
    row[k] = (v == "true") if kind == "bool" else (int(v) if kind == "int" else v)
old = st.get(sid)
old = old if isinstance(old, dict) else {}
if mode == "merge":
    row = dict(old, **row)
else:   # the detached category ask writes these at any moment, so no replace may drop them
    for k in ("category", "category_asked"):
        if k in old and k not in row: row[k] = old[k]
st[sid] = row
st.pop("_readme", None)
st = {"_readme": README, **st}                          # header FIRST; a plain assignment appends it last
sys.stdout.write(json.dumps(st, ensure_ascii=False, indent=2) + "\n")
' "$state_file" "$session_id" "$@" > "$tmp" 2>/dev/null; then mv "$tmp" "$state_file"
  else rm -f "$tmp"; return 1; fi
}

# Never propagates failure: a title update lost to contention is a skipped turn,
# not a reason to abort the hook (fail-open — the prompt always goes through).
write_state() { with_lock rewrite_state "$@" || true; }

# Runs on EVERY exit path, merged into whatever the main logic wrote, so the
# next turn resumes from here instead of re-reading the whole transcript.
# Losing the race here costs only one rescan next turn, so it waits briefly and
# gives up — two full-patience waits in one run could otherwise approach budget.
save_scan_cache() {
  local lock_attempts=5
  write_state merge "scan_offset=$new_offset" \
    "cached_ai=$ai_title" "cached_custom=$latest_custom" || true
}
trap save_scan_cache EXIT

emit_session_title() {
  python3 -c '
import json, sys
sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName":
    "UserPromptSubmit", "sessionTitle": sys.argv[1]}},
    ensure_ascii=False, separators=(",", ":")) + "\n")
' "$1"
}

# Re-insert a priority marker (⭐ or N️⃣) from $2 (the session's current title)
# into $1 (the title about to be written), just after the YYYYMMDD date — so a
# marker isn't silently dropped when auto-titling or /retitle rewrites the
# title. No-op when the current title has no marker (or the new one
# already carries one), so a marker the user *cleared* is never re-added.
preserve_priority_marker() {
  local new="$1" src="$2" marker
  if printf '%s' "$new" | grep -qE '(⭐|☑️|[1-9]️⃣)'; then printf '%s' "$new"; return; fi
  marker=$(printf '%s' "$src" | grep -oE '(⭐|☑️|[1-9]️⃣)' | head -1 || true)
  if [[ -z "$marker" ]]; then printf '%s' "$new"; return; fi
  if [[ "$new" =~ ^([0-9]{8}\ )(.*)$ ]]; then
    printf '%s %s' "${BASH_REMATCH[1]}${marker}" "${BASH_REMATCH[2]}"
  else
    printf '%s %s' "$marker" "$new"
  fi
}

# /retitle skill staged a new title — explicit user action, always honored,
# locks the description so the stale ai-title can't revert it.
if [[ -n "$pending_title" ]]; then
  [[ -z "$locked_date" ]] && locked_date="$(date +%Y%m%d)"
  new_title="$locked_date $pending_title"
  new_title=$(preserve_priority_marker "$new_title" "$latest_custom")
  emit_session_title "$new_title"
  write_state replace "locked_date=$locked_date" "last_written=$new_title" \
    "overridden=false" "description_locked=true"
  exit 0
fi

[[ "$overridden" == "true" ]] && exit 0

# description_locked: keep emitting last_written so the agent-name stays the
# locked title each turn. Still detect /rename to back off.
if [[ "$description_locked" == "true" && -n "$last_written" ]]; then
  if [[ -n "$latest_custom" && "$latest_custom" != "$last_written" ]]; then
    write_state replace "overridden=true"
    exit 0
  fi
  emit_session_title "$last_written"
  exit 0
fi

# A custom title this hook did not write is a hand /rename (or a title the session
# already had on first encounter): from here on the title is the user's.
if [[ -n "$latest_custom" && "$latest_custom" != "$last_written" ]]; then
  write_state replace "overridden=true"
  exit 0
fi

# Optional category list. No file (or no valid line) = no category and no Haiku ask.
# A line is `WORD - what belongs there`; WORD is letters, digits, underscore or
# hyphen. The LAST word is the fallback answer when nothing fits.
CATEGORY_FILE="$HOME/.config/knowledge-worker-stack/session-categories.txt"
CATEGORIES=""
[[ -s "$CATEGORY_FILE" ]] && CATEGORIES=$(sed -nE 's/^[[:space:]]*([A-Za-z0-9_-]+)[[:space:]]+-[[:space:]].*/\1/p' "$CATEGORY_FILE" | tr '\n' ' ')
CATEGORIES=${CATEGORIES% }

# Asked on the first prompt, before any ai-title exists, so a new session's title
# carries its category from the turn it first appears.
ask_category() {
  local now token
  [[ -z "$CATEGORIES" ]] && return 0
  [[ -n "$category" ]] && return 0
  now=$(date +%s)
  case "$category_asked" in ''|*[!0-9]*) ;; *) (( now - category_asked < 600 )) && return 0 ;; esac
  command -v claude >/dev/null 2>&1 || return 0
  # The session's own sign-in token if it has one; otherwise `claude -p` uses its normal login.
  token=${CLAUDE_CODE_OAUTH_TOKEN:-}
  if [[ -z "$token" && -s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.oauth_token" ]]; then
    token=$(cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.oauth_token")
  fi
  write_state merge "category_asked=$now"
  # Detached with every fd off the hook's pipes, so Claude Code does not wait on it.
  ( trap - EXIT
    [[ -n "$token" ]] && export CLAUDE_CODE_OAUTH_TOKEN="$token"
    answer=$(DATE_PREFIX_TITLE_CLASSIFYING=1 python3 -c '
import json, os, subprocess, sys
transcript, ai_title, prompt, cats, catfile = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(), sys.argv[5]
first = ""
try:
    with open(transcript, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i > 400: break
            try: o = json.loads(line)
            except Exception: continue
            if not isinstance(o, dict) or o.get("type") != "user" or o.get("isMeta"): continue
            c = (o.get("message") or {}).get("content")
            if isinstance(c, list): c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                first = c; break
except OSError: pass
lines = []
try:
    with open(catfile, encoding="utf-8") as f:
        lines = [l.strip() for l in f if l.split(None, 1) and l.split(None, 1)[0] in cats]
except OSError: pass
ask = "Categories, one per line as WORD - what belongs there:\n" + "\n".join(lines) + \
    "\nIf nothing fits, answer " + cats[-1] + ".\n\n" + """Session title: """ + (ai_title or "(not named yet)") + "\nFirst message:\n" + (first or prompt)[:1500]
try:
    r = subprocess.run(["claude", "-p", "--model", "haiku", "--no-session-persistence",
        "--setting-sources", "", "--tools", "", "--output-format", "json", "--system-prompt",
        "You file a work session under one category. Reply with the category word only."],
        input=ask, capture_output=True, text=True, timeout=90, cwd=os.environ.get("TMPDIR") or "/tmp")
    d = json.loads(r.stdout)
except Exception: sys.exit(1)
if r.returncode or not isinstance(d, dict) or d.get("is_error") or not isinstance(d.get("result"), str):
    sys.exit(1)   # e.g. Not logged in: no answer stored, so it is asked again in 10 minutes
words = d["result"].replace("*", " ").replace(".", " ").split()
pick = {c.lower(): c for c in cats}.get(words[0].lower() if words else "")
print(pick or "none")
' "$transcript" "$ai_title" "$prompt" "$CATEGORIES" "$CATEGORY_FILE") || exit 0
    [[ -n "$answer" ]] && write_state merge "category=$answer"
  ) </dev/null >/dev/null 2>&1 &
}
ask_category

[[ -z "$ai_title" ]] && exit 0
[[ -z "$last_written" ]] && locked_date="$(date +%Y%m%d)"

# Category word first; a title Haiku already opened with that word is not doubled.
with_category() {
  local t="$1" first match=0
  [[ -n "$CATEGORIES" && -n "$category" ]] || { printf '%s' "$t"; return; }
  case " $CATEGORIES " in *" $category "*) ;; *) printf '%s' "$t"; return ;; esac
  first=${t%% *}
  shopt -s nocasematch; [[ "$first" == "$category" ]] && match=1; shopt -u nocasematch
  if (( match )); then t=${t#"$first"}; t=${t# }; fi
  if [[ -n "$t" ]]; then printf '%s %s' "$category" "$t"; else printf '%s' "$category"; fi
}

new_title="$locked_date $(with_category "$ai_title")"
new_title=$(preserve_priority_marker "$new_title" "$latest_custom")

if [[ "$new_title" != "$last_written" ]]; then
  emit_session_title "$new_title"
  write_state replace "locked_date=$locked_date" "last_written=$new_title" "overridden=false"
fi
