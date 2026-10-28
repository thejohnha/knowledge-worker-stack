#!/usr/bin/env python3
"""claude_session_lineage_latest.py <session uuid>

Print the newest member of that session's lineage as one line:  <uuid>\t<number>\t<title>\t<open|closed>
Exit 0 with the line, exit 1 when the uuid is unknown to both state files.

A lineage is every session whose title, past or present, reads "<stem> <number>" for the same stem.
Titles come from the `chain` field of state_claude_session_title_lineage.json (kept by /retitle, so a
retitle does not split the lineage) plus `cached_custom`, `last_written` and `cached_ai` in
state_claude_session_titles.json (the title hook's record; a /successor title lands in cached_custom).
The date prefix and the priority/finished marker are not part of the stem.

Rules:
- Highest NUMBER wins, never newest mtime: an old member resumed a minute ago is still not the latest.
- Never backwards: if the highest number found is below the asked-for session's own, the asked-for
  session is returned (a day that restarted its numbering at 01 must not send anyone to an old one).
- An unnumbered title is a lineage of one: the session itself.
- `closed` is read off the chosen member. `close` marks every generation, so a closed top member
  means the whole lineage is finished.
"""
import json, os, re, sys

STATE = os.path.expanduser(os.environ.get("CLAUDE_STATE_DIR", "~/.claude/state"))
LINEAGE = os.path.join(STATE, "state_claude_session_title_lineage.json")
TITLES = os.path.join(STATE, "state_claude_session_titles.json")

MARKER = re.compile(r"^(?:\d{8}\s+)?(?:(?:⭐|☑️|[1-9]️⃣)\s+)?")
NUMBERED = re.compile(r"^(.*\S)\s+(\d{1,3})$")


def load(path):
    try:
        with open(path) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def clean(title):
    return MARKER.sub("", title or "").strip()


def titles_of(uuid, lineage, titles):
    out = []
    e = lineage.get(uuid)
    if isinstance(e, dict):
        out += [t for t in (e.get("chain") or []) if isinstance(t, str)]
    t = titles.get(uuid)
    if isinstance(t, dict):
        out += [t[k] for k in ("cached_ai", "last_written", "cached_custom") if isinstance(t.get(k), str)]
    return [c for c in (clean(x) for x in out) if c]


def split(title):
    m = NUMBERED.match(title)
    return (m.group(1).casefold(), int(m.group(2))) if m else (None, None)


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9a-f-]{36}", sys.argv[1]):
        print(__doc__.strip().splitlines()[0], file=sys.stderr)
        return 2
    me = sys.argv[1]
    lineage, titles = load(LINEAGE), load(TITLES)
    mine = titles_of(me, lineage, titles)
    if not mine and me not in lineage and me not in titles:
        return 1

    def closed(u):
        e = lineage.get(u)
        return "closed" if isinstance(e, dict) and e.get("closed") else "open"

    stems = {}
    for t in mine:
        s, n = split(t)
        if s is not None:
            stems[s] = max(n, stems.get(s, 0))
    current = mine[-1] if mine else ""
    if not stems:
        print(f"{me}\t\t{current}\t{closed(me)}")
        return 0

    best = None                                   # (number, uuid, title)
    for u in set(lineage) | set(titles):
        if u.startswith("_"):
            continue
        for t in titles_of(u, lineage, titles):
            s, n = split(t)
            if s in stems and (best is None or n > best[0]):
                best = (n, u, t)
    my_num = max(stems.values())
    if best is None or best[0] < my_num:
        best = (my_num, me, current)
    print(f"{best[1]}\t{best[0]}\t{best[2]}\t{closed(best[1])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
