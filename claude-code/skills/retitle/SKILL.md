---
name: retitle
description: Curate the current session's title — lead with the current topic, preserve a lineage breadcrumb of where it started and the steps between, and keep the category tag. Use when the user says "retitle", "rename this session", "fix the title", "the title is wrong", "the topic changed/drifted", or wants the session marked as vetted with a better description.
---

`/retitle` gives the current session a curated title that (1) leads with the **current topic**, (2) preserves a **lineage breadcrumb** of where the session started and how it got here, and (3) keeps the session's **category tag**, if categories are set up. The date-prefix hook prepends the date automatically, so the displayed result is:

```text
20261028 project-a recipe card layout, originally: family cookbook, then: photo scans 03
└ date ┘ └  cat  ┘ └    current     ┘              └    birth    ┘        └ middle  ┘ └ index, always LAST ┘
```

The index is the `/successor` lineage number; a session that was never handed over has none.

The lineage is stored as **structured data** in `~/.claude/state/state_claude_session_title_lineage.json` (per session UUID: `{cat, chain}`, where `chain` = `[birth, …middles…, current]`). The title is RENDERED from that data and never parsed back out of the title text — so a topic containing a comma or the word "then" can't scramble the breadcrumb. Birth (`chain[0]`) is copied verbatim across re-titles, never re-summarized.

Categories come from `~/.config/knowledge-worker-stack/session-categories.txt` (one `WORD - what belongs there` per line), the same file the date-prefix hook reads. No file = no category.

Needs `jq` and `python3`.

## Step 1 — read the current title, stored chain, and category

```bash
uuid="${CLAUDE_CODE_SESSION_ID:?run this inside the Claude Code session being retitled}"
mkdir -p "$HOME/.claude/state"
lin="$HOME/.claude/state/state_claude_session_title_lineage.json"; [[ -f "$lin" ]] || echo '{}' > "$lin"
jsonl=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$uuid".jsonl 2>/dev/null | head -1)
[[ -f "$jsonl" ]] || { echo "no transcript for $uuid — STOP"; exit 1; }
echo "current title: $(jq -r 'select(.type=="custom-title")|.customTitle' "$jsonl" 2>/dev/null | tail -1)"
echo "stored chain:  $(jq -c --arg s "$uuid" '.[$s].chain // "(none)"' "$lin")"
echo "stored cat:    $(jq -r  --arg s "$uuid" '.[$s].cat   // "(none)"' "$lin")"
```

Quote the printed `current title` back to the user verbatim in your reply, before the new one — it is the only place they can see what the title was, and it is gone from the screen once the new one applies.

## Step 2 — decide the new chain

Compose the **current topic** as a concise 3-7 words capturing what the session is doing *now* (the user's true intent/throughline, not a passing tangent). Then build the full `topics` array, oldest first, current last:

- **No stored chain yet (first /retitle):** derive the session's true origin from its early prompts = the **birth** topic. Current topic ≈ birth → `topics=("<current>")` (single, no breadcrumb yet). Already moved on → `topics=("<birth>" "<current>")`.
- **A chain already exists:** copy its entries **verbatim** from the printed `stored chain`, then — if the current topic is essentially unchanged from the last entry, reuse the chain as-is (no growth); otherwise append the new current topic. Never reword `chain[0]` (the stage step aborts if birth changes, as a safety net).
- **Junk existing title** (a vague auto-title like "general discussion"): treat it as no real prior topic and derive a proper birth, as in the first-/retitle case.
- **Successor index:** if the current title ends in a lineage number (`03`), end the current topic with it, so the render puts it last.

Realistic budget is 3 topics; if a session genuinely sprawls past that, that's a signal it should probably be split into a fresh session — flag it rather than growing the title without bound.

## Step 3 — apply it

Fill the three variables at the top, then run the block. Category is auto-kept unless you override it. The block applies the title itself — never ask the user to send a message to trigger it.

```bash
# ---- fill these three ----
topics=("family cookbook" "photo scans" "recipe card layout")   # oldest (birth) first, current last
cat_override=""                                                # "" = keep the session's existing category; else a WORD from the category file
correct_birth=0                                                # 1 ONLY to deliberately rewrite the birth topic
# --------------------------

uuid="${CLAUDE_CODE_SESSION_ID:?run this inside the Claude Code session being retitled}"
mkdir -p "$HOME/.claude/state"
lin="$HOME/.claude/state/state_claude_session_title_lineage.json";       [[ -f "$lin" ]]   || echo '{}' > "$lin"
state="$HOME/.claude/state/state_claude_session_titles.json"; [[ -f "$state" ]] || echo '{}' > "$state"
jsonl=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$uuid".jsonl 2>/dev/null | head -1)
[[ -f "$jsonl" ]] || { echo "no transcript for $uuid — STOP"; exit 1; }
catfile="$HOME/.config/knowledge-worker-stack/session-categories.txt"
KNOWN_CATS=" $( [[ -s "$catfile" ]] && sed -nE 's/^[[:space:]]*([A-Za-z0-9_-]+)[[:space:]]+-[[:space:]].*/\1/p' "$catfile" | tr '\n' ' ')"

chain=$(printf '%s\n' "${topics[@]}" | jq -R . | jq -sc .)

# birth-immutability guard
prior=$(jq -c --arg s "$uuid" '.[$s].chain // empty' "$lin")
if [[ -n "$prior" && "$correct_birth" -eq 0 ]]; then
  pb=$(jq -r '.[0]' <<<"$prior"); nb=$(jq -r '.[0]' <<<"$chain")
  if [[ "$pb" != "$nb" ]]; then
    echo "ABORT: birth would change ('$pb' -> '$nb'). Copy chain[0] verbatim, or set correct_birth=1." >&2; exit 1
  fi
fi

# category: explicit override > stored cat > extract from current title's leading token > none
cat="$cat_override"
[[ -z "$cat" ]] && cat=$(jq -r --arg s "$uuid" '.[$s].cat // ""' "$lin")
if [[ -z "$cat" ]]; then
  cur=$(jq -r 'select(.type=="custom-title")|.customTitle' "$jsonl" 2>/dev/null | tail -1)
  rest="${cur#[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] }"; first="${rest%% *}"
  case "$KNOWN_CATS" in *" $first "*) cat="$first" ;; esac
fi

# render the breadcrumb from the chain, prefix the category; the index from chain[-1] goes LAST, after the breadcrumb
body=$(jq -r 'if length==1 then .[0] else ((.[-1] | capture("^(?<d>.*?)(?<n> [0-9]{1,3})?$")) as $m | $m.d + ", originally: " + .[0] + ([.[1:-1][] | ", then: " + .] | join("")) + ($m.n // "")) end' <<<"$chain")
[[ -n "$cat" ]] && title="$cat $body" || title="$body"

# persist lineage, then stage pending_title (hook prepends date + locks description).
# BOTH writes take the .lock DIRECTORY — the same mutex date-prefix-title.sh takes on every
# prompt of every session. See "Locking" below before changing anything here.
python3 - "$uuid" "$chain" "$cat" "$title" <<'PY'
import json, os, sys, tempfile, time
sid, chain, cat, title = sys.argv[1:5]

def rewrite(path, mutate):
    lock = path + ".lock"                                # a DIRECTORY, never a file
    for _ in range(40):
        try:
            os.mkdir(lock)
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > 30: os.rmdir(lock); continue
            except OSError: pass                         # a stale FILE at this name is not ours to clear
            time.sleep(0.05); continue
        try:
            try:
                with open(path, encoding="utf-8") as f: d = json.load(f)
            except FileNotFoundError: d = {}
            mutate(d)
            t = tempfile.NamedTemporaryFile("w", dir=os.path.dirname(path), delete=False, encoding="utf-8")
            try:
                json.dump(d, t, indent=2, ensure_ascii=False); t.close()
                os.chmod(t.name, 0o640)                  # NamedTemporaryFile is 0600; os.replace carries the mode over
                os.replace(t.name, path)
            except BaseException:
                os.unlink(t.name); raise                 # never leave a temp file behind
        finally:
            os.rmdir(lock)
        return
    raise SystemExit(f"could not take {lock} in 40 tries — STOP, the title was not written")

def stage(d):
    e = dict(d.get(sid, {}))
    e["pending_title"] = title
    e.pop("overridden", None)
    d[sid] = e

h = os.path.expanduser("~/.claude/state")
rewrite(h + "/state_claude_session_title_lineage.json", lambda d: d.update({sid: dict(d.get(sid) or {}, cat=cat, chain=json.loads(chain))}))   # merge, never replace: the entry may carry fields other writers own
rewrite(h + "/state_claude_session_titles.json", stage)
PY

# date prefix — the same one the hook would apply
dp=$(jq -r --arg s "$uuid" '.[$s].locked_date // empty' "$state")
[[ -z "$dp" ]] && dp=$(jq -r 'select(.timestamp)|.timestamp' "$jsonl" 2>/dev/null | head -1 | cut -c1-10 | tr -d -)
[[ -z "$dp" ]] && dp=$(date -r "$jsonl" +%Y%m%d 2>/dev/null)
[[ -z "$dp" ]] && dp=$(date +%Y%m%d)

# apply now: append the custom-title event the hook would have emitted on the next prompt
jq -nc --arg t "$dp $title" --arg s "$uuid" '{type:"custom-title",customTitle:$t,sessionId:$s}' >> "$jsonl"
echo "Applied: $dp $title"
```

Then tell the user: "Applied: `<date> <title>`" — no confirmation message needed from them. The title is on disk immediately and shows in `claude --resume` and every other session list right away; the label in the running window repaints on their next prompt, because the live process only re-reads its title then. The staged `pending_title` makes that repaint agree with what was written, so nothing flickers back.

## Locking
Two programs write `~/.claude/state/state_claude_session_title_lineage.json` and `~/.claude/state/state_claude_session_titles.json`: this skill and `date-prefix-title.sh`, which rewrites the second file on every prompt of every session. Both must agree on ONE mutex: a **directory** created with `mkdir` at `<file>.lock`, released with `rmdir`.

- Never use `flock` on these two files. `flock` leaves a plain FILE at `<file>.lock`, and a plain file there makes every later `mkdir` fail forever: title writes stop machine-wide, silently.
- Never write them unlocked.
- If `mkdir` fails permanently, look for a plain file at the lock path before assuming contention.
- The 30-second staleness check and the release in `finally` match the hook's own orphan recovery. Running out of attempts raises rather than writing anyway: a title write that quietly did not happen is worse than one that failed loudly.
- The temp file is chmod'd to 0640 before `os.replace` because `NamedTemporaryFile` creates 0600 and the replace carries that mode onto the live file.

## Scope
`/retitle` is for **in-session** curation: staging `pending_title` makes the date-prefix hook re-emit the title on every prompt (`description_locked`), which stops Claude Code's per-turn auto-title from replacing it. The lineage and category live in their own file, separate from the hook's, so the hook stays agnostic and never clobbers them.
