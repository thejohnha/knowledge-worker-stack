#!/usr/bin/env python3
"""herdr_session_grid.py — one picker for every herdr workspace and tab. User guide: README.md beside it.

Every workspace is a row, every tab a cell. A cell that held a Claude session keeps its place when
the tab is closed (parked, shown as P) and one keypress brings it back. herdr answers what is live;
this program's own file answers parked cells, their order and their labels — never both for one fact.

Keys:  arrows move   Enter open   n new session   p park   x forget (parked only)   d delete (parked only; the lineage's transcripts go to the Trash)   a archive (parked only; the lineage moves into an archive folder)   m grab/drop (reorder)   t rename the lineage's title
       r rename tab label   = push the grid's order onto herdr   R refresh   ? help   q quit
`hg` (or `hg go`) — go to the grid: creates the `herdr sessions` workspace at position 0 with one tab named for the herdr
session if missing, relaunches the grid there if the pane is back at a shell, and focuses it.
`hg run` — draw the grid in THIS pane; what `hg` types into the grid's own pane, not a verb to reach for.
`herdr_session_grid.py run --demo` — every name replaced by a placeholder, nothing written: a screenshot you can share.
`herdr_session_grid.py ensure` — from a LaunchAgent every minute: starts the grid in its pane after a herdr restart.
"""
import curses, hashlib, json, locale, os, re, socket, subprocess, sys, tempfile, time, fcntl, unicodedata
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import herdr_session_bookmarks as BM                          # bookmarks live in the grid file's "bookmarks" section

HOME = os.path.expanduser("~")
STATE = f"{HOME}/.claude/state/state_claude_session_grid.json"
TITLES = f"{HOME}/.claude/state/state_claude_session_titles.json"
LINEAGE = f"{HOME}/.claude/state/state_claude_session_title_lineage.json"
CURSOR = f"{HOME}/.claude/state/state_claude_session_grid_cursor.json"   # where the cursor was, so a restart lands on the same cell
KEPT_WORDS = f"{HOME}/.claude/state/state_claude_session_grid_undelivered_prompt.txt"   # `n`'s first-prompt words when the start or the delivery failed — typed once, never retyped
TABSTORE = f"{HOME}/.claude/state/state_claude_session_herdr_tabs.json"   # tab -> last session it held; what hr reads
SOCK = os.environ.get("HERDR_SOCKET_PATH") or f"{HOME}/.config/herdr/herdr.sock"
MANAGE = "herdr_session_manage.sh"   # the herdr session manager, on PATH
GRID_WS = "herdr sessions"   # the workspace hg go keeps first; one tab per herdr session, each running the grid

def _config(name):
    try:
        with open(f"{HOME}/.config/knowledge-worker-stack/{name}", encoding="utf-8") as fh: d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except Exception: return {}
GRID_CONFIG = _config("grid.json")   # {"archive_dir": "...", "categories": [[regex, workspace], ...]}; every key optional
# Account name -> CLAUDE_CONFIG_DIR. One account, "default" at ~/.claude, unless accounts.json names more.
ACCOUNT_DIRS = {k: os.path.expanduser(v) for k, v in {"default": "~/.claude", **_config("accounts.json")}.items() if isinstance(v, str)}
# Claude Code files each transcript under <config dir>/projects/<the folder it was started in, every character
# other than a letter or digit turned into ->. Every such folder of every account counts, the archive excepted.
PROJECT_ROOTS = list(dict.fromkeys(os.path.realpath(os.path.join(d, "projects")) for d in ACCOUNT_DIRS.values()))
ARCHIVE = os.path.expanduser(GRID_CONFIG.get("archive_dir") or "~/.claude/projects/-archive")   # one folder per topic; the A side lists them
def _categories():
    out = []
    for x in GRID_CONFIG.get("categories") or []:
        try:
            if isinstance(x, list) and len(x) == 2 and all(isinstance(s, str) and s for s in x): re.compile(x[0]); out.append(tuple(x))
        except re.error: pass                                    # a broken pattern is skipped, never fatal
    return out
# Title regex -> name: a lineage with no cell yet is placed in the row of that name, and `a`'s folder guess is
# the archive folder of that name. First match wins; matched case-insensitively. Empty unless configured.
CATEGORIES = _categories()
UNSORTED = "unsorted"   # the row an adopted lineage lands in when nothing else names one
ACCOUNTS = f"{HOME}/.claude/state/state_claude_session_accounts.json"   # uuid -> account; absent = default
WAKES = f"{HOME}/.claude/state/state_claude_frontdesk"     # the comms manager's wake requests: one <name>.json each, gone once disarmed; absent = none
# The first prompt `n` sends when a few words were typed: the words as typed, so the first turn does the work.
SEED = "{words}"
README = ("The grid's own memory: workspace row order, and per workspace the ordered cells. A cell with "
          "tab=null is PARKED — no herdr tab, session on disk, reopened by Enter. Live cells mirror herdr "
          "and are rewritten on every refresh; only parked cells, order and labels are authoritative here. "
          "Written by herdr_session_grid.py.")
# A lineage is a title minus date, marker and number: group 3 is its key. The number sits in group 6, LAST,
# after an ", originally: …" breadcrumb, or in group 4 in the older shape.
SPLIT = re.compile(r"^(\d{8}\s+)?((?:⭐|☑️|[1-9]️⃣)\s+)?(.*?)(\s+\d{1,3})?(,\s+originally:.*?)?(\s+\d{1,3})?$")

# ---------------------------------------------------------------- herdr
def herdr(*args):
    r = subprocess.run(["herdr", *args], capture_output=True, text=True, timeout=20)
    try: return json.loads(r.stdout)
    except Exception: return {}

def manage(*args, timeout=120):
    """Run the session manager. Missing from PATH reads as a failed run with a message, never a crash."""
    try: return subprocess.run([MANAGE, *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError: return subprocess.CompletedProcess([MANAGE, *args], 127, "", f"{MANAGE} is not on PATH — install the herdr session manager")

def last_line(text, n=120):
    """A failed subprocess's output, fit for the message line: its LAST non-empty line, whitespace collapsed,
    at most n chars: curses returns ERR for a newline on the bottom row, which would kill the grid."""
    lines = [" ".join(l.split()) for l in (text or "").splitlines()]
    lines = [l for l in lines if l]
    return (lines[-1] if lines else "")[-n:]

def sock(method, params):
    """One JSON line on the unix socket; the CLI has no verb for tab.move."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(3)
    try:
        s.connect(SOCK); s.sendall((json.dumps({"id": "grid", "method": method, "params": params}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk: break
            buf += chunk
        return json.loads(buf or b"{}")
    except Exception as e:
        return {"error": {"message": str(e)}}
    finally: s.close()

def snapshot():
    """workspaces in herdr order, tabs per workspace in herdr order, agent per tab, first pane per tab."""
    snap = herdr("api", "snapshot").get("result", {}).get("snapshot", {})
    ws = [(w["workspace_id"], w.get("label") or w["workspace_id"]) for w in snap.get("workspaces", [])]
    tabs = {}
    for t in snap.get("tabs", []): tabs.setdefault(t["workspace_id"], []).append((t["tab_id"], t.get("label") or ""))
    agents = {a["tab_id"]: (a["agent_session"]["value"], a.get("agent_status", "unknown"))
              for a in snap.get("agents", []) if (a.get("agent_session") or {}).get("kind") == "id"}
    panes = {}
    for p in snap.get("panes", []): panes.setdefault(p["tab_id"], p["pane_id"])
    return ws, tabs, agents, panes, snap.get("focused_tab_id", "")

# ---------------------------------------------------------------- stores
def jload(p, default):
    try:
        with open(p) as fh: return json.load(fh)
    except Exception: return default

_INDEX = (0.0, {})
def transcripts():
    """uuid -> transcript path, across every project folder of every account, the archive folder excepted.
    Re-listed at most every 2 s; forget_index() drops it after a move."""
    global _INDEX
    if time.time() - _INDEX[0] < 2: return _INDEX[1]
    arch, out = os.path.realpath(ARCHIVE), {}
    for root in PROJECT_ROOTS:
        try: folders = sorted(os.listdir(root))
        except OSError: continue
        for d in folders:
            p = os.path.join(root, d)
            if not os.path.isdir(p) or os.path.realpath(p) == arch: continue
            try: names = os.listdir(p)
            except OSError: continue
            for f in names:
                if f.endswith(".jsonl"): out.setdefault(f[:-6], os.path.join(p, f))
    _INDEX = (time.time(), out); return out

def forget_index():
    global _INDEX; _INDEX = (0.0, {})

def project_folder(path, account):
    """The folder Claude Code looks in to resume this session: <the account's config dir>/projects/ plus the
    directory it was started in (the transcript's own "cwd") with every non-alphanumeric character turned into
    -; the home directory's folder when the transcript names none."""
    cwd = ""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if '"cwd"' in line:
                    try: cwd = json.loads(line).get("cwd") or ""
                    except Exception: pass
                if cwd or i > 500: break
    except OSError: pass
    root = os.path.join(ACCOUNT_DIRS.get(account) or ACCOUNT_DIRS["default"], "projects")
    return os.path.join(root, re.sub(r"[^A-Za-z0-9]", "-", cwd or HOME))

def live_sessions():
    """Every session id with a running process: the PID registries of every configured account (each
    entry gated on its pid being alive — a stale file outlives its process) unioned with the
    --resume/--session-id flags in ps. Any doubt resolves to LIVE: over-including costs one skipped
    delete, under-including deletes a running session's transcript, which Claude Code then recreates as a
    ghost stub. Returns (live set, coverage ok) — coverage fails when a claude process yields no id."""
    import glob
    ps = subprocess.run(["ps", "-eo", "pid,command"], capture_output=True, text=True).stdout.splitlines()
    procs = {}
    for l in ps:
        l = l.strip()
        if not l or not l[0].isdigit(): continue
        pid, cmd = l.split(None, 1)
        if re.search(r"(^|/)claude( |$)", cmd): procs[int(pid)] = cmd
    def alive(pid):
        try: os.kill(pid, 0); return True
        except ProcessLookupError: return False
        except Exception: return True
    live, covered = set(), set()
    for pid, cmd in procs.items():
        m = re.search(r"--(?:resume|session-id) ([0-9a-f-]{36})", cmd)
        if m: live.add(m.group(1)); covered.add(pid)
    for d in dict.fromkeys(ACCOUNT_DIRS.values()):
        for reg in glob.glob(f"{d}/sessions/*.json"):
            r = jload(reg, {}) or {}
            pid, sid = r.get("pid"), r.get("sessionId")
            if sid and isinstance(pid, int) and alive(pid): live.add(sid); covered.add(pid)
    # A claude under a CLAUDE_CONFIG_DIR that is none of the accounts (a clean-room test) registers and writes
    # transcripts THERE, so it cannot own one here. Covered only when that folder's projects/ is provably
    # none of ours; any doubt stays uncovered.
    # Claude Code's background daemon (`claude daemon run`) keeps a pre-started spare (`bg-pty-host` and its
    # `bg-spare` child) with no session id. A claimed spare is a background session and registers its pid
    # above, so its id is already counted; the daemon, its terminal hosts and an unclaimed spare own no transcript.
    covered |= {pid for pid, cmd in procs.items() if re.search(r"(^|/)claude (daemon run|bg-pty-host|bg-spare)( |$)", cmd)}
    for pid in set(procs) - covered:
        env = subprocess.run(["ps", "-E", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
        m = re.search(r"(?:^| )CLAUDE_CONFIG_DIR=(\S+)", env)
        if not m or not os.path.isdir(m.group(1)) or os.path.realpath(os.path.join(m.group(1), "projects")) in PROJECT_ROOTS: continue
        sid = (jload(os.path.join(m.group(1), "sessions", f"{pid}.json"), {}) or {}).get("sessionId")
        if sid: live.add(sid)
        covered.add(pid)
    return live, not (set(procs) - covered)

def transcript_title(path):
    """The transcript's last custom-title, by a backwards byte scan: a large transcript is never read whole."""
    import mmap
    try:
        if not os.path.getsize(path): return ""
        with open(path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            pos = len(mm)
            while True:
                i = mm.rfind(b'"custom-title"', 0, pos)
                if i < 0: return ""
                s, e = mm.rfind(b"\n", 0, i) + 1, mm.find(b"\n", i)
                try: d = json.loads(mm[s:e if e >= 0 else len(mm)])
                except Exception: d = None
                if isinstance(d, dict) and d.get("type") == "custom-title": return d.get("customTitle", "")
                pos = i
    except OSError: return ""

def lineage_members(uuid, titles):
    """Every session id whose title shares this one's lineage key and whose transcript is on disk, the
    session itself included. A cell stands for its lineage, so deleting the cell deletes the lineage.
    The title is the TRANSCRIPT's; the titles store only fills in where a transcript has none, since it is
    a cache for live sessions and goes stale for dormant ones renamed by transcript append."""
    def key(u): return lineage_key(title_of(u, titles), u)
    want, out, paths = key(uuid), {uuid}, transcripts()
    if want != uuid:
        for u in paths:
            if key(u) == want: out.add(u)
    return sorted(u for u in out if u in paths and os.path.isfile(paths[u]))

def trash(paths):
    """To the macOS Trash, recoverable, never rm: the system's `trash` (newer macOS ships /usr/bin/trash),
    else one on PATH (Homebrew's), else Finder. Returns True when every path is gone."""
    paths = [p for p in paths if os.path.exists(p)]
    if not paths: return True
    import shutil
    tool = "/usr/bin/trash" if os.access("/usr/bin/trash", os.X_OK) else shutil.which("trash")
    try:
        if tool: subprocess.run([tool] + paths, capture_output=True, text=True, timeout=60)
        else: subprocess.run(["osascript", "-e", "on run argv", "-e", "repeat with p in argv",
                              "-e", 'tell application "Finder" to delete (POSIX file (p as text) as alias)',
                              "-e", "end repeat", "-e", "end run"] + paths, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired): pass
    return not any(os.path.exists(p) for p in paths)

def trash_transcript(uuid):
    """The transcript and its sibling folder to the Trash. Returns True when both are gone."""
    t = transcripts().get(uuid)
    if not t: return True
    ok = trash([t, t[:-6]]); forget_index(); return ok

def archive_buckets():
    try: return sorted((d for d in os.listdir(ARCHIVE) if os.path.isdir(f"{ARCHIVE}/{d}") and not d.startswith(".")), key=str.lower)
    except OSError: return []

def guess_bucket(uuid, titles):
    """The folder already holding an archived member of this lineage, else the folder CATEGORIES names for
    the title, when it exists, else "". The prompt shows it prefilled; nothing is filed on a guess."""
    title = title_of(uuid, titles); key = lineage_key(title, uuid)
    buckets = archive_buckets()
    if key != uuid:
        for b in buckets:
            for f in os.listdir(f"{ARCHIVE}/{b}"):
                if f.endswith(".jsonl") and lineage_key(transcript_title(f"{ARCHIVE}/{b}/{f}"), f[:-6]) == key: return b
    for pat, b in CATEGORIES:
        if re.search(pat, title or "", re.I):
            return next((x for x in buckets if x.lower() == b.lower()), "")
    return ""

def archive_transcript(uuid, bucket):
    """Archive one session: the transcript and its sibling folder move into the bucket. Refuses to
    overwrite a same-named file there. Returns True when the move is proven on both ends."""
    import shutil
    src, dest = transcripts().get(uuid, ""), f"{ARCHIVE}/{bucket}"
    if not src or os.path.exists(f"{dest}/{uuid}.jsonl") or os.path.exists(f"{dest}/{uuid}"): return False
    side = src[:-6]                                              # the sibling folder: subagents, tool output
    shutil.move(src, f"{dest}/{uuid}.jsonl")
    if os.path.isdir(side): shutil.move(side, f"{dest}/{uuid}")
    forget_index()
    return os.path.isfile(f"{dest}/{uuid}.jsonl") and not os.path.exists(src) and not os.path.exists(side)

_TITLE_AT = {}
def title_at(p):
    """transcript_title cached on size and mtime, for paths in any folder."""
    try: st = os.stat(p); sig = (st.st_size, st.st_mtime_ns)
    except OSError: return ""
    hit = _TITLE_AT.get(p)
    if not hit or hit[0] != sig: hit = _TITLE_AT[p] = (sig, transcript_title(p))
    return hit[1]

def lineage_rows(uuid):
    """(uuid, title, path) for every session of this one's lineage, live AND archived, newest first: a rename
    that skipped the archived members would strip them of the key that finds them. [] when the session has
    no title to key on."""
    paths = {}
    for b in archive_buckets():
        try: paths.update({f[:-6]: f"{ARCHIVE}/{b}/{f}" for f in os.listdir(f"{ARCHIVE}/{b}") if f.endswith(".jsonl")})
        except OSError: pass
    paths.update(transcripts())                                  # a live copy wins over a stale archived twin
    t = title_at(paths[uuid]) if uuid in paths else ""; want = lineage_key(t, uuid)
    if not t or want == uuid: return []
    rows = []
    for u, p in paths.items():
        tt = title_at(p)
        if tt and lineage_key(tt, u) == want:
            try: rows.append((os.path.getmtime(p), u, tt, p))
            except OSError: pass
    return [(u, tt, p) for _, u, tt, p in sorted(rows, reverse=True)]

def rewrite_store(path, mutate):
    """Read-modify-write one JSON store under the lock its other writers take: a DIRECTORY at <path>.lock,
    cleared when older than 30 s."""
    lock = path + ".lock"
    for _ in range(40):
        try: os.mkdir(lock)
        except FileExistsError:
            try:
                if time.time() - os.stat(lock).st_mtime > 30: os.rmdir(lock); continue
            except OSError: pass
            time.sleep(0.05); continue
        try:
            d = jload(path, {})
            if not isinstance(d, dict): return
            mutate(d)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh: json.dump(d, fh, indent=2, ensure_ascii=False)
                os.chmod(tmp, 0o640); os.replace(tmp, path)
            except BaseException:
                os.unlink(tmp); raise
        finally: os.rmdir(lock)
        return
    raise OSError(f"could not take {lock}")

def retitle(rows, new):
    """Append a custom-title with the new description to every member — its own date, marker,
    breadcrumb and number kept, mtime kept (a rename is not activity) — then carry the rename into
    the title stores, when they exist, so a later resume cannot bring the old name back. Every transcript
    is checked writable before the first is touched. Returns the count renamed."""
    if not all(os.access(p, os.W_OK) for _, _, p in rows): raise OSError("a transcript is not writable — nothing renamed")
    old, done = lineage_key(rows[0][1], rows[0][0]), []
    for u, cur, p in rows:
        m = SPLIT.match(cur)
        date, mark, _d, n1, suf, n2 = (m.group(i) or "" for i in range(1, 7)) if m else ("",) * 6
        if n1: suf, n2 = suf + n2, n1                           # older shape: the number moves LAST, after the breadcrumb
        title = f"{mark}{new}{suf}{n2}"
        mt = os.path.getmtime(p)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"type": "custom-title", "customTitle": f"{date}{title}", "sessionId": u}, separators=(",", ":"), ensure_ascii=False) + "\n")
        os.utime(p, (mt, mt))
        done.append((u, title))
    def stage(d):                                                # the title hook re-applies this on the next resume
        for u, title in done:
            e = dict(d.get(u) or {}); e["pending_title"] = title; e.pop("overridden", None); d[u] = e
    def relineage(d):                                            # /retitle renders "<cat> <chain[-1]>, originally: …"
        for u, _ in done:
            e = d.get(u)
            if not isinstance(e, dict) or not isinstance(e.get("chain"), list): continue
            cat = str(e.get("cat") or "")
            body_old = old[len(cat) + 1:] if cat and old.startswith(cat + " ") else old
            if cat and new.startswith(cat + " "): body_new = new[len(cat) + 1:]
            else: body_new, e["cat"] = new, ""                   # a description that drops the category: the renderer must not put it back
            e["chain"] = [f"{body_new}{SPLIT.match(c).group(4) or ''}" if isinstance(c, str) and SPLIT.match(c) and SPLIT.match(c).group(3).strip() == body_old else c
                          for c in e["chain"]]
    if os.path.isfile(LINEAGE): rewrite_store(LINEAGE, relineage)
    if os.path.isfile(TITLES): rewrite_store(TITLES, stage)
    return len(done)

_TITLE = {}
ARCH_TITLES = {}                                                # uuid -> title for archived cells, filled by archive_rows()
_ARCH_T = {}
def archive_rows():
    """The archived side: one row per archive folder, one cell per lineage — its newest member (highest number,
    then newest file) — in the folder holding that member. Newest first within a row; nothing here is stored."""
    best = {}
    for b in archive_buckets():
        for f in os.listdir(f"{ARCHIVE}/{b}"):
            if not f.endswith(".jsonl"): continue
            u, p = f[:-6], f"{ARCHIVE}/{b}/{f}"
            try: mt = os.path.getmtime(p)
            except OSError: continue
            hit = _ARCH_T.get(p)
            if not hit or hit[0] != mt: hit = _ARCH_T[p] = (mt, transcript_title(p))
            t = hit[1]; ARCH_TITLES[u] = t
            k = lineage_key(t, u); rank = (lineage_number(t), mt)
            if k not in best or rank > best[k][0]: best[k] = (rank, b, u, k)
    rows = {}
    for rank, b, u, k in best.values(): rows.setdefault(b, []).append({"uuid": u, "tab": None, "label": k[:60], "archived": b, "mt": rank[1]})
    return [(f"arch:{b}", {"label": b, "cells": sorted(rows[b], key=lambda c: -c["mt"])}) for b in sorted(rows, key=str.lower)]

def title_of(uuid, titles):
    """The title the session manager reads: the transcript's own last custom-title, cached on size and mtime;
    the titles store only where the transcript has none. The store goes stale for a dormant session renamed
    by transcript append, and keying on it would split one lineage into two cells."""
    p = transcripts().get(uuid, "")
    try: st = os.stat(p); sig = (st.st_size, st.st_mtime_ns)
    except OSError: sig = None
    if sig:
        hit = _TITLE.get(uuid)
        if not hit or hit[0] != sig: hit = _TITLE[uuid] = (sig, transcript_title(p))
        if hit[1]: return hit[1]
    if uuid in ARCH_TITLES: return ARCH_TITLES[uuid]               # the archived side: its transcript is in no project folder
    t = titles.get(uuid)
    if not isinstance(t, dict): return ""
    return t.get("last_written") or t.get("cached_custom") or t.get("cached_ai") or ""

def waiting_keys(titles):
    """Lineage key -> what each of its armed wake requests waits for. A file there is armed: the comms manager
    deletes it on expiry, removal or a one-shot's delivery. The owner may be an older member; the key matches it."""
    out = {}
    for f in sorted(os.listdir(WAKES)) if os.path.isdir(WAKES) else []:
        if not f.endswith(".json"): continue
        r = jload(f"{WAKES}/{f}", {})
        u = r.get("owner") if isinstance(r, dict) else None
        if u: out.setdefault(lineage_key(title_of(u, titles), u), []).append(r.get("what") or f[:-5])
    return out

def lineage_key(title, uuid):
    m = SPLIT.match(title or ""); base = (m.group(3) or "").strip() if m else ""   # the ", originally: …" breadcrumb is group 5, not part of the key
    return base or uuid

def lineage_number(title):
    m = SPLIT.match(title or ""); n = (m.group(4) or m.group(6) or "").strip() if m else ""
    return int(n) if n else -1

def newest_member(uuid, titles):
    """Highest-numbered member of this session's lineage, by the transcripts' titles; the uuid itself if none
    is higher. The manager's resume redirects to the same member, so the grid must name the same one."""
    best, best_n = uuid, lineage_number(title_of(uuid, titles))
    for u in lineage_members(uuid, titles):
        if lineage_number(title_of(u, titles)) > best_n: best, best_n = u, lineage_number(title_of(u, titles))
    return best

_CTX = {}
def ctx_of(path):
    """Context tokens of the LAST assistant record: input + cache_read + cache_creation — the same sum
    the statusline shows as Cx and the auto-successor cron thresholds on. Reads the tail only; cached by mtime."""
    try: mt = os.path.getmtime(path)
    except OSError: return None
    k = (path, mt)
    if k in _CTX: return _CTX[k]
    val = None
    try:
        with open(path, "rb") as fh:
            fh.seek(max(0, os.path.getsize(path) - 4_000_000)); tail = fh.read().decode("utf-8", "replace")
        for line in reversed(tail.splitlines()):
            if '"assistant"' not in line or '"usage"' not in line: continue
            try: r = json.loads(line)
            except Exception: continue
            u = (r.get("message") or {}).get("usage") or {}
            if (r.get("message") or {}).get("model") == "<synthetic>": continue   # Claude Code's own error stand-in ("API Error: …") carries all-zero usage
            if r.get("type") == "assistant" and u.get("input_tokens") is not None:
                val = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0); break
    except OSError: pass
    _CTX.clear(); _CTX[k] = val; return val

def fmt_tokens(n):
    return f"{n/1_000_000:.1f}M".replace(".0M", "M") if n >= 1_000_000 else f"{n/1000:.0f}k" if n >= 1000 else str(n)

def ctx_kind(n):
    """Statusline's smart-zone tiers in absolute tokens: green under 150k, yellow to 200k, red past it."""
    return "ctx_ok" if n < 150_000 else "ctx_warn" if n < 200_000 else "ctx_crit"

def transcript(uuid):
    p = transcripts().get(uuid)
    if p and os.path.exists(p): return p
    for b in archive_buckets():                                 # the archived side's cells live one level deeper
        p = f"{ARCHIVE}/{b}/{uuid}.jsonl"
        if os.path.exists(p): return p
    return ""

def load_state():
    st = jload(STATE, {})
    if not isinstance(st, dict) or "workspaces" not in st: st = {"order": [], "workspaces": {}}
    return st

DEMO = False                                                 # `run --demo`: every name a placeholder, nothing written, nothing reordered — for a screenshot that can be shared
DEMO_WS = [f"project-{c}" for c in "abcdefghijklmnopqrstuvwxyz"]
def demo_ws(i, label): return label if not DEMO else DEMO_WS[i % len(DEMO_WS)] + ("" if i < len(DEMO_WS) else str(i // len(DEMO_WS)))
def demo_n(uuid): return int(hashlib.sha1(("demo " + uuid).encode()).hexdigest(), 16) % 90 + 10   # a stable two-digit stand-in per session
def save_state(st):
    if DEMO: return
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    out = {"_readme": README, "order": st["order"], "workspaces": st["workspaces"], "forgotten": st.get("forgotten") or []}
    with open(STATE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        out["bookmarks"] = jload(STATE, {}).get("bookmarks") or {}   # written only by herdr_session_bookmarks.py: carry the disk copy, never a stale one
        tmp = STATE + ".tmp"
        with open(tmp, "w") as fh: json.dump(out, fh, indent=1, ensure_ascii=False); fh.write("\n")
        os.replace(tmp, STATE)
    global _saved_at; _saved_at = os.path.getmtime(STATE)
_saved_at = 0.0

# ---------------------------------------------------------------- model
VIEWS = ["all", "focus", "running"]
VIEW_NAMES = {"all": "all cells", "focus": "running + bookmarked", "running": "running only"}


def follow(seq, live, key):
    """`live` items in `live`'s order; every other item of `seq` stays right behind the item it follows now."""
    after, prev = {}, None
    for x in seq:
        if any(key(x) == key(y) for y in live): prev = key(x)
        else: after.setdefault(prev, []).append(x)
    out = list(after.get(None, []))
    for x in live: out += [x] + after.get(key(x), [])
    return out


_ACT = {}
def activity(c):
    """Last activity of a cell: its transcript's mtime, cached a few seconds; a shell or a missing transcript sorts last."""
    u = c.get("uuid") or ""
    hit = _ACT.get(u)
    if hit and time.time() - hit[0] < 5: return hit[1]
    p = transcript(u) if u else ""
    try: v = os.path.getmtime(p) if p else 0.0
    except OSError: v = 0.0
    _ACT[u] = (time.time(), v); return v


class Grid:
    def __init__(self):
        self.st = load_state(); self.titles = {}; self.lineage = {}; self.tabstore = {}; self.accounts = {}; self.waiting = {}
        self.ws = []; self.tabs = {}; self.agents = {}; self.panes = {}; self.focused = ""
        self.row = 0; self.col = 0; self.want_col = 0; self.grab = False; self.msg = ""
        self.jobs = []                                           # resumes running in the background, see resume_bg
        self.parent_of = {}                                      # subgroups, rebuilt by nest() on every rows() call
        self.side = "live"; self.arch = []; self.pending = ""    # `A` flips to the archived side (self.arch, built on the flip); pending = a uuid to put the cursor on once it shows
        self.query = ""; self.typing = False                     # `/` search: every word of the query must appear in the cell's label, title or prime directive
        self.order = "manual"                                    # `o` flips "manual" (the stored order) and "newest" (last activity first), display only
        self.view = "all"                                        # `v` cycles VIEWS: "all", "focus" = running + bookmarked, "running" = running only
        self.redraw = lambda: None                               # set by main(): paint the status line before a slow step
        self._cursor_saved = None

    def cursor_key(self):
        """The cell under the cursor by identity, not index: uuid first, then tab id, then the row's
        workspace with a column, so a restart finds it again after rows or cells have moved."""
        rows = self.rows(); c = self.cur()
        if not rows or not c: return None
        return {"ws": rows[self.row][0], "uuid": c.get("uuid"), "tab": c.get("tab"), "row": self.row, "col": self.col}

    def save_cursor(self):
        if DEMO: return
        """Idle tick and quit: write the cursor only when it moved. A sidecar file, not the grid file,
        so the hourly backup does not copy the grid for a cursor move."""
        k = self.cursor_key()
        if k is None or k == self._cursor_saved: return
        try:
            with open(CURSOR + ".tmp", "w") as fh: json.dump(k, fh)
            os.replace(CURSOR + ".tmp", CURSOR); self._cursor_saved = k
        except OSError: pass

    def restore_cursor(self):
        """Start: put the cursor back on the cell it was on, by uuid, else tab, else the same column
        in the same workspace row, else the top. Never raises: a stale or missing file means top-left."""
        k = jload(CURSOR, None)
        if not isinstance(k, dict): return
        rows = self.rows()
        for r, (w, e) in enumerate(rows):
            cells = e.get("cells") or []
            for j, c in enumerate(cells):
                if (k.get("uuid") and c.get("uuid") == k["uuid"]) or (k.get("tab") and c.get("tab") == k["tab"]):
                    self.row, self.col = r, j; self.want_col = j; self._cursor_saved = self.cursor_key(); return
        for r, (w, e) in enumerate(rows):
            if w == k.get("ws"):
                self.row = r; self.want_col = self.col = max(0, min(int(k.get("col") or 0), len(e.get("cells") or []) - 1))
                self._cursor_saved = self.cursor_key(); return

    def say(self, msg):
        self.msg = msg; self.redraw()

    def refresh(self):
        try:                                                     # another writer (a script, a second grid) since
            if os.path.getmtime(STATE) > _saved_at: self.st = load_state()   # our last save: take its file, not ours
        except OSError: pass
        self.titles = jload(TITLES, {}); self.lineage = jload(LINEAGE, {})
        self.accounts = jload(ACCOUNTS, {}) or {}                # uuid -> account; absent = default
        self.waiting = waiting_keys(self.titles)                 # parked lineages the comms manager will reopen: drawn ◷
        self.tabstore = (jload(TABSTORE, {}) or {}).get("tabs", {}) or {}
        self.ws, self.tabs, self.agents, self.panes, self.focused = snapshot()
        if self.pin_own_tab(): self.ws, self.tabs, self.agents, self.panes, self.focused = snapshot()
        self.reconcile(); self.pin_own_cell(); save_state(self.st)
        if self.pending and self.side == "live":                 # a session brought back from the archive: cursor onto it once its cell shows
            for r in range(len(self.rows())):
                for j, cc in enumerate(self.cells(r)):
                    if cc.get("uuid") == self.pending: self.row, self.col, self.want_col = r, j, j; self.pending = ""

    # The grid's own tab stays FIRST in its row, in herdr and in the file. Without the pin
    # a session cell saved ahead of it was pushed back onto herdr by every grid start, undoing a manual move.
    # Only this one tab is moved, so the order of the row's other tabs is left as it is.
    def pin_own_tab(self):
        me = os.environ.get("HERDR_TAB_ID")
        if DEMO or not me: return False
        for ts in self.tabs.values():
            ids = [t for t, _ in ts]
            if me in ids and ids[0] != me: return "error" not in sock("tab.move", {"tab_id": me, "insert_index": 0})
        return False

    def pin_own_cell(self):
        me = os.environ.get("HERDR_TAB_ID")
        for ent in self.st["workspaces"].values():
            c = next((c for c in ent["cells"] if me and c.get("tab") == me), None)
            if c and ent["cells"][0] is not c: ent["cells"].remove(c); ent["cells"].insert(0, c)

    def reconcile(self):
        """Live tabs are truth for what exists; the file is truth for parked cells, order, labels."""
        W = self.st["workspaces"]
        live_ws = {w: l for w, l in self.ws}
        all_live = {t for ts in self.tabs.values() for t, _ in ts}
        for ent in W.values():                                   # 1. tabs that went away, BEFORE attaching:
            for c in list(ent["cells"]):                         #    a cell mid-move still carries its old id
                if c.get("uuid"): c["key"] = lineage_key(title_of(c["uuid"], self.titles), c["uuid"])  # parked too: a key set by older code stays stale otherwise
                if c.get("tab") and c["tab"] not in all_live:
                    if c.get("uuid"): c["tab"] = None            # parked
                    else: ent["cells"].remove(c)                 # a shell has nothing to bring back
        def twin(uuid, key):                                     # a parked cell of this session or its lineage, anywhere
            for w2, e2 in W.items():
                for c in e2["cells"]:
                    if c.get("tab") is None and (c.get("uuid") == uuid or (key and c.get("key") == key)): return w2, c
            return None, None
        for w, label in self.ws:                                 # 2. every live tab has a cell
            # 2a. a reopened workspace takes over its CLOSED row of the same label: the row's position and
            # parked cells stay, under the new id. Live-vs-live twins are left alone: both can be real.
            # Without this a reopened workspace would sit as a second row of the same name while the old
            # one kept the lineage's parked siblings.
            # The label alone is not proof: herdr names every unlabeled new workspace "home", so a bare one
            # would take over a closed "home" row. The workspace must also hold a session of a lineage
            # parked in that row; until one arrives it waits.
            here = set()
            for tab, _ in self.tabs.get(w, []):
                u = self.agents.get(tab, ("", ""))[0] or ((self.tabstore.get(tab) or {}).get("uuid") if isinstance(self.tabstore.get(tab), dict) else "")
                if u: here.add(lineage_key(title_of(u, self.titles), u))
            for w2 in [x for x, e2 in W.items() if x != w and x not in live_ws and (e2.get("label") or "") == (label or "")
                       and here & {c.get("key") for c in e2["cells"] if c.get("key")}]:
                old = W.pop(w2); mine = W.pop(w, {"label": label, "cells": []})
                old["cells"] = old["cells"] + mine["cells"]; W[w] = old
                order = self.st["order"]
                if w2 in order: order[:] = [w if x == w2 else x for x in order if x != w]
                break
            ent = W.setdefault(w, {"label": label, "cells": []}); ent["label"] = label
            cells = ent["cells"]
            for tab, tlabel in self.tabs.get(w, []):
                uuid, _ = self.agents.get(tab, ("", ""))
                if not uuid:                                     # no agent: the tab store says what it last held
                    row = self.tabstore.get(tab) or {}
                    uuid = row.get("uuid") or "" if isinstance(row, dict) else ""
                key = lineage_key(title_of(uuid, self.titles), uuid) if uuid else ""
                cell = next((c for c in cells if c.get("tab") == tab), None)
                if cell is None:                                 # a parked twin is absorbed in step 3
                    cell = {"key": "", "uuid": "", "label": "", "tab": tab}; cells.append(cell)
                cell["tab"] = tab
                if tlabel: cell["label"] = tlabel
                if uuid: cell["uuid"], cell["key"] = uuid, key
        for w, ent in W.items():                                 # 3. one cell per lineage: a live cell absorbs any
            for c in list(ent["cells"]):                         #    parked twin, taking its slot when in the same row
                if not (c.get("tab") and c.get("uuid")): continue
                w2, p = twin(c["uuid"], c.get("key"))
                if not p: continue
                if not c.get("label"): c["label"] = p.get("label", "")
                if w2 == w:
                    idx = ent["cells"].index(p); ent["cells"].remove(p); ent["cells"].remove(c)
                    ent["cells"].insert(min(idx, len(ent["cells"])), c)
                else: W[w2]["cells"].remove(p)
        for w, ent in W.items():                                 # 3b. a tab dragged in herdr: the SAME tabs as last
            have = [t for t, _ in self.tabs.get(w, [])]          #     seen, in a new order — the cells follow. A tab
            seen = ent.get("seen")                               #     that just opened changes the set, so a resume or
            if seen and have and seen != have and sorted(seen) == sorted(have):   # `n` keeps the grid's slot
                live = [c for t in have for c in ent["cells"] if c.get("tab") == t]
                ent["cells"] = follow(ent["cells"], live, lambda c: c.get("tab"))
            if w in live_ws: ent["seen"] = have
        self.adopt(W)
        for w in list(W):                                        # 4. workspaces herdr no longer has
            if w not in live_ws and not any(c.get("uuid") for c in W[w]["cells"]): del W[w]
        # 5. row order: herdr's sidebar prevails for live workspaces, so a workspace dragged there (or newly
        #    made) shows in the same place here. A closed row has no herdr position; it stays right behind
        #    the row it follows now.
        order = follow([w for w in self.st["order"] if w in W], [w for w, _ in self.ws if w in W], lambda w: w)
        order += [w for w in W if w not in order]
        self.st["order"] = order
        self.clamp()

    def adopt(self, W):
        """3c. Every lineage with a titled transcript on disk has a cell, parked when it has no tab, so one last
        open before the grid existed, or run outside herdr, is reachable too. Skipped: untitled transcripts,
        and lineages `x` forgot. Archive and delete move the transcripts away, so
        those cells stay gone. Placement, first that applies: the row CATEGORIES names for the title (made as a
        closed row when no workspace has that name); the `<first>-<second>` subgroup row, then the `<first>` row,
        named like the title's first words; the row named like the lineage store's category; the UNSORTED row."""
        have = {c.get("key") for e in W.values() for c in e["cells"] if c.get("uuid")}
        forgot, best = set(self.st.get("forgotten") or []), {}
        for u, p in transcripts().items():
            t = title_of(u, self.titles)
            if not t: continue
            k = lineage_key(t, u)
            if k in have or k in forgot: continue
            try: r = (lineage_number(t), os.path.getmtime(p))
            except OSError: continue
            if k not in best or r > best[k][0]: best[k] = (r, u, t)
        if not best: return
        norm = lambda l: re.sub(r"^[^0-9A-Za-z]+", "", l or "").lower()
        rows = {}
        for w in [w for w, _ in self.ws if w in W] + [w for w in self.st["order"] if w in W]:
            rows.setdefault(norm(W[w].get("label")), w)          # a live row wins over a closed one of the same name
        def row_named(label):                                    # a closed row: opening a cell in it creates the workspace
            if norm(label) not in rows:
                w = "closed:" + norm(label); W.setdefault(w, {"label": label, "cells": []}); rows[norm(label)] = w
            return rows[norm(label)]
        for k, (r, u, t) in sorted(best.items(), key=lambda x: x[1][0][1]):   # oldest first, so the newest ends the row
            words = k.split(); cat = norm(words[0]) if words else ""
            sub = f"{cat}-{norm(words[1])}" if len(words) > 1 else ""
            rule = next((ws for pat, ws in CATEGORIES if re.search(pat, t, re.I)), None)
            w = row_named(rule) if rule else rows.get(sub) or rows.get(cat) or rows.get(norm((self.lineage.get(u) or {}).get("cat"))) or row_named(UNSORTED)
            rest = words if rule else words[2:] if w == rows.get(sub) else words[1:] if w == rows.get(cat) else words
            short = []                                           # whole words up to ~20 characters, no dangling "and"
            for x in rest:
                if short and len(" ".join(short + [x])) > 20: break
                short.append(x)
            while len(short) > 1 and (short[-1].lower() in ("and", "or", "on", "for", "to", "of", "the", "with", "in", "a") or not any(ch.isalnum() for ch in short[-1])): short.pop()
            n = r[0]; label = " ".join(short) + (f" {n:02d}" if n >= 0 else "")
            W[w]["cells"].append({"key": k, "uuid": u, "label": label, "tab": None})
            have.add(k)

    # ------------------------------------------------------------ navigation
    def all_rows(self): return [(w, self.st["workspaces"][w]) for w in self.st["order"]]
    def visible(self, c):
        """Focus view: a running session, a bookmarked cell, or the grid's own cell. Running view: the same less bookmarks."""
        if self.view == "all": return True
        if c.get("archived"): return self.marked(c)               # archived side: its second view is bookmarks only
        if c.get("tab") and c["tab"] == os.environ.get("HERDR_TAB_ID"): return True
        if self.view == "focus" and self.marked(c): return True
        return self.status(c) not in ("parked", "stopped", "shell", "empty")   # any live agent state, even one herdr adds later
    def matches(self, c):
        if not self.query: return True
        u = c.get("uuid") or ""
        hay = " ".join([c.get("label") or "", title_of(u, self.titles) if u else "", (self.lineage.get(u) or {}).get("prime_directive") or ""]).lower()
        return all(w in hay for w in self.query.lower().split())
    def shown(self, c): return self.visible(c) and self.matches(c)
    def rows(self):
        rows = self.arch if self.side == "archive" else self.all_rows()
        rows = rows if self.view == "all" and not self.query else [(w, e) for w, e in rows if any(self.shown(c) for c in e["cells"])]
        return self.nest(rows)
    def nest(self, rows):
        """Subgroups: a workspace labeled `<parent>-<sub>` (`project-a-reports`) moves right behind a
        shown workspace labeled `<parent>`, in herdr's order among its siblings. Sets self.parent_of {child ws: parent ws}."""
        key = lambda e: re.sub(r"^[^0-9A-Za-z]+", "", e.get("label") or "").lower()
        top = {key(e): w for w, e in rows if "-" not in key(e)}
        self.parent_of = {w: top[key(e).split("-", 1)[0]] for w, e in rows if "-" in key(e) and key(e).split("-", 1)[0] in top}
        kids = {}
        for w, e in rows:
            if w in self.parent_of: kids.setdefault(self.parent_of[w], []).append((w, e))
        out = []
        for w, e in rows:
            if w not in self.parent_of: out += [(w, e)] + kids.get(w, [])
        return out
    def cells(self, r):
        """What row r SHOWS. In the focus view this is a filtered copy: remove from rows()[r][1]["cells"]."""
        rows = self.rows()
        if not rows: return []
        cells = rows[r][1]["cells"]
        if self.view != "all" or self.query: cells = [c for c in cells if self.shown(c)]
        if self.order == "newest": cells = sorted(cells, key=lambda c: -activity(c))   # a copy: the stored order is untouched
        return cells
    def toggle_view(self):
        c = self.cur(); self.grab = False
        views = VIEWS[:2] if self.side == "archive" else VIEWS     # nothing runs on the archived side: all · bookmarked
        self.view = views[(views.index(self.view) + 1) % len(views)] if self.view in views else "all"
        for r in range(len(self.rows())):                        # keep the cursor on the same cell when it is still shown
            for j, cc in enumerate(self.cells(r)):
                if cc is c: self.row, self.col, self.want_col = r, j, j; self.msg = self.view_msg(); return
        self.clamp(); self.msg = self.view_msg()
    def toggle_order(self):
        c = self.cur(); self.grab = False
        self.order = "newest" if self.order == "manual" else "manual"
        for j, cc in enumerate(self.cells(self.row)):            # keep the cursor on the same cell
            if cc is c: self.col = self.want_col = j
        self.clamp(); self.msg = "order: " + ("newest first — o for your own order" if self.order == "newest" else "your own order — o for newest first")
    def view_msg(self):
        views = VIEWS[:2] if self.side == "archive" else VIEWS
        name = lambda v: "bookmarked" if self.side == "archive" and v == "focus" else VIEW_NAMES[v]
        nxt = views[(views.index(self.view) + 1) % len(views)]
        return f"view: {name(self.view)} — v shows {name(nxt)}"
    def flip(self):
        """`A`: between the live grid and the archived one. Each side keeps its own cursor; the view resets to all."""
        here = (self.row, self.col, self.want_col)
        self.side = "archive" if self.side == "live" else "live"; self.grab = False; self.view = "all"
        if self.side == "archive": self.arch = archive_rows()
        self.row, self.col, self.want_col = getattr(self, "_other", (0, 0, 0)); self._other = here; self.clamp()
        self.msg = ("archived sessions — Enter brings one back · b / v work · A back to live" if self.side == "archive" else "live grid")
    def unarchive(self, scr, c):
        """Enter on the archived side: pick a live workspace (the folder's own name when one exists), move the
        transcript back into the project folder it came from, resume it there in the background, and flip to
        the live grid."""
        uuid, b = c["uuid"], c["archived"]
        if DEMO: self.msg = "demo: nothing brought back"; return
        if uuid in transcripts(): self.msg = "already back among the live sessions"; return
        key = lambda l: re.sub(r"^[^0-9A-Za-z]+", "", l or "").lower()
        labels = {key(l): (w, l) for w, l in reversed(self.ws) if l}
        t = ARCH_TITLES.get(uuid, ""); m = re.match(r"^\d{8}\s+(?:\S+\s+)?([A-Za-z]+)", t)
        guess = next((labels[k][1] for k in (key(b), key(b).split("-")[0], (m.group(1).lower() if m else "")) if k in labels), b)
        name = prompt(scr, "bring back into workspace (Tab cycles, a new name makes one):", guess, sorted({l for _, l in self.ws if l}, key=str.lower))
        if not name: self.msg = "nothing brought back"; return
        src = f"{ARCHIVE}/{b}/{uuid}.jsonl"
        if not os.path.isfile(src): self.msg = "its transcript moved — R to refresh"; return
        home = project_folder(src, self.accounts.get(uuid)); dst = f"{home}/{uuid}.jsonl"
        if os.path.exists(dst) or os.path.exists(f"{home}/{uuid}"): self.msg = f"{dst} already exists — nothing moved"; return
        import shutil
        os.makedirs(home, exist_ok=True); shutil.move(src, dst)
        if os.path.isdir(f"{ARCHIVE}/{b}/{uuid}"): shutil.move(f"{ARCHIVE}/{b}/{uuid}", f"{home}/{uuid}")
        forget_index()
        ARCH_TITLES.pop(uuid, None); label = c.get("label") or "session"
        w, root, root_tab = labels.get(key(name), ("", ""))[0], "", ""
        if not w:
            out = herdr("workspace", "create", "--label", name, "--no-focus").get("result", {})
            w = (out.get("workspace") or {}).get("workspace_id", ""); root = (out.get("root_pane") or {}).get("pane_id", ""); root_tab = (out.get("root_pane") or {}).get("tab_id", "")
            if not w: self.msg = f"brought {label} back but could not make workspace {name} — claude --resume {uuid}"; return
        args = ["--pane", root] if root else ["--workspace", w, "--label", label, "--new-tab"]
        self.resume_bg({"uuid": uuid}, uuid, label, w, root_tab, args)
        self.flip(); self.pending = uuid
        self.msg = f"bringing back {label} into {name} in the background — the cursor lands on it once it shows"
    def clamp(self):
        n = len(self.rows()); self.row = max(0, min(self.row, n - 1))
        m = len(self.cells(self.row)) if n else 0
        self.col = max(0, min(self.want_col if not self.grab else self.col, m - 1))
    def cur(self):
        c = self.cells(self.row); return c[self.col] if c and 0 <= self.col < len(c) else None
    def find(self, c):
        """(row, col) where cell c is shown now, else the clamped cursor."""
        for r in range(len(self.rows())):
            for j, cc in enumerate(self.cells(r)):
                if cc is c: self.want_col = j; return r, j
        self.clamp(); return self.row, self.col

    def move(self, dr, dc):
        if self.grab: return self.drag(dr, dc)
        if dc: self.col = max(0, min(self.col + dc, len(self.cells(self.row)) - 1)); self.want_col = self.col
        if dr: self.row = max(0, min(self.row + dr, len(self.rows()) - 1))
        self.clamp()

    def drag(self, dr, dc):
        """Edits the STORED rows, so a filtered view (v, /) can move too and its hidden cells stay put: sideways the
        cell trades places with the next shown one; into another row it lands before the shown cell at its column."""
        rows = self.rows(); c = self.cur()
        if c is None: return
        at = lambda cells, x: next(k for k, y in enumerate(cells) if y is x)
        src = rows[self.row][1]["cells"]
        if dc:
            shown = self.cells(self.row); j = self.col + dc
            if not 0 <= j < len(shown): return
            a, b = at(src, c), at(src, shown[j]); src[a], src[b] = src[b], src[a]
        elif dr:
            i = self.row + dr
            if not 0 <= i < len(rows): return
            dest = rows[i][1]["cells"]; shown = self.cells(i)
            src.remove(c)
            dest.insert(at(dest, shown[self.col]) if self.col < len(shown) else at(dest, shown[-1]) + 1 if shown else len(dest), c)
        self.row, self.col = self.find(c)

    # ------------------------------------------------------------ status
    def status(self, c):
        if c is None: return "empty"
        if c.get("archived"): return "archived"
        if self.busy(c): return "resuming"
        if c.get("tab") is None: return "parked"
        if not c.get("uuid"): return "shell"
        if c["tab"] not in self.agents: return "stopped"         # tab open, session not running
        return self.agents[c["tab"]][1]

    def marked(self, c):
        """Bookmarked: the lineage is in the grid file's "bookmarks"."""
        if not c or not c.get("uuid"): return False
        return BM.is_marked(BM.load(), c["uuid"], title_of(c["uuid"], self.titles))

    def glyph(self, c):
        gch, cp = {"working": ("●", 2), "done": ("●", 1), "idle": ("○", 1), "blocked": ("●", 3),   # herdr's sidebar: yellow = working, green filled = done and not yet looked at, green hollow = looked at since; both greens wait for input
                   "parked": ("P", 4), "stopped": ("◌", 4), "resuming": ("◐", 2), "shell": ("·", 5), "archived": ("A", 4)}.get(self.status(c), ("○", 5))
        if not self.marked(c): return ("◷" if gch == "P" and self.waits(c) else gch, cp)   # parked, and reopens when its message arrives
        return ("☆" if gch == "○" else "★", cp)               # a bookmark keeps the status COLOR and the fill: hollow dot, hollow star

    def waits(self, c):
        """What the lineage's armed wake requests wait for; empty when it has none."""
        if not c or not c.get("uuid"): return []
        return self.waiting.get(c.get("key") or lineage_key(title_of(c["uuid"], self.titles), c["uuid"]), [])

    def toggle_mark(self):
        c = self.cur()
        if not c or not c.get("uuid"): self.msg = "bookmarks go on sessions, not shells"; return
        t = title_of(c["uuid"], self.titles)
        if DEMO: self.msg = "demo: nothing written"; return
        on = BM.set_mark(c["uuid"], t, not self.marked(c), c.get("label") or "")
        self.msg = ("bookmarked " if on else "unbookmarked ") + (c.get("label") or c["uuid"][:8])

    def next_marked(self):
        """Tab: jump to the next bookmarked cell in row-major order, wrapping; stays put if there is none."""
        rows = self.rows(); seq = [(r, j) for r in range(len(rows)) for j in range(len(self.cells(r)))]
        if not seq: return
        start = seq.index((self.row, self.col)) if (self.row, self.col) in seq else -1
        for k in range(1, len(seq) + 1):
            r, j = seq[(start + k) % len(seq)]
            if self.marked(self.cells(r)[j]): self.row, self.col, self.want_col = r, j, j; return
        self.msg = "no bookmarks — b sets one"

    # ------------------------------------------------------------ actions
    def order_pending(self):
        """Workspaces whose tab order differs from the grid. Row order is herdr's own (reconcile step 5)."""
        return sum(1 for w, e in self.all_rows() if [c["tab"] for c in e["cells"] if c.get("tab")] != [t for t, _ in self.tabs.get(w, [])])

    def apply_order(self, only_ws=None):
        """The grid's tab order prevails: reorder herdr's live tabs in each workspace to match the grid.
        Rows are not pushed — herdr's sidebar order is the row order. Every move goes to an EARLIER index,
        which sidesteps herdr's count-before-removal indexing."""
        moved = 0
        for w, ent in self.all_rows():
            if only_ws and w != only_ws: continue
            want = [c["tab"] for c in ent["cells"] if c.get("tab")]
            have = [t for t, _ in self.tabs.get(w, [])]
            if want == have or len(want) != len(have): continue
            for i, tab in enumerate(want):
                if have[i] != tab:
                    r = sock("tab.move", {"tab_id": tab, "insert_index": i})
                    if "error" in r: self.msg = f"tab.move {tab}: {r['error'].get('message')}"; return moved
                    have.remove(tab); have.insert(i, tab); moved += 1
        return moved

    def goto(self, tab):
        r = manage("goto", tab, timeout=30)
        if r.returncode == 127: self.msg = last_line(r.stderr)

    def open(self, scr=None):
        c = self.cur(); w = self.rows()[self.row][0] if self.rows() else ""
        if c is None: return
        if c.get("archived"): return self.unarchive(scr, c)
        if c.get("tab") and self.status(c) != "stopped": self.goto(c["tab"]); return
        if self.busy(c): self.msg = f"still resuming {c.get('label') or c['uuid'][:8]} — Enter again once it shows ●"; return
        uuid = newest_member(c["uuid"], self.titles)
        if c.get("tab"):                                         # stopped: resume in the tab it already has
            pane = self.panes.get(c["tab"], "")
            self.resume_bg(c, uuid, c.get("label") or pane, "", "", ["--pane", pane]); return
        label = c.get("label") or (lineage_key(title_of(uuid, self.titles), uuid) or "session")   # full description; herdr shortens it on screen
        root = root_tab = ""
        if w not in {x for x, _ in self.ws}:                     # its workspace was closed: rebuild it, same label,
            w, root, root_tab = self.recreate_workspace(w)       # same position, and resume into its root pane
            if not w: return
        args = ["--pane", root] if root else ["--workspace", w, "--label", label, "--new-tab"]
        self.resume_bg(c, uuid, label, w, root_tab, args)

    # The resume runs in the BACKGROUND and the grid keeps its keys: it is 10-30 s of Claude booting, and the
    # grid used to sit frozen for all of it. Deliberately no goto when it lands: wake several, then jump.
    def busy(self, c):
        return bool(c and c.get("uuid") and any(c["uuid"] in (j["cell"], j["uuid"]) for j in self.jobs))

    def resume_bg(self, c, uuid, label, w, root_tab, args):
        out = tempfile.TemporaryFile("w+")                       # a file, not a pipe: a failure prints the pane's last 12 lines
        try: p = subprocess.Popen([MANAGE, "resume", uuid, *args], stdout=out, stderr=subprocess.STDOUT, text=True)
        except FileNotFoundError: out.close(); self.msg = f"{MANAGE} is not on PATH — install the herdr session manager"; return
        self.jobs.append({"proc": p, "out": out, "cell": c["uuid"], "uuid": uuid, "label": label, "w": w, "root_tab": root_tab, "t0": time.time()})
        self.msg = f"resuming {label} in the background — keys stay live; Enter again once it shows ●"

    def poll_jobs(self):
        """Finish every resume that has exited: what open() used to do after its blocking wait. True if any did."""
        done = [j for j in self.jobs if j["proc"].poll() is not None or time.time() - j["t0"] > 180]
        if not done: return False
        msgs, landed = [], set()
        for j in done:
            self.jobs.remove(j)
            if j["proc"].poll() is None: j["proc"].kill(); j["proc"].wait(); j["out"].close(); msgs.append(f"{j['label']}: resume timed out after 180 s"); continue
            j["out"].seek(0); text = j["out"].read(); j["out"].close()
            if j["proc"].returncode != 0: msgs.append(f"{j['label']}: " + last_line(text)); continue
            if j["root_tab"]: herdr("tab", "rename", j["root_tab"], j["label"])
            for ent in self.st["workspaces"].values():           # the newest member's uuid, so reconcile re-attaches
                for c in ent["cells"]:                           # the parked cell in its own slot
                    if c.get("uuid") == j["cell"]: c["uuid"] = j["uuid"]
            msgs.append(f"resumed {j['label']} — Enter again to go there"); landed.add(j["w"])
        self.refresh()
        for w in landed - {""}: self.apply_order(w)
        save_state(self.st); self.msg = " · ".join(msgs)
        return True

    def new_session(self, scr):
        """`n`: start a new Claude session in the selected row's workspace. Tab label required; a few words
        optional, sent as the first prompt through SEED. Account follows the cell under the cursor (the
        neighbor is usually the same kind of work), model and effort are the defaults, the new cell takes the
        cursor's slot, and the cursor stays in the grid on it — like waking a parked one, Enter goes there."""
        rows = self.rows()
        if not rows: return
        w, ent = rows[self.row]
        # The grid's own row is allowed too: a session that manages the others often lives beside the grid.
        label = prompt(scr, "new session — tab label:")
        if not label: self.msg = "canceled — a tab label is required"; return
        words = prompt(scr, "a few words for its first prompt (Enter for none):")
        c = self.cur(); acct = self.accounts.get(c.get("uuid") or "", "") if c else ""
        root_tab = ""
        if w not in {x for x, _ in self.ws}:                     # a closed workspace: rebuild it at its row, same label
            w, _root, root_tab = self.recreate_workspace(w)
            if not w: return
        self.say(f"starting {label} in {ent['label']}{' as ' + acct if acct else ''} — 10-30 s …")
        args = ["start", label, "--workspace", w] + (["--account", acct] if acct else [])
        try: r = manage(*args, timeout=180)
        except subprocess.TimeoutExpired: self.msg = "start timed out after 180 s"; return
        if r.returncode != 0:
            self.msg = self.keep_words(words) + last_line(r.stdout + r.stderr)   # the kept file FIRST: the bottom row truncates at its right edge
            tabs = [t.get("tab_id") for t in herdr("tab", "list").get("result", {}).get("tabs", []) if t.get("workspace_id") == w]
            if root_tab and any(t != root_tab for t in tabs): herdr("tab", "close", root_tab)   # the manager made its tab before failing (the session may be up even when the report is not); the empty first tab must not outlive that
            return
        m = re.search(r"uuid=(\S+)", r.stdout); uuid = m.group(1) if m else ""
        m = re.search(r"tab=(\S+)", r.stdout); tab = m.group(1) if m else ""
        if root_tab: herdr("tab", "close", root_tab)              # the rebuilt workspace's empty first tab
        note = ""
        if words and uuid:
            self.say(f"started {label} — sending its first prompt, 10-30 s …")
            try: t = manage("tell", uuid, SEED.format(words=words), timeout=180)
            except subprocess.TimeoutExpired: t = None
            if t is None or t.returncode != 0: note = " — " + self.keep_words(words) + "the first prompt was NOT delivered"
        self.refresh()
        # herdr adds the tab last; the grid puts the new cell in the cursor's slot, shifting the cursor's cell
        # right, and apply_order carries that onto herdr. Cells are matched by session or tab, never by index
        # (`v` hides parked cells) nor by object (refresh reloads the file when another writer touched it).
        same = lambda x, u, t: bool((u and x.get("uuid") == u) or (t and x.get("tab") == t))
        cells = self.st["workspaces"].get(w, {}).get("cells", [])
        new = next((x for x in cells if same(x, uuid, tab)), None)
        if new is not None and c:
            rest = [x for x in cells if x is not new]
            at = next((i for i, x in enumerate(rest) if same(x, c.get("uuid"), c.get("tab"))), None)
            if at is not None: rest.insert(at, new); cells[:] = rest
        self.apply_order(w); save_state(self.st)
        for j, cc in enumerate(self.cells(self.row)):            # cursor onto the new cell
            if cc is new: self.col = self.want_col = j
        self.msg = f"started {label} — Enter to go there{note}"

    def keep_words(self, words):
        """A long first prompt must survive a failed start: write it to KEPT_WORDS and say where.
        Returns a message prefix ending in " — ", empty when there were no words."""
        if not words: return ""
        try:
            with open(KEPT_WORDS, "w") as f: f.write(words + "\n")
            return f"first prompt kept in {KEPT_WORDS.replace(HOME, '~')} — "
        except OSError: return "first prompt could NOT be saved — "

    def recreate_workspace(self, old):
        """A closed workspace with parked cells keeps its row; opening one of them brings the workspace back
        under a NEW id at the row's stored position, and the row is re-keyed to that id."""
        ent = self.st["workspaces"][old]
        out = herdr("workspace", "create", "--label", ent["label"], "--no-focus").get("result", {})
        new = (out.get("workspace") or {}).get("workspace_id")
        if not new: self.msg = f"could not recreate workspace {ent['label']}"; return "", "", ""
        root = out.get("root_pane") or {}                        # a new workspace arrives WITH one tab; use it
        pos = self.st["order"].index(old)
        live_ids = {x for x, _ in self.ws}                       # herdr's index skips rows whose workspace is closed
        hpos = sum(1 for x in self.st["order"][:pos] if x in live_ids)
        self.st["workspaces"][new] = self.st["workspaces"].pop(old)
        self.st["order"][pos] = new
        time.sleep(1); self.ws, self.tabs, self.agents, self.panes, self.focused = snapshot()
        if [x for x, _ in self.ws].index(new) != hpos:           # it lands last; move it back (backward move, index exact)
            sock("workspace.move", {"workspace_id": new, "insert_index": hpos})
        save_state(self.st); return new, root.get("pane_id", ""), root.get("tab_id", "")

    def park(self):
        c = self.cur()
        if not c or not c.get("tab"): self.msg = "nothing live to park"; return
        pane = self.panes.get(c["tab"], "")
        if c.get("uuid") and pane and self.status(c) != "stopped":
            self.say(f"parking {c.get('label') or c['tab']} — quitting its session …")
            r = manage("quit", pane)
            if r.returncode != 0: self.msg = last_line(r.stdout + r.stderr); return
        herdr("tab", "close", c["tab"]); self.msg = f"parked {c.get('label') or c['tab']}"
        self.refresh()

    def forget(self):
        c = self.cur()
        if not c or c.get("tab") is not None: self.msg = "forget works on a parked cell only"; return
        self.rows()[self.row][1]["cells"].remove(c)
        k = c.get("key") or lineage_key(title_of(c.get("uuid") or "", self.titles), c.get("uuid") or "")
        if k and k not in self.st.setdefault("forgotten", []): self.st["forgotten"].append(k)   # or adopt() brings it straight back
        save_state(self.st); self.clamp(); self.msg = "forgotten (transcript untouched)"

    def delete(self):
        """`d`: delete a PARKED cell's session and its whole lineage — the transcripts and their sibling
        folders go to the macOS Trash — and drop the cell. Two gates: parked only (a live cell is parked
        first, so nothing running here is ever deleted), and the live check (live_sessions) for every member,
        because a session can be running in a plain Terminal with no herdr tab at all. Any member found
        live refuses the WHOLE delete and is named — trashing the rest would strip a running lineage of its
        ancestors; if the check cannot see every claude process, nothing is deleted."""
        c = self.cur()
        if not c or c.get("tab") is not None: self.msg = "delete works on a parked cell only — park it first"; return
        uuid = c.get("uuid") or ""
        if not uuid: self.forget(); return
        members = lineage_members(uuid, self.titles)
        live, ok = live_sessions()
        if not ok: self.msg = "delete refused: a claude process has no readable session id, so the live check is blind"; return
        running = [u[:8] for u in members if u in live]
        if running: self.msg = f"delete refused: {len(running)} of the lineage still RUNNING ({' '.join(running)}) — nothing deleted"; return
        gone, failed = [], []
        for u in members: (gone if trash_transcript(u) else failed).append(u[:8])
        if not failed:
            self.rows()[self.row][1]["cells"].remove(c); save_state(self.st); self.clamp()
        note = f" — could not trash: {' '.join(failed)}" if failed else ""
        self.msg = f"deleted {len(gone)} transcript(s) to the Trash{note}" if gone else f"nothing deleted{note}"

    def archive(self, scr):
        """`a`: move a PARKED cell's whole lineage into a folder under ARCHIVE and drop the cell. Same gates as
        `d`, checked before the folder prompt and again after it, since the prompt can sit open. Asks once after the folder is chosen, naming a new folder."""
        c = self.cur()
        if not c or c.get("tab") is not None: self.msg = "archive works on a parked cell only — park it first"; return
        uuid = c.get("uuid") or ""
        if not uuid: self.msg = "nothing to archive — this cell holds no session"; return
        members = lineage_members(uuid, self.titles)
        if not members: self.msg = "no transcript for this session in the active folder — nothing to archive"; return
        def gate():
            live, ok = live_sessions()
            if not ok: return "archive refused: a claude process has no readable session id, so the live check is blind"
            running = [u[:8] for u in members if u in live]
            return f"archive refused: {len(running)} of the lineage still RUNNING ({' '.join(running)}) — nothing moved" if running else ""
        if (why := gate()): self.msg = why; return
        bucket = prompt(scr, f"archive {len(members)} transcript(s) to folder (Tab cycles):", guess_bucket(uuid, self.titles), archive_buckets())
        if not bucket: self.msg = "archive canceled — nothing moved"; return
        if "/" in bucket or bucket.startswith("."): self.msg = f"'{bucket}' is not a folder name — nothing moved"; return
        new = not os.path.isdir(f"{ARCHIVE}/{bucket}")
        name = c.get("label") or uuid[:8]
        if not confirm(scr, f"archive '{name}' — {len(members)} transcript(s) to {bucket}" + (" (a NEW folder, created now)" if new else "") + ", cell dropped?"):
            self.msg = "archive canceled — nothing moved"; return
        if new: os.makedirs(f"{ARCHIVE}/{bucket}")
        if (why := gate()): self.msg = why; return
        moved, failed = [], []
        for u in members: (moved if archive_transcript(u, bucket) else failed).append(u[:8])
        if not failed:
            self.rows()[self.row][1]["cells"].remove(c); save_state(self.st); self.clamp()
        self.msg = f"archived {len(moved)} transcript(s) to {bucket}" + (f" — could not move: {' '.join(failed)}" if failed else "")

    def rename_lineage(self, scr):
        """`t`: rename the TITLE of the cell's whole lineage, live and archived members alike. Lists them, then
        asks for the new description prefilled with the current one; each member keeps its own date, marker
        and number. ALL-OR-NOTHING: any member running anywhere refuses the whole rename, checked before the
        prompt and again after it, because a partial rename splits the lineage on the very key that defines
        it and nothing reports the orphan. The list is the check: no rule can tell a topic that ends in a
        number from a numbered member, so it is shown before the prompt."""
        uuid = (self.cur() or {}).get("uuid")
        if not uuid: self.msg = "no session in this cell to rename"; return
        if DEMO: self.msg = "demo: nothing renamed"; return
        rows = lineage_rows(uuid)
        if not rows: self.msg = "this session has no title to rename — give it one with /rename first"; return
        def gate():
            live, ok = live_sessions()
            if not ok: return "rename refused: a claude process has no readable session id, so the live check is blind"
            running = [u[:8] for u, _, _ in rows if u in live]
            return f"rename refused: {len(running)} of the lineage still RUNNING ({' '.join(running)}) — exit them first; nothing renamed" if running else ""
        if (why := gate()): self.msg = why; return
        key = lineage_key(rows[0][1], rows[0][0])
        scr.erase(); H, W = scr.getmaxyx(); arch = os.path.realpath(ARCHIVE) + os.sep
        scr.addnstr(0, 0, f" Rename this lineage — {len(rows)} session(s), each keeps its own date, marker and number:", W - 1, curses.A_BOLD)
        for i, (u, t, p) in enumerate(rows):
            if 2 + i >= H - 2: scr.addnstr(2 + i, 2, f"… and {len(rows) - i} more", W - 3, curses.A_DIM); break
            scr.addnstr(2 + i, 2, t + ("   [archived]" if os.path.realpath(p).startswith(arch) else ""), W - 3)
        new = re.sub(r"^(.*[^0-9\s])\s+[0-9]{1,3}$", r"\1", prompt(scr, "new description (empty aborts):", key))   # a typed number would double each member's own
        if not new: self.msg = "aborted — nothing renamed"; return
        if new == key: self.msg = "unchanged — nothing renamed"; return
        if (why := gate()): self.msg = why; return
        if {u for u, _, _ in lineage_rows(uuid)} != {u for u, _, _ in rows}: self.msg = "the lineage changed while the prompt was open — nothing renamed; t again"; return
        try: n = retitle(rows, new)
        except OSError as e: self.msg = f"rename failed: {e}"; return
        self.refresh(); self.msg = f"renamed {n} session(s) — the tab label is r"

    def rename(self, label):
        c = self.cur()
        if not c or not label: return
        c["label"] = label
        if c.get("tab"): herdr("tab", "rename", c["tab"], label)
        save_state(self.st)

    def drop(self):
        """End a grab: persist, then push the order onto herdr (a cross-workspace drag moves the pane)."""
        self.grab = False; c = self.cur(); w = self.rows()[self.row][0]
        if DEMO: self.msg = "demo: dropped on screen only, no herdr tab moved"; return
        if c and c.get("tab") and not c["tab"].startswith(w + ":"):
            manage("move", c["tab"], w)
            for _ in range(20):                                  # herdr re-registers the moved agent a beat later
                self.ws, self.tabs, self.agents, self.panes, self.focused = snapshot()
                if any(t.startswith(w + ":") and u == c["uuid"] for t, (u, _) in self.agents.items()): break
                time.sleep(0.5)
            self.refresh()
        save_state(self.st); n = self.apply_order(); self.refresh(); self.msg = f"dropped; {n} herdr tab(s) moved"

# ---------------------------------------------------------------- view
def cols(s):
    """Display width: an emoji or CJK glyph takes two columns, which len() counts as one."""
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 0 if unicodedata.combining(ch) else 1 for ch in s)

def rpad(s, w):
    """Right-align to w display columns, truncating from the right when the label is wider."""
    while cols(s) > w: s = s[:-1]
    return " " * (w - cols(s)) + s

def when(ts):
    """'3d ago · 12-Sep 14:31' — elapsed first; hh:mm only inside a week; the year only when it is not this one."""
    now = time.time(); d = max(0, now - ts)
    ago = (f"{int(d/60)}m" if d < 3600 else f"{int(d/3600)}h" if d < 86400 else f"{int(d/86400)}d" if d < 7*86400
           else f"{int(d/(7*86400))}w" if d < 60*86400 else f"{int(d/(30*86400))}mo")
    lt = time.localtime(ts); date = time.strftime("%d-%b", lt).lstrip("0")
    if lt.tm_year != time.localtime(now).tm_year: date += time.strftime("-%Y", lt)
    if d < 7*86400: date += time.strftime(" %H:%M", lt)
    return f"{ago} ago · {date}"

def wrap(s, w):
    out, line = [], ""
    for word in s.split():                                       # cols(), not len(): an emoji is two columns
        if cols(line) + cols(word) + 1 > w: out.append(line); line = word
        else: line = (line + " " + word).strip()
    return out + ([line] if line else [])

def detail_lines(g, c, width):
    """(text, kind) per line. Kinds map to colors in draw(), with the statusline's meanings:
    label bold · title plain · status in the cell's status color · size blue (the statusline's
    session-size blue) · time and done-when dim · directive plain."""
    if c is None: return [("(no cells in this workspace)", "dim")]
    uuid = c.get("uuid", ""); t = title_of(uuid, g.titles) if uuid else ""
    lin = g.lineage.get(uuid, {}) if uuid else {}
    st = g.status(c); pane = g.panes.get(c.get("tab") or "", "")
    if DEMO and uuid:                                             # placeholders that keep the shape of the real thing
        n = demo_n(uuid); c = dict(c, label=f"task {n}"); t = f"20260406 Example session doing one job {n:02d}"; uuid = hashlib.sha1(("demo " + uuid).encode()).hexdigest()
        lin = {"prime_directive": "Example prime directive: one sentence saying what this lineage of sessions is for.", "done_when": "an example of when it is finished"}
    lines = [(c.get("label") or (c.get("tab") or "(unlabeled)"), "label"), ("", "")]
    if uuid:
        lines += [(l, "title") for l in wrap(t or uuid, width)]  # the full title, wrapped — never cut at the panel edge
        segs = [(f"{st}{' (tab open, session not running)' if st == 'stopped' else ''}", "status"), (f" · {pane or 'no tab'}", "title"), (f" · {uuid[:8]}", "sid"),
                (f" · {'default' if DEMO else g.accounts.get(uuid) or 'default'}", "title")]   # the account, as the statusline names it
        if g.marked(c): segs.append((" · ★ bookmarked", "gold"))
        lines.append((segs, "segments"))                          # status in its color, pane plain, id dim — like the statusline
        if not DEMO: lines += [(l, "title") for w in g.waits(c) for l in wrap("◷ waiting: " + w, width)]
        p = transcript(c.get("uuid", "")) if uuid else None
        if p:
            sz = os.path.getsize(p) / 1048576; segs = [(f"{sz:.1f} MB", "size")]   # the statusline's cornflower blue
            n = ctx_of(p)
            if n is not None: segs += [(" · Cx ", "dim"), (fmt_tokens(n), ctx_kind(n))]
            lines += [(segs, "segments"), (f"last activity {when(os.path.getmtime(p))}", "dim")]
        pdv = lin.get("prime_directive") or ""; dw = lin.get("done_when") or ""
        if pdv: lines += [("", "")] + [(l, "body") for l in wrap(pdv, width)]   # no prime directive: the title above is the description
        if dw: lines += [("", "")] + [(l, "dim") for l in wrap("done when: " + dw, width)]
    else:
        lines += [("shell tab, no session", "dim"), (f"{c.get('tab')} · {pane}", "dim")]
    return lines

def draw(scr, g):
    scr.erase(); H, W = scr.getmaxyx()
    legend = [(" ● working", 2), ("  ● done", 1), ("  ○ idle", 1), ("  ● blocked", 3), ("  ◌ stopped", 4), ("  P parked", 4)] + ([("  ◷ parked, waiting for a message", 4)] if os.path.isdir(WAKES) else []) + [("  ◐ resuming", 2), ("  · shell", 5), ("  A archived", 4), ("  ★☆ bookmarked", 5)]
    keys = "⏎ open  n new  b bookmark  ⇥ next ★  p park  x forget  d delete  a archive  m grab  v view  o order  / search  A archived  ↑↓←→ move  r label  t title  = push order  R refresh  ? help  q quit  ctrl+alt+g back here from any tab"
    # Legend then keys, wrapped onto as many lines as the pane needs: a narrow pane used to cut the keys off at its right edge.
    foot = [[]]; x = 0
    for txt, cp in legend + [("  " + k, 0) for k in keys.split("  ")]:
        if foot[-1] and x + cols(txt) > W - 1: foot.append([]); x = 0; txt = " " + txt.lstrip()
        foot[-1].append((txt, cp)); x += cols(txt)
    F = len(foot) + 2                                            # footer lines: rule + legend and keys + message
    live = sum(1 for _, e in g.all_rows() for c in e["cells"] if c.get("tab") and c.get("uuid"))
    parked = sum(1 for _, e in g.all_rows() for c in e["cells"] if c.get("tab") is None)
    marked = sum(1 for _, e in (g.arch if g.side == "archive" else g.all_rows()) for c in e["cells"] if g.marked(c))
    head = (f" herdr grid · ARCHIVED   {sum(len(e['cells']) for _, e in g.arch)} lineages in {len(g.arch)} folders" if g.side == "archive" else f" herdr grid   {live} live · {parked} parked") + (f" · {marked} ★" if marked else "") + ({"focus": "   ★ ONLY" if g.side == "archive" else "   RUNNING + ★ ONLY", "running": "   RUNNING ONLY"}.get(g.view, "")) + ("   NEWEST FIRST" if g.order == "newest" else "") + (f"   SEARCH: {g.query}" if g.query else "") + ("   MOVE" if g.grab else "")
    scr.addnstr(0, 0, head.ljust(W), W - 1, curses.A_BOLD | (curses.color_pair(3) if g.grab else 0))
    rows = g.rows()
    def shown_label(i, w, e):
        """`· reports` for a subgroup line, else the label as before."""
        lab = demo_ws(i, e["label"])
        if w in g.parent_of: return "· " + re.sub(r"^[^0-9A-Za-z]+", "", e["label"]).split("-", 1)[1] if not DEMO else "· " + lab
        return lab
    labw = min(max([cols(shown_label(i, w, e)) for i, (w, e) in enumerate(rows)] + [4]), 15)
    gridw = labw + 3 + max([len(g.cells(i)) for i in range(len(g.rows()))] + [1]) * 2 + 2
    detx = min(gridw, W // 2); detw = W - detx - 2
    # Every row, subgroup lines included, wraps onto as many lines as its cells need. Only when
    # that would run into the footer do rows other than the cursor's fold to their first cells and a "+N" count;
    # the cursor's row always shows whole, so every cell the arrows reach is on screen.
    per = max(4, (detx - labw - 3) // 2)                         # cells per line
    tight = sum(max(1, -(-len(g.cells(i)) // per)) for i in range(len(rows))) > H - F - 2
    y = 2
    for i, (w, ent) in enumerate(rows):
        if y >= H - F: break
        cells = g.cells(i); n = len(cells)
        scr.addstr(y, 0, rpad(shown_label(i, w, ent), labw) + ": ")
        fold = tight and i != g.row and n > per
        shown = cells[:per - 2] if fold else cells
        for j, c in enumerate(shown):
            gch, cp = g.glyph(c); attr = curses.color_pair(cp)
            if i == g.row and j == g.col: attr |= curses.A_REVERSE
            if c.get("tab") == g.focused: attr |= curses.A_UNDERLINE
            yy, x = y + j // per, labw + 2 + (j % per) * 2
            if yy < H - F and x + 1 < detx: scr.addstr(yy, x, gch, attr)
        if fold: scr.addnstr(y, labw + 2 + (per - 2) * 2, f"+{n - (per - 2)}", max(0, detx - (labw + 2 + (per - 2) * 2) - 1), curses.A_DIM)
        y += 1 if fold or n <= per else (n + per - 1) // per
    cur = g.cur(); _, scp = g.glyph(cur) if cur else ("", 5)
    kind_attr = {"label": curses.A_BOLD, "title": 0, "status": curses.color_pair(scp), "size": curses.color_pair(6),
                 "sid": curses.A_DIM, "ctx_ok": curses.color_pair(7), "ctx_warn": curses.color_pair(8), "ctx_crit": curses.color_pair(9), "gold": curses.color_pair(10),
                 "dim": curses.A_DIM, "body": 0, "": 0}
    for k, (line, kind) in enumerate(detail_lines(g, cur, detw)):
        if 2 + k >= H - F: break
        if kind == "segments":                                   # one line, several colors; cut at the panel edge
            x = detx + 1
            for text, kd in line:
                room = detx + 1 + detw - x
                if room <= 0: break
                scr.addnstr(2 + k, x, text, room, kind_attr.get(kd, 0)); x += min(cols(text), room)
        else: scr.addnstr(2 + k, detx + 1, line, detw, kind_attr.get(kind, 0))
    if detx < W - 1:
        for y in range(1, H - F): scr.addstr(y, detx, "│")          # the same unicode bar as the rule below, not ACS_VLINE: a capture that lacks the DEC charset drew that as "x"
    scr.addnstr(H - F, 0, "─" * (W - 1), W - 1)
    for i, line in enumerate(foot):
        x = 0
        for txt, cp in line:
            if x < W - 1: scr.addnstr(H - F + 1 + i, x, txt, W - 1 - x, curses.color_pair(cp))
            x += cols(txt)
    scr.addnstr(H - 1, 0, (" " + " ".join(g.msg.split())).ljust(W - 1), W - 1, curses.A_DIM)   # collapsed: a newline here returns ERR and would kill the grid
    scr.refresh()

def prompt(scr, label, initial="", complete=None):
    """One-line editor on the bottom row, prefilled with `initial` and the cursor at its end, so a
    rename starts from the current label instead of a blank. Backspace, ←/→,
    Home/End, ctrl-U (clear) and ctrl-A/E work; Enter accepts, Esc cancels and returns "".
    With `complete`, Tab cycles through the entries starting with what was typed (all of them when none do)."""
    H, W = scr.getmaxyx(); buf = list(initial); pos = len(buf); x0 = len(label) + 2; cyc = None
    curses.curs_set(1); scr.timeout(-1)                          # the grid's 3 s idle tick would abort the edit
    try:
        while True:
            room = max(1, W - 1 - x0); start = 0 if pos < room else pos - room + 1   # a long entry scrolls instead of running off the row
            scr.addnstr(H - 1, 0, (" " + label + " " + "".join(buf[start:start + room])).ljust(W - 1), W - 1)
            scr.move(H - 1, min(x0 + pos - start, W - 2)); scr.refresh(); k = scr.get_wch()
            if k in ("\n", "\r", curses.KEY_ENTER, 10, 13): return "".join(buf).strip()
            if k == "\x1b": return ""
            if k == "\t" and complete:
                if cyc is None:
                    stem = "".join(buf).lower(); cyc = [c for c in complete if c.lower().startswith(stem)] or list(complete); ci = -1
                ci = (ci + 1) % len(cyc); buf = list(cyc[ci]); pos = len(buf); continue
            cyc = None
            if k in (curses.KEY_BACKSPACE, "\x7f", "\b", 127, 8):
                if pos: del buf[pos - 1]; pos -= 1
            elif k == curses.KEY_DC:
                if pos < len(buf): del buf[pos]
            elif k == curses.KEY_LEFT: pos = max(0, pos - 1)
            elif k == curses.KEY_RIGHT: pos = min(len(buf), pos + 1)
            elif k in (curses.KEY_HOME, "\x01"): pos = 0
            elif k in (curses.KEY_END, "\x05"): pos = len(buf)
            elif k == "\x15": buf = []; pos = 0
            elif isinstance(k, str) and k.isprintable(): buf.insert(pos, k); pos += 1
    except Exception: return ""
    finally: curses.curs_set(0); scr.timeout(3000)

HELP = [
    ("↑ ↓ ← →", "move between cells; up/down remembers the column you came from"),
    ("Enter",   "live cell: go to its tab. Stopped (◌) or parked (P): bring the session back in the background (◐ until it lands), stay in the grid — Enter again to go. Wake several, then jump"),
    ("p",       "park: quit the session and close its tab — the cell stays as P   (asks first)"),
    ("x",       "forget: remove a PARKED cell from the grid; the transcript is untouched   (asks first)"),
    ("d",       "delete: a PARKED cell's session and its whole lineage — transcripts to the Trash, cell dropped; refused if any member is still running anywhere   (asks first)"),
    ("a",       "archive: a PARKED cell's whole lineage moves into a folder of the archive — the folder is prefilled with a guess, Tab cycles the existing ones, cell dropped; refused if any member is running. A brings one back   (asks for the folder, then asks first)"),
    ("m",       "grab the cell; arrows carry it along the row or into another workspace; m or Enter drops, Esc cancels"),
    ("r",       "rename the herdr tab label (the current label is loaded to edit; Esc keeps it)"),
    ("t",       "rename the session's TITLE across its whole lineage, archived members too: lists the members, prefills the description, each keeps its own date and number; refused if any member is running"),
    ("n",       "new session in this row's workspace, in the cursor's slot: tab label (required), then a few words for its first prompt (optional). Account follows the cell under the cursor; your words go out as its first prompt and it starts working; title and directive come later, as in any session"),
    ("b",       "bookmark the cell (★ in place of its dot, ☆ when the dot is hollow, status color kept) — or remove the bookmark. Stored in the grid's own file, so it survives parks and successors"),
    ("Tab",     "jump to the next bookmarked cell, wrapping"),
    ("v",       "view, in turn: all cells; running sessions + bookmarked cells; running sessions only. Rows with nothing to show hide; the header names the view. Moving (m) works in every view; hidden cells stay put"),
    ("o",       "order, in turn: your own order (the one m and herdr drags set); newest first by last activity. Display only — the stored order is kept. Moving (m) needs your own order"),
    ("A",       "archived sessions: one row per archive folder, one cell per lineage, newest first. Enter asks which workspace (the folder's own name when one is live; a new name makes one), moves the transcript back and resumes it there, then returns to the live grid with the cursor on it. b, /, v (all / bookmarked) work there; A again comes back"),
    ("/",       "search: type words and only cells whose label, title or prime directive hold ALL of them stay; rows with none hide. Enter keeps the search, an arrow keeps it and moves, Esc clears it. Moving (m) needs no search"),
    ("=",       "push the grid's tab order onto herdr — rows and tabs dragged in herdr are already followed   (asks first when it would move any)"),
    ("R",       "refresh now (it also refreshes every 3 s)"),
    ("?",       "this list"),
    ("q",       "quit the grid (Esc only cancels a grab)"),
    ("ctrl+alt+g", "from any herdr tab: back to this grid (a herdr key, not the grid's; restarts the grid if it stopped)"),
    ("hg go",   "from any pane: go to the grid workspace, creating or relaunching it as needed"),
]

def help_screen(scr):
    scr.erase(); H, W = scr.getmaxyx()
    scr.addnstr(0, 0, " herdr grid — keys", W - 1, curses.A_BOLD)
    for i, (k, text) in enumerate(HELP):
        if 2 + i >= H - 1: break
        scr.addnstr(2 + i, 2, f"{k:<9} {text}", W - 3)
    scr.addnstr(H - 1, 0, " any key to return", W - 1, curses.A_DIM); scr.refresh(); scr.timeout(-1); scr.getch(); scr.timeout(3000)

def confirm(scr, text):
    H, W = scr.getmaxyx(); scr.addnstr(H - 1, 0, (" " + text + "  y/n").ljust(W - 1), W - 1, curses.A_BOLD); scr.refresh()
    scr.timeout(-1); k = scr.getch(); scr.timeout(3000)
    return k in (ord("y"), ord("Y"))

def herdr_session_name():
    """The herdr session this socket belongs to — the grid represents exactly one, so its tab is named for it."""
    for x in herdr("session", "list", "--json").get("sessions", []):
        if x.get("socket_path") == SOCK or x.get("running") and x.get("default"): return x.get("name") or "default"
    return "default"

def go(focus=True):
    """Create the grid workspace at position 0 with one tab named for the herdr session, launch the grid in it if needed, focus it.
    Returns True when typed in the grid's own pane (the caller draws it there), else the state line's word."""
    ws, tabs, agents, panes, _ = snapshot(); name = herdr_session_name()
    gw = next((w for w, l in ws if l == GRID_WS), None)
    if gw is None:
        out = herdr("workspace", "create", "--label", GRID_WS, "--no-focus").get("result", {})
        gw = out["workspace"]["workspace_id"]; tab = out["root_pane"]["tab_id"]; pane = out["root_pane"]["pane_id"]
        herdr("tab", "rename", tab, name); time.sleep(1.5)
        ws, tabs, agents, panes, _ = snapshot()
    else:
        tab = tabs[gw][0][0]; pane = panes[tab]
    if ws and ws[0][0] != gw: sock("workspace.move", {"workspace_id": gw, "insert_index": 0})
    # Typed IN the grid's own pane (after a reboot): its foreground is this very launcher, which the
    # check below would read as "already running", leaving the pane at a shell. Draw the grid here.
    if os.environ.get("HERDR_PANE_ID") == pane: return True
    pi = herdr("pane", "process-info", "--pane", pane).get("result", {}).get("process_info")
    # Type into the pane ONLY when it is provably at a bare shell: the foreground list holds the
    # shell itself and nothing else. Anything more — the grid, or something else — gets nothing
    # typed into it, because text sent into the running grid lands on its keys; an unreadable
    # process list is treated the same way.
    fg = [p for p in ((pi or {}).get("foreground_processes") or []) if p.get("pid") != (pi or {}).get("shell_pid")]
    if pi is None: state = "unreadable — nothing sent"
    elif fg: state = "already running" if any("herdr_session_grid.py" in (p.get("cmdline") or "") for p in fg) else "busy — nothing sent"
    else:
        herdr("pane", "send-text", pane, "herdr_session_grid.py run"); herdr("pane", "send-keys", pane, "Enter"); state = "launched"
        for _ in range(20):                                      # a second go inside this window must see it running
            fg2 = (herdr("pane", "process-info", "--pane", pane).get("result", {}).get("process_info") or {}).get("foreground_processes") or []
            if any("herdr_session_grid.py" in (p.get("cmdline") or "") for p in fg2): break
            time.sleep(0.25)
    if not focus: return state
    manage("goto", tab, timeout=30)
    print(f"grid: {state} in its own workspace {gw} ({GRID_WS}), tab {tab}, pane {pane} — not the caller's workspace")   # says where the grid is, so a caller does not take it for its own workspace
    return state

AUTOSTART_LOG = f"{HOME}/.claude/state/state_claude_session_grid_autostart.log"
AUTOSTART_WINDOW_S = 600

def herdr_server_age():
    """Seconds the herdr server process has been running, or None when there is none."""
    for l in subprocess.run(["ps", "-axo", "etime=,args="], capture_output=True, text=True).stdout.splitlines():
        parts = l.split(None, 1)
        if len(parts) == 2 and parts[1].rstrip().endswith("herdr server"):
            d, _, hms = parts[0].rpartition("-"); f = [int(x) for x in hms.split(":")]
            while len(f) < 3: f.insert(0, 0)
            return (int(d) if d else 0) * 86400 + f[0] * 3600 + f[1] * 60 + f[2]
    return None

def ensure():
    """`ensure`, from a LaunchAgent every minute: after a reboot or a herdr restart the grid's pane comes back as a bare
    shell and nothing runs the grid.
    Acts only while the herdr server is younger than AUTOSTART_WINDOW_S, so a grid quit on purpose later is left
    quit. Same placement as `hg` from another pane, without the focus change; silent, since nobody reads
    its output. Logs only a launch or a refusal, never the minute-by-minute "already running"."""
    age = herdr_server_age()
    if age is None or age > AUTOSTART_WINDOW_S or not os.path.exists(SOCK): return
    state = go(focus=False)
    if state != "already running":
        with open(AUTOSTART_LOG, "a") as fh: fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + f"herdr server up {age}s: grid {state}\n")

def main(scr):
    curses.curs_set(0); curses.use_default_colors()
    for i, col in enumerate([curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_RED, curses.COLOR_BLUE, -1], 1):
        curses.init_pair(i, col, -1)
    # 6 cornflower (statusline BLUE 137,180,250 → xterm 111), 7/8/9 the statusline's context tiers
    # (166,227,161 → 151 · 249,226,175 → 223 · 243,139,168 → 211). Under 256 colors: blue, green, yellow, red.
    hi = curses.COLORS >= 256
    for i, (c256, basic) in enumerate([(111, curses.COLOR_BLUE), (151, curses.COLOR_GREEN), (223, curses.COLOR_YELLOW), (211, curses.COLOR_RED), (220, curses.COLOR_YELLOW)], 6):   # 10 = gold, the picker's ⭐
        curses.init_pair(i, c256 if hi else basic, -1)
    curses.init_pair(2, 226 if hi else curses.COLOR_YELLOW, -1)   # working: pure yellow (xterm 226); the terminal's basic yellow reads dull
    curses.init_pair(4, 111 if hi else curses.COLOR_BLUE, -1)   # parked/stopped: the statusline's cornflower (xterm 111), the same pair the panel uses for size; stays distinct from the green ★
    curses.init_pair(1, 46 if hi else curses.COLOR_GREEN, -1)   # waiting for input (done/idle): pure green (xterm 46); a mint green blurs into the cornflower stars
    scr.timeout(3000)
    g = Grid(); g.redraw = lambda: draw(scr, g); g.refresh(); DEMO or g.apply_order(); g.restore_cursor(); last = time.time()
    while True:
        try: draw(scr, g)
        except curses.error as e: scr.erase(); scr.addnstr(0, 0, "draw failed: " + " ".join(str(e).split()), 100); scr.refresh()   # never exit over one bad cell; the next tick redraws
        scr.timeout(1000 if g.jobs else 3000)                     # a background resume lands within a second
        k = scr.getch()
        if g.poll_jobs(): last = time.time()
        if k == -1:
            if time.time() - last >= 3: g.refresh(); g.save_cursor(); last = time.time()
            continue
        if g.typing:                                              # `/` search line: typed keys edit the query and filter as you type
            if k == 27: g.query = ""; g.typing = False; g.msg = "search cleared"
            elif k in (10, 13, curses.KEY_ENTER): g.typing = False; g.msg = f"search: {g.query} — Esc clears" if g.query else ""
            elif k in (curses.KEY_BACKSPACE, 127, 8): g.query = g.query[:-1]
            elif 32 <= k < 0x110000 and k not in (curses.KEY_UP, curses.KEY_DOWN, curses.KEY_LEFT, curses.KEY_RIGHT) and k < curses.KEY_MIN: g.query += chr(k)
            else: g.typing = False; curses.ungetch(k); continue   # an arrow ends typing and moves, keeping the filter
            g.row = g.col = g.want_col = 0; g.clamp()
            if g.typing: g.msg = f"search: {g.query}▏  Enter keeps · Esc clears"
            continue
        if k == ord("A") and not g.grab: g.flip(); continue
        if g.side == "archive" and k in tuple(map(ord, "pxdamrtn=")): g.msg = "archived side: Enter brings a session back · b bookmark · / search · v view · A back to live"; continue
        if g.side == "archive" and k == ord("o"): g.msg = "the archived side is always newest first"; continue
        if k == ord("/") and not g.grab: g.typing = True; g.grab = False; g.msg = f"search: {g.query}▏  Enter keeps · Esc clears"; continue
        if k == ord("q") and not g.grab:                          # only q quits — Esc is a cancel, never an exit
            if g.jobs and not confirm(scr, f"{len(g.jobs)} resume(s) still running — quit anyway? they finish without the grid"): continue
            g.save_cursor(); break
        if k in tuple(map(ord, "pxdatmr")) and g.busy(g.cur()): g.msg = "still resuming — wait for ●"; continue
        if k == 27:
            if g.grab: g.grab = False; g.refresh(); g.msg = "move canceled"
            elif g.query: c = g.cur(); g.query = ""; g.msg = "search cleared"; g.row, g.col = g.find(c)
            continue
        if k == curses.KEY_UP: g.move(-1, 0)
        elif k == curses.KEY_DOWN: g.move(1, 0)
        elif k == curses.KEY_LEFT: g.move(0, -1)
        elif k == curses.KEY_RIGHT: g.move(0, 1)
        elif k in (10, 13, curses.KEY_ENTER): g.drop() if g.grab else g.open(scr); curses.flushinp()   # keys typed during a drop's herdr moves or a workspace rebuild would replay into the grid (q quits, p parks)
        elif k == ord("m"):
            if g.order != "manual" and not g.grab: g.msg = "moving works in your own order — o first"
            else: g.drop() if g.grab else setattr(g, "grab", True)
        elif k == ord("v"): g.toggle_view()
        elif k == ord("o"): g.toggle_order()
        elif k == ord("p"):
            c = g.cur()
            if c and c.get("tab") and confirm(scr, f"park '{c.get('label') or c['tab']}' — quit its session (any background work stops) and close the tab?"): g.park(); curses.flushinp()
            elif c and not c.get("tab"): g.msg = "already parked"
        elif k == ord("x"):
            c = g.cur()
            if c and c.get("tab") is None and confirm(scr, f"forget '{c.get('label') or c.get('uuid','')[:8]}' — drop it from the grid?"): g.forget()
            elif c: g.msg = "forget works on a parked cell only"
        elif k == ord("d"):
            c = g.cur()
            if c and c.get("tab") is None:
                n = len(lineage_members(c.get("uuid") or "", g.titles)) if c.get("uuid") else 0
                if confirm(scr, f"delete '{c.get('label') or c.get('uuid','')[:8]}' — {n} transcript(s) of its lineage to the Trash, cell dropped?"): g.delete()
            elif c: g.msg = "delete works on a parked cell only — park it first"
        elif k == ord("a"): g.archive(scr); curses.flushinp()
        elif k == ord("t"): g.rename_lineage(scr); curses.flushinp()
        elif k == ord("r"): g.rename(prompt(scr, "new tab label:", (g.cur() or {}).get("label") or ""))
        elif k == ord("b"): g.toggle_mark()
        elif k == ord("n"): g.new_session(scr); curses.flushinp()
        elif k == 9: g.next_marked()                              # Tab
        elif k == ord("="):
            pending = g.order_pending()
            if pending == 0: g.msg = "herdr already matches the grid"
            elif confirm(scr, f"reorder herdr ({pending} workspace(s) or the sidebar) to match the grid?"):
                n = g.apply_order(); g.refresh(); g.msg = f"{n} herdr move(s) to match the grid"
        elif k == ord("R"):
            g.refresh(); g.msg = "refreshed"
            if g.side == "archive": g.arch = archive_rows(); g.clamp()
        elif k == ord("?"): help_screen(scr)

if __name__ == "__main__":
    locale.setlocale(locale.LC_ALL, "")
    if sys.argv[1:2] == ["ensure"]: ensure(); sys.exit(0)             # before the socket check: it runs unattended, and herdr down is normal
    if not os.path.exists(SOCK): sys.exit("herdr is not running (no socket)")
    # Bare `hg` GOES to the grid; `run` draws it in THIS pane and is what go() types into the grid's own
    # pane — a launcher detail, not a verb to reach for.
    if len(sys.argv) == 1 or sys.argv[1] == "go":
        if go() is not True: sys.exit(0)                         # True: typed in the grid's own pane, so draw it here
    elif sys.argv[1] != "run": sys.exit(__doc__)
    DEMO = "--demo" in sys.argv[2:]
    curses.wrapper(main)
