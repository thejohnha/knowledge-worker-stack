#!/usr/bin/env bash
# claude_session_prime_directive.sh — set, close or show a session's prime directive + done_when
# in ~/.claude/state/state_claude_session_title_lineage.json (per-uuid entry, fields
# prime_directive / done_when / closed, merged beside /retitle's cat + chain).
#
#   claude_session_prime_directive.sh set   <UUID> "<prime directive>" "<done_when|never>"
#   claude_session_prime_directive.sh close <UUID>
#   claude_session_prime_directive.sh show  <UUID>
#   claude_session_prime_directive.sh check "<done_when>"    screen a sentence; touches nothing
#   claude_session_prime_directive.sh audit                  screen every live done_when on disk
#
# set re-opens a closed entry (clears the closed flag): re-settling IS the reopen.
# An empty done_when never means permanent — write the literal word "never" for that.
# The lock is a DIRECTORY made with mkdir, matching every other writer of this file (/retitle,
# the title hook) — a plain file at the .lock path silently stops them all.
# The per-turn reader is ~/.claude/hooks/session-prime-directive.py.
set -u

verb="${1:-}"; sid="${2:-}"
case "$verb" in set|close|show|check|audit) ;; *) echo "usage: $(basename "$0") set|close|show <UUID> [args] | check \"<done_when>\" | audit" >&2; exit 2 ;; esac

# trap_warn screens a done_when for the three shapes that CANNOT work, and warns on each
# independently. Warn, never refuse: the phrasing space is open and a session whose WORK is
# handovers writes these words innocently. The warning goes to stderr, straight back to the agent
# that just composed the sentence.
#   1 LIFECYCLE              — a handover, spawn or context threshold satisfies it.
#   2 OPERATOR-GATED         — it needs the user to speak; an unattended run can never cross it.
#   3 UNFALSIFIABLE NEGATIVE — an absence or a bare comparative, which no session can observe true.
# Whether a sentence names something a command can decide is a judgment, so it is NOT screened.
trap_warn() {
  DW="$1" python3 - <<'PY' >&2
import os, re
dw = os.environ["DW"]

# ---- family 1: satisfiable by the SESSION LIFECYCLE rather than by the work.
TRAPS = [
    (r"\bhands?\s+off\b|\bhand-?offs?\b", "the handover satisfies it"),
    (r"\bnext session\b|\bsession\s+\d{1,3}\b", "spawning the next session satisfies it"),
    # both voices: "spawns a successor" and "a successor is spawned". The noun ALONE is not a
    # trap — a session whose topic is the successor skill says "successor" in a fine done_when.
    (r"\b(spawn|launch)(s|ed|ing)?\s+(a\s+|the\s+)?successor\b"
     r"|\bsuccessor\b[^.]{0,20}\b(is|are|was|were|gets?|has been)\s+(spawned|launched|started|created)\b",
     "spawning a successor satisfies it"),
    (r"\bcontext\b[^.]{0,30}\b(runs?\s+out|limit|threshold|full|window)\b", "a context threshold satisfies it"),
    (r"\bcompact(s|ed|ion)?\b", "a compaction satisfies it"),
]
hit = next((why for pat, why in TRAPS if re.search(pat, dw, re.I)), None)
if hit:
    print(f"warning: this done_when looks satisfiable by the SESSION LIFECYCLE rather than by the work — {hit}.\n"
          f"         A done_when tied to a handover, a spawn or a context threshold ends the series early\n"
          f"         and looks correct while doing it.\n"
          f"         Phrase the done_when as the end of the TOPIC — what is true about the WORK when it is done.\n"
          f"         Nothing is refused over this; fix the sentence with `set` if this one is the trap.")

# ---- family 2: OPERATOR-GATED — the done_when needs the user to speak, so the session can never
# cross it alone and an unattended run spins until something else stops it.
ACTOR = r"(?:the user|the operator|the human|I)"
VERB = (r"(?:stat(?:e|es|ed)|say|says|said|confirm(?:s|ed)?|approv(?:e|es|ed)|declar(?:e|es|ed)|"
        r"acknowledg(?:e|es|ed)|agree(?:s|d)?|repl(?:y|ies|ied)|respond(?:s|ed)?|"
        r"bless(?:es|ed)?|sign(?:s)?(?:\s+|-)?off|signed(?:\s+|-)?off|type(?:s|d)?|tell(?:s)?|told)")
# NOUN forms: a gate named as a thing is the same trap as one named as an act of speaking.
NOUN = r"(?:say-?so|go-?ahead|sign-?off|blessing|approval|confirmation|okay|green\s*light)"
OPERATOR_GATED = [
    re.compile(rf"\b{ACTOR}\s+(?:has\s+|have\s+|had\s+|will\s+|would\s+)?{VERB}\b", re.I),
    re.compile(r"\b(?:the user's|my)\s+(?:approval|confirmation|sign-?off|blessing|go-?ahead|word|reply|response)\b", re.I),
    re.compile(rf"\b{ACTOR}\s+(?:has\s+)?(?:given|granted)\b", re.I),
    re.compile(rf"\b{ACTOR}'s\s+{NOUN}\b", re.I),
]
_gated = any(p.search(dw) for p in OPERATOR_GATED) or bool(
    re.search(rf"\b(?:his|her|their)\s+{NOUN}\b", dw, re.I)
    and re.search(rf"\b{ACTOR}(?:'s)?\b", dw, re.I))
if _gated:
    print(f"warning: this done_when is OPERATOR-GATED — it finishes only when the user says so, which the\n"
          f"         session cannot do for itself. The cost is that the lineage never closes and keeps\n"
          f"         handing off to a successor.\n"
          f"         Phrase it as the ARTIFACT that exists when the work is done, not as a reaction to it.\n"
          f"         Or name QUIESCENCE — <artifact> goes <N days> with no <change signal>, e.g. `the skill\n"
          f"         and its scripts go 28 days with no commit`. The digit makes it observable and, unlike\n"
          f"         `never`, it closes itself. Usually right for work that only LOOKS permanent.\n"
          f"         If the user will realistically NEVER do the thing, the sentence is `never` in disguise —\n"
          f"         write `never`, which reads as a standing job (close refuses it).\n"
          f"         Nothing is refused over this; fix the sentence with `set` if this one is the trap.")

# ---- family 3: UNFALSIFIABLE NEGATIVE — a done_when phrased as something ceasing, or as an
# unquantified comparative. Neither can ever be OBSERVED true. A digit anywhere exempts the
# comparative half ("under 200 bytes" is measurable). A TIME WINDOW exempts the ceasing half
# ("stops failing for 30 days" is a quiet clock read off a date); a bare digit does not.
CEASES = re.compile(r"\b(stops?|stopped|ceas(?:e|es|ed)|no longer|nothing\s+(?:more|left|further))\b", re.I)
WINDOW = re.compile(r"\b\d[\d,]*[\s-]*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b", re.I)
COMPARATIVE = re.compile(r"\b(smaller|larger|bigger|faster|slower|fewer|lower|higher|shorter|longer|"
                         r"better|cheaper|lighter|leaner|tighter|reduced|improved|increased|decreased)\b", re.I)
neg = None
if CEASES.search(dw) and not WINDOW.search(dw):
    neg = "it is phrased as something CEASING, and an absence over future events is never observable"
elif COMPARATIVE.search(dw) and not re.search(r"\d", dw):
    neg = "it is an unquantified comparative — no number, so no session can decide whether it is met"
if neg:
    print(f"warning: this done_when is an UNFALSIFIABLE NEGATIVE — {neg}.\n"
          f"         A session can only ever observe that the thing happened AGAIN; there is no command\n"
          f"         that returns yes, so the done_when is never crossed and the lineage runs forever.\n"
          f"         Give it a POSITIVE event with a number — a count, a threshold, an artifact that exists.\n"
          f"         Nothing is refused over this; fix the sentence with `set` if this one is the trap.")
PY
}

# `check` takes a SENTENCE, not a uuid, and touches no state. Always exits 0. "$*" rather than
# "$1", so an unquoted sentence is still tested whole. A pass says so out loud: a silent pass is
# indistinguishable from a verb that did nothing.
if [ "$verb" = check ]; then
  shift
  [ -n "${*:-}" ] || { echo "check needs a done_when sentence" >&2; exit 2; }
  if out=$(trap_warn "$*" 2>&1) && [ -z "$out" ]; then
    echo "check: no warning — this done_when passes the trap test"
  else
    printf '%s\n' "$out" >&2
  fi
  exit 0
fi

# `audit` runs the same trap test over EVERY live done_when on disk, which catches a sentence
# settled before a trap family existed. Read-only. Only the LATEST member of a numbered series is
# audited (a retired generation still holds the sentence it handed over with). Exits 1 when any
# sentence warns, or when a numbered lineage past generation 8 has no done_when at all.
if [ "$verb" = audit ]; then
  [ "$#" -le 1 ] || { echo "audit takes no arguments — it screens every live done_when on disk" >&2; exit 2; }
  rows=$(python3 - <<'AUDITPY'
import json, os, re
lin = os.path.expanduser("~/.claude/state/state_claude_session_title_lineage.json")
tit = os.path.expanduser("~/.claude/state/state_claude_session_titles.json")
try:
    L = json.load(open(lin, encoding="utf-8"))
except Exception:
    raise SystemExit(0)                       # no state file yet: nothing to audit
try:
    T = json.load(open(tit, encoding="utf-8"))
except Exception:
    T = {}
# date, marker, KEY (group 3), number, ", originally: …" breadcrumb, number LAST (group 6)
SPLIT = re.compile(r"^(\d{8}\s+)?((?:⭐|☑️|[1-9]️⃣)\s+)?(.*?)(\s+\d{1,3})?(,\s+originally:.*?)?(\s+\d{1,3})?$")
cand = []
for sid, e in sorted(L.items()):
    if not isinstance(e, dict) or e.get("closed"):
        continue
    dw = str(e.get("done_when") or "").strip()
    t = T.get(sid) or {}
    chain = e.get("chain") or []
    title = t.get("cached_custom") or t.get("last_written") or (chain[-1] if chain else "")
    # Key from chain[0] and number from chain[-1] when /retitle kept a chain, so a rename does
    # not split one lineage in two; else both from the title.
    m = SPLIT.match(chain[-1] if chain else title)
    num = int(m.group(4) or m.group(6)) if (m and (m.group(4) or m.group(6))) else -1
    mk = SPLIT.match(chain[0]) if chain else m
    key = ((mk.group(3) or "").strip() if mk else "") if num >= 0 else sid   # unnumbered: a series of one
    cand.append((key or sid, num, sid, title or "(no title)", dw))
latest = {}
for key, num, sid, title, dw in cand:
    if key not in latest or num > latest[key][0]:
        latest[key] = (num, sid, title, dw)
settled_cand = sum(1 for k, n, sd, t, d in cand if d)
settled_latest = sum(1 for n, sd, t, d in latest.values() if d)
print(settled_cand - settled_latest)          # line 1: superseded generations skipped; the rows follow
for num, sid, title, dw in latest.values():
    if dw:
        print("\t".join((sid, title, dw)))
print("---UNSETTLED---")
for num, sid, title, dw in latest.values():
    if not dw and num >= 0:
        print("\t".join((sid, title, str(num))))
AUDITPY
)
  superseded=$(printf '%s\n' "$rows" | head -1)
  unsettled_rows=$(printf '%s\n' "$rows" | sed -n '/^---UNSETTLED---$/,$p' | tail -n +2)
  # DELETE from the marker to the end rather than PRINT up to it: with no settled rows the marker
  # sits on line 1 and a print range would never close.
  rows=$(printf '%s\n' "$rows" | tail -n +2 | sed '/^---UNSETTLED---$/,$d')
  total=0; bad=0
  while IFS=$'\t' read -r a_sid a_title a_dw; do
    [ -n "$a_sid" ] || continue
    total=$((total + 1))
    out=$(trap_warn "$a_dw" 2>&1)
    [ -n "$out" ] || continue
    bad=$((bad + 1))
    printf '%s  %s\n    done_when: %s\n%s\n\n' "${a_sid%%-*}" "$a_title" "$a_dw" "$out"
  done <<< "$rows"
  unsettled_total=0; unsettled_old=0
  while IFS=$'\t' read -r u_sid u_title u_gen; do
    [ -n "$u_sid" ] || continue
    unsettled_total=$((unsettled_total + 1))
    [ "${u_gen:-0}" -ge 8 ] 2>/dev/null || continue
    unsettled_old=$((unsettled_old + 1))
    printf '%s  %s\n    done_when: (UNSET)\n' "${u_sid%%-*}" "$u_title"
    printf 'warning: this lineage has reached generation %s with NO done_when.\n' "$u_gen"
    printf '         There is no sentence to meet, so it cannot end by any route except closing the\n'
    printf '         tab. Settle it with `set`, or say `never` if the role is standing.\n\n'
  done <<< "$unsettled_rows"
  echo "audit: $bad of $total live done_whens warn (${superseded:-0} superseded generations skipped)"
  echo "       $unsettled_old of $unsettled_total unsettled numbered lineages are past generation 8"
  [ "$bad" -eq 0 ] && [ "$unsettled_old" -eq 0 ] || exit 1
  exit 0
fi

[[ "$sid" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "not a session UUID: '$sid'" >&2; exit 2; }

if [ "$verb" = set ]; then
  pd="${3:-}"; dw="${4:-}"
  [ -n "$pd" ] && [ -n "$dw" ] || { echo "set needs BOTH sentences — an empty done_when means unsettled, never permanent; use the word 'never'" >&2; exit 2; }
  # The two sentences are positional, so an unquoted call must fail LOUDLY rather than write a fragment.
  [ "$#" -le 4 ] || { echo "set takes exactly two QUOTED sentences: set <UUID> \"<prime directive>\" \"<done_when>\" — got $# arguments, so a sentence is unquoted and would be written truncated" >&2; exit 2; }
  for v in "$pd" "$dw"; do
    [ "${#v}" -gt 200 ] && echo "warning: ${#v} chars — the hook re-injects both sentences every turn; keep each under ~15 words" >&2
  done
  trap_warn "$dw"
fi

PD="${3:-}" DW="${4:-}" python3 - "$verb" "$sid" <<'PY'
import glob, json, os, re, sys, tempfile, time
verb, sid = sys.argv[1], sys.argv[2]
path = os.path.expanduser("~/.claude/state/state_claude_session_title_lineage.json")

if verb == "show":
    # stdout is ALWAYS JSON, so a caller can pipe it straight into jq; the words go to stderr.
    try:
        with open(path, encoding="utf-8") as f: e = json.load(f).get(sid)
    except FileNotFoundError: e = None
    if e:
        print(json.dumps(e, indent=2, ensure_ascii=False))
    else:
        print("{}")
        print("no entry", file=sys.stderr)
    raise SystemExit(0)


def rewrite(p, mutate):
    lock = p + ".lock"                                   # a DIRECTORY, never a file
    for _ in range(40):
        try: os.mkdir(lock)
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > 30: os.rmdir(lock); continue
            except OSError: pass                         # a stale FILE at this name is not ours to clear
            time.sleep(0.05); continue
        try:
            try:
                with open(p, encoding="utf-8") as f: d = json.load(f)
            except FileNotFoundError: d = {}
            mutate(d)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            t = tempfile.NamedTemporaryFile("w", dir=os.path.dirname(p), delete=False, encoding="utf-8")
            try:
                json.dump(d, t, indent=2, ensure_ascii=False); t.close()
                os.chmod(t.name, 0o640)                  # NamedTemporaryFile is 0600; os.replace carries the mode over
                os.replace(t.name, p)
            except BaseException:
                os.unlink(t.name); raise
        finally: os.rmdir(lock)
        return
    raise SystemExit(f"could not take {lock} in 40 tries — STOP, nothing was written")


if verb == "close":
    # `never` means a standing job: closing would silence its per-turn reminder and end the lineage.
    # If the standing role genuinely ended, that is a CHANGE of the done_when — `set` it, then close.
    try:
        with open(path, encoding="utf-8") as f: cur = (json.load(f).get(sid) or {})
    except (FileNotFoundError, ValueError): cur = {}
    if str(cur.get("done_when", "")).strip().lower() == "never":
        raise SystemExit(
            "REFUSED: this session's done_when is `never`, so it has no done_when to reach.\n"
            "  Closing it would silence its per-turn reminder and mark the lineage as ended.\n"
            "  If the standing role is genuinely over, that is a CHANGE of the done_when, not a\n"
            "  completion of it: run `set` with a real done_when saying why it ends, then close.")


def charter(d):
    e = dict(d.get(sid) or {})                           # merge, never replace: the entry carries fields other writers own
    if verb == "set":
        e["prime_directive"] = os.environ["PD"]; e["done_when"] = os.environ["DW"]; e.pop("closed", None)
    else:
        e["closed"] = True
    d[sid] = e

os.makedirs(os.path.dirname(path), exist_ok=True)
rewrite(path, charter)

with open(path, encoding="utf-8") as f: e = json.load(f).get(sid)   # prove the write off the live file
print(json.dumps({k: e[k] for k in ("prime_directive", "done_when", "closed") if k in e}, indent=2, ensure_ascii=False))

if verb == "close":
    # Stamp ☑️ into the title so the session reads as finished in every session list. STAGED through
    # pending_title, never appended to a live transcript (a live session re-writes its old title on
    # its next prompt and the last record wins). The title hook applies it on the next prompt.
    tpath = os.path.expanduser("~/.claude/state/state_claude_session_titles.json")
    MARKER = re.compile(r"^(⭐|☑️|[1-9]️⃣)\s+")

    def stage(d):
        ent = dict(d.get(sid) or {})
        cur = ent.get("pending_title") or ent.get("cached_custom") or ent.get("last_written") or ""
        cur = re.sub(r"^\d{8}\s+", "", cur)               # the hook prepends locked_date itself
        cur = MARKER.sub("", cur)                          # same slot as ⭐/1-9 — replace, never stack
        if not cur: return
        ent["pending_title"] = f"☑️ {cur}"
        d[sid] = ent

    try:
        rewrite(tpath, stage)
        with open(tpath, encoding="utf-8") as f: pt = (json.load(f).get(sid) or {}).get("pending_title")
        print(f"title staged: {pt}   (appears on this session's next prompt)" if pt
              else "no cached title to stamp — add ☑️ by hand with /rename if you want it")
    except Exception as exc:
        print(f"closed, but the ☑️ title stamp did not land ({exc})")

    # A long job runs as a SERIES: same title, a trailing number, one session per generation. Close
    # marks every earlier generation too, so finished work stops leaving live-looking rows. The
    # session being closed is LIVE, so it gets pending_title; retired generations get no further
    # prompt, so they get a custom-title record appended to their transcript instead.
    SPLIT = re.compile(r"^(\d{8}\s+)?((?:⭐|☑️|[1-9]️⃣)\s+)?(.*?)(\s+\d{1,3})?(,\s+originally:.*?)?(\s+\d{1,3})?$")

    def config_dirs():
        out = [os.path.expanduser("~/.claude")]
        if os.environ.get("CLAUDE_CONFIG_DIR"): out.append(os.environ["CLAUDE_CONFIG_DIR"])
        try: acc = json.load(open(os.path.expanduser("~/.config/knowledge-worker-stack/accounts.json")))
        except Exception: acc = {}
        if isinstance(acc, dict): out += [os.path.expanduser(v) for v in acc.values() if isinstance(v, str)]
        return out

    def transcript(uuid):
        for d in config_dirs():
            hits = glob.glob(os.path.join(d, "projects", "*", uuid + ".jsonl"))
            if hits: return hits[0]
        return ""

    def transcript_title(uuid):
        tr = transcript(uuid)
        try:
            if not tr or not os.path.getsize(tr): return ""
        except OSError:
            return ""
        import mmap
        with open(tr, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            needle, pos = b'"custom-title"', len(mm)
            while True:
                i = mm.rfind(needle, 0, pos)
                if i < 0: return ""
                a = mm.rfind(b"\n", 0, i) + 1
                b = mm.find(b"\n", i)
                try: d = json.loads(mm[a:b if b >= 0 else len(mm)])
                except Exception: d = None
                if isinstance(d, dict) and d.get("type") == "custom-title":
                    return d.get("customTitle", "")
                pos = i

    def series_members(T, sid):
        cur = (T.get(sid) or {})
        title = cur.get("pending_title") or cur.get("cached_custom") or cur.get("last_written") or ""
        m = SPLIT.match(title)
        if not (m and (m.group(4) or m.group(6))):
            return "", []                      # unnumbered or untitled: a series of one
        key = (m.group(3) or "").strip()
        if not key:
            return "", []
        out = []
        for other, ent in T.items():
            if other == sid or not isinstance(ent, dict):
                continue
            # The TRANSCRIPT wins for a sibling: a retired generation's store row can be stale.
            ot = transcript_title(other) or ent.get("pending_title") or ent.get("cached_custom") or ent.get("last_written") or ""
            om = SPLIT.match(ot)
            if om and (om.group(4) or om.group(6)) and (om.group(3) or "").strip() == key:
                out.append((other, ot, ent.get("locked_date") or ""))
        return key, out

    def marked(title):
        return bool(re.match(r"^(?:\d{8}\s+)?☑️\s", title))

    def with_mark(title, locked_date=""):      # insert ☑️ after any date
        title = re.sub(r"^(\d{8}\s+)(?:⭐|☑️|[1-9]️⃣)\s+", r"\1", title)
        title = re.sub(r"^(?:⭐|☑️|[1-9]️⃣)\s+", "", title)
        dm = re.match(r"^(\d{8})\s+(.*)$", title)
        if dm:
            return f"{dm.group(1)} ☑️ {dm.group(2)}"
        return f"{locked_date} ☑️ {title}" if locked_date else f"☑️ {title}"

    try:
        with open(tpath, encoding="utf-8") as f: T = json.load(f)
    except Exception:
        T = {}
    key, sibs = series_members(T, sid)
    todo = [(o, t, ld) for o, t, ld in sibs if not marked(t)]
    # The ☑️ (what you see) and the `closed` flag (what the machinery reads) are separate writes;
    # the flag runs over every sibling, not only the ones whose title needed changing.
    if sibs:
        def close_sibs(d):
            for other, _ot, _ld in sibs:
                ent = dict(d.get(other) or {})
                ent["closed"] = True
                d[other] = ent
        try:
            rewrite(path, close_sibs)
        except Exception:
            pass
    if todo:
        appended = 0
        for other, ot, ld in todo:
            tr = transcript(other)
            if not tr:
                continue
            try:
                mt = os.path.getmtime(tr)      # a mark is not activity: keep the file's time
                with open(tr, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"type": "custom-title", "customTitle": with_mark(ot, ld),
                                         "sessionId": other}, ensure_ascii=False) + "\n")
                os.utime(tr, (mt, mt))
                appended += 1
            except Exception:
                pass
        def stage_sibs(d):
            for other, ot, _ld in todo:
                ent = dict(d.get(other) or {})
                c = MARKER.sub("", re.sub(r"^\d{8}\s+", "", ot))
                if c:
                    ent["pending_title"] = f"☑️ {c}"
                    d[other] = ent
        try:
            rewrite(tpath, stage_sibs)
        except Exception:
            pass
        print(f"lineage \"{key}\": {appended} earlier generation(s) newly marked ☑️, {len(sibs)} closed")
    elif key:
        print(f"lineage \"{key}\": no earlier generation needed a new ☑️, {len(sibs)} closed")
PY
