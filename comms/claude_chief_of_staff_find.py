#!/usr/bin/env python3
"""claude_chief_of_staff_find.py — find the chief of staff session; the wake, the go-to key, the phone
bridge, the owed scan and the Stop hook all ask this one file, so they always agree.

  claude_chief_of_staff_find.py      one line:  live <uuid> <pane> <tab> <status> <quiet minutes>
                                                stopped <uuid>     (no live chief; the newest one)
                                                none               (no chief at all)
                                                many <n>           (more than one live: fix by hand)

The chief is a session that is not closed and either has a prime directive naming chief-of-staff.md
(when the prime directive tool is installed) or the title "Chief of staff", optionally numbered and after
any date prefix, marker or category word, so a /successor handover keeps it found.
Stopped chiefs are looked for among the sessions in the title store and in herdr's tab record, by the
title the transcript itself records when no title store row exists.
Also a module: is_chief(uuid, title), find(), transcript(uuid), transcript_title(path).
"""
import glob, json, os, re, shutil, subprocess, sys
from datetime import datetime, timezone

STATE = os.path.expanduser(os.environ.get("CLAUDE_STATE_DIR", "~/.claude/state"))
LINEAGE = os.path.join(STATE, "state_claude_session_title_lineage.json")
TITLES = os.path.join(STATE, "state_claude_session_titles.json")
TABS = os.path.join(STATE, "state_claude_session_herdr_tabs.json")
ACCOUNTS = os.path.expanduser("~/.config/knowledge-worker-stack/accounts.json")
JOB = "chief-of-staff.md"
# The whole title: an optional date prefix, markers and one category word, "Chief of staff", an optional
# series number. "Chief of staff 03" matches; "Chief of staff helper notes" does not.
TITLE = re.compile(r"^(?:\d{8}\s+)?(?:[^\w\s]+\s*)*(?:\w+\s+)?chief of staff(?:\s+\d{1,3})?$", re.I)


def jload(path):
    try:
        d = json.load(open(path))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def config_dirs():
    """Every Claude Code config dir: accounts.json's, else ~/.claude."""
    dirs = [os.path.expanduser(v) for v in jload(ACCOUNTS).values() if isinstance(v, str)]
    return dirs or [os.path.expanduser("~/.claude")]


def transcript(uuid):
    """The path of a session's transcript, or ""."""
    helper = shutil.which("claude_session_transcript.sh")
    if helper:
        p = subprocess.run([helper, uuid], capture_output=True, text=True).stdout.strip()
        p = p.splitlines()[-1] if p else ""
        if p and os.path.isfile(p):
            return p
    hits = [h for d in config_dirs() for h in glob.glob(os.path.join(d, "projects", "*", uuid + ".jsonl"))]
    return max(hits, key=os.path.getmtime) if hits else ""


_TITLE_CACHE = {}                                 # (path, size) -> title: the bridge asks every few seconds


def transcript_title(path, cap=16 * 1024 * 1024):
    """The title Claude Code recorded in the transcript itself: the newest /rename (custom-title) record,
    else the newest automatic one (ai-title), else "". Reads backwards, at most `cap` bytes; cached."""
    try:
        key = (path, os.path.getsize(path))
    except OSError:
        return ""
    if key not in _TITLE_CACHE:
        _TITLE_CACHE[key] = _transcript_title(path, cap)
    return _TITLE_CACHE[key]


def _record(block, needle, field):
    i = block.rfind(needle)
    if i < 0:
        return None
    line = block[block.rfind(b"\n", 0, i) + 1:].split(b"\n", 1)[0]
    try:
        return json.loads(line).get(field) or ""
    except ValueError:
        return None


def _transcript_title(path, cap):
    ai = None
    try:
        with open(path, "rb") as f:
            end = f.seek(0, 2)
            pos = end
            while pos > 0 and end - pos < cap:
                start = max(0, pos - 4 * 1024 * 1024)
                f.seek(start)
                block = f.read(pos - start + 4096)            # overlap, so a record split across blocks is seen
                custom = _record(block, b'"type":"custom-title"', "customTitle")
                if custom is not None:
                    return custom                             # a rename outranks any automatic title
                if ai is None:
                    ai = _record(block, b'"type":"ai-title"', "aiTitle")
                pos = start
    except OSError:
        pass
    return ai or ""


def titles_of(uuid, lin, tit, live_title=""):
    """Every title a session goes by. A /renamed session (overridden) has a stale last_written, and a
    session the title hook never saw has no row: both are read from the transcript's own title records."""
    t = tit.get(uuid) if isinstance(tit.get(uuid), dict) else {}
    out = [live_title, t.get("cached_custom") or "", t.get("cached_ai") or ""]
    if t.get("overridden") or (not t and not live_title):
        path = transcript(uuid)
        out.append(transcript_title(path) if path else "")
    else:
        out.append(t.get("last_written") or "")
    return [x for x in out if isinstance(x, str) and x]


def tab_sessions():
    """Every session herdr's tab record (herdr/record-herdr-tab.sh) has seen in a tab, newest occupants included."""
    tabs = jload(TABS).get("tabs") or {}
    out = set()
    for e in tabs.values() if isinstance(tabs, dict) else []:
        if isinstance(e, dict):
            out |= {u for u in [e.get("uuid")] + [h.get("uuid") for h in e.get("history") or [] if isinstance(h, dict)]
                    if isinstance(u, str)}
    return out


def is_chief(uuid, live_title="", lin=None, tit=None):
    lin = jload(LINEAGE) if lin is None else lin
    tit = jload(TITLES) if tit is None else tit
    if live_title and TITLE.match(live_title.strip()):    # the title on screen decides, no file reads
        return not (lin.get(uuid) or {}).get("closed") if isinstance(lin.get(uuid), dict) else True
    e = lin.get(uuid) if isinstance(lin.get(uuid), dict) else {}
    if e.get("closed"):
        return False
    if JOB in (e.get("prime_directive") or ""):
        return True
    return any(TITLE.match(t.strip()) for t in titles_of(uuid, lin, tit, live_title))


def agents():
    try:
        out = subprocess.run(["herdr", "agent", "list"], capture_output=True, text=True, timeout=20).stdout
        return json.loads(out)["result"]["agents"]
    except Exception:
        return None


def quiet_minutes(path):
    ts = None
    try:
        with open(path, "rb") as f:
            f.seek(0, 2); f.seek(max(0, f.tell() - 200000))
            for line in reversed(f.read().decode("utf-8", "replace").splitlines()):
                try:
                    ts = json.loads(line).get("timestamp")
                except ValueError:
                    continue
                if ts:
                    break
    except OSError:
        return -1
    if not ts:
        return -1
    return int((datetime.now(timezone.utc) - datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds() // 60)


def find():
    """("live", uuid, pane, tab, status) · ("stopped", uuid) · ("none",) · ("many", n)."""
    lin, tit = jload(LINEAGE), jload(TITLES)
    ags = agents() or []
    live = [a for a in ags if a.get("agent") in (None, "claude") and (a.get("agent_session") or {}).get("value")
            and is_chief(a["agent_session"]["value"], a.get("terminal_title_stripped") or a.get("name") or "", lin, tit)]
    if len(live) > 1:
        return ("many", len(live))
    if live:
        a = live[0]
        return ("live", a["agent_session"]["value"], a.get("pane_id"), a.get("tab_id"), a.get("agent_status"))
    # Stopped: only sessions the title store or herdr's tab record knows, never a scan of every transcript.
    known = [u for u in set(lin) | set(tit) | tab_sessions()
             if re.fullmatch(r"[0-9a-f-]{36}", u) and is_chief(u, "", lin, tit)]
    paths = {u: transcript(u) for u in known}
    known = [u for u in known if paths[u]]
    if not known:
        return ("none",)
    return ("stopped", max(known, key=lambda u: os.path.getmtime(paths[u])))


def main():
    r = find()
    if r[0] == "live":
        print("live", r[1], r[2], r[3], r[4], quiet_minutes(transcript(r[1])))
    else:
        print(*r)


if __name__ == "__main__":
    sys.exit(main())
