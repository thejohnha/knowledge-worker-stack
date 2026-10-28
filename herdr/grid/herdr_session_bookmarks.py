#!/usr/bin/env python3
"""Bookmarks on session lineages, set by the grid's `b` key and by this script.

A bookmark is NOT in the title, so a session can carry both a bookmark and any marker its title has.
Bookmarks live in the grid's own file under "bookmarks" — keyed by lineage key (the title minus date,
marks and number, as the grid computes it), each holding the uuid it was set on — so a /successor keeps
the bookmark through the key, and a /retitle of the bookmarked session keeps it through the uuid.

The grid holds its file in memory and rewrites it whole, so its save_state re-reads "bookmarks" from
disk under the same lock: this file is the only writer of that section.

  herdr_session_bookmarks.py toggle <uuid>   # prints "bookmarked" or "unbookmarked"
  herdr_session_bookmarks.py list            # one "<uuid8>  <lineage key>" per bookmark
"""
import fcntl, glob, json, os, re, sys

HOME = os.path.expanduser("~")
STATE = f"{HOME}/.claude/state/state_claude_session_grid.json"
def _config(name):
    try:
        with open(f"{HOME}/.config/knowledge-worker-stack/{name}", encoding="utf-8") as fh: d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception: return {}
ACCOUNT_DIRS = [os.path.expanduser(v) for v in {"default": "~/.claude", **_config("accounts.json")}.values() if isinstance(v, str)]
ARCHIVE = os.path.expanduser(_config("grid.json").get("archive_dir") or "~/.claude/projects/-archive")
# Same groups as herdr_session_grid.py's SPLIT: group 3 is the lineage key.
SPLIT = re.compile(r"^(\d{8}\s+)?((?:⭐|☑️|[1-9]️⃣)\s+)?(.*?)(\s+\d{1,3})?(,\s+originally:.*?)?(\s+\d{1,3})?$")


def lineage_key(title, uuid):
    m = SPLIT.match(title or ""); base = (m.group(3) or "").strip() if m else ""
    return base or uuid


def transcript_title(uuid):
    """The last custom-title of the session's transcript, live or archived; "" when none."""
    paths = [p for d in ACCOUNT_DIRS for p in glob.glob(f"{d}/projects/*/{uuid}.jsonl")] + glob.glob(f"{ARCHIVE}/*/{uuid}.jsonl")
    t = ""
    for p in paths[:1]:
        with open(p, "rb") as fh:
            for line in fh:
                if b'"custom-title"' in line:
                    try: t = json.loads(line).get("customTitle") or t
                    except ValueError: pass
    return t


_cache = (None, {})
def load():
    """{lineage key: {"uuid": ..., "label": ...}}, re-read only when the grid file changed."""
    global _cache
    try: sig = os.stat(STATE).st_mtime_ns
    except OSError: return {}
    if _cache[0] != sig:
        try:
            with open(STATE, encoding="utf-8") as fh: bm = json.load(fh).get("bookmarks") or {}
        except (OSError, ValueError, AttributeError): bm = {}
        _cache = (sig, bm if isinstance(bm, dict) else {})
    return _cache[1]


def is_marked(bm, uuid, title):
    return lineage_key(title, uuid) in bm or any(isinstance(v, dict) and v.get("uuid") == uuid for v in bm.values())


def set_mark(uuid, title, on, label=""):
    """Write one bookmark on or off, under the grid file's lock; every other key of the file is kept."""
    key = lineage_key(title, uuid)
    with open(STATE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            with open(STATE, encoding="utf-8") as fh: st = json.load(fh)
        except (OSError, ValueError): st = {}
        if not isinstance(st, dict): st = {}
        bm = st.get("bookmarks") if isinstance(st.get("bookmarks"), dict) else {}
        bm = {k: v for k, v in bm.items() if k != key and not (isinstance(v, dict) and v.get("uuid") == uuid)}
        if on: bm[key] = {"uuid": uuid, "label": label}
        st["bookmarks"] = bm
        tmp = STATE + ".bm.tmp"
        with open(tmp, "w", encoding="utf-8") as fh: json.dump(st, fh, indent=1, ensure_ascii=False); fh.write("\n")
        os.replace(tmp, STATE)
    return on


def toggle(uuid, title=None, label=""):
    title = transcript_title(uuid) if title is None else title
    return set_mark(uuid, title, not is_marked(load(), uuid, title), label)


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "toggle" and re.fullmatch(r"[0-9a-f-]{36}", a[1]):
        print("bookmarked" if toggle(a[1]) else "unbookmarked")
    elif a == ["list"]:
        for k, v in load().items(): print(f"{str(v.get('uuid', ''))[:8]}  {k}")
    else:
        sys.exit(__doc__.split("\n\n")[-1])
