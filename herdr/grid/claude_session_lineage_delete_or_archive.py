#!/usr/bin/env python3
"""Delete or archive a session's whole lineage NOW, and drop every grid cell of the lineage, in any workspace.
The command-line twin of the grid's `d` and `a`, for a session given by id (from a terminal or a
key binding). This loads herdr_session_grid.py, which must sit beside it, as a library, so membership
(each transcript's own title), the live check, the trash step, the archive move, the archive folder
(grid.json's archive_dir) and the folder guess have ONE home rather than two that can drift.
Refused outright when any member is running anywhere, or when the live check cannot see every claude.

  claude_session_lineage_delete_or_archive.py delete  <uuid>   list, ask once, every transcript to the Trash
  claude_session_lineage_delete_or_archive.py archive <uuid>   list, ask for the archive folder
                                                               (a suggested folder, Tab completes), ask once, move
  ... <verb> <uuid> --check                                    list and run the gates, change nothing
"""
import fcntl, importlib.util, json, os, sys, termios, time, tty

here = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location("grid", os.path.join(here, "herdr_session_grid.py"))
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

def key(prompt):
    """One keypress from the terminal — a caller such as fzf's execute() may hand the tty over, stdin may not be it."""
    with open("/dev/tty", "rb+", buffering=0) as t:
        t.write(prompt.encode()); old = termios.tcgetattr(t)
        try: tty.setcbreak(t); c = t.read(1).decode(errors="replace")
        finally: termios.tcsetattr(t, termios.TCSADRAIN, old)
        t.write(b"\n"); return c

def ask_folder(guess):
    """A line editor with the guess typed in (named in the prompt under libedit, which cannot type it) and Tab
    completing the existing folders. Empty = cancel."""
    import readline
    if not sys.stdin.isatty(): sys.stdin = open("/dev/tty")
    buckets = g.archive_buckets()
    def comp(text, i):
        m = [b for b in buckets if b.lower().startswith(text.lower())]
        return m[i] if i < len(m) else None
    libedit = "libedit" in (readline.__doc__ or "")              # macOS's own python: no typed-in guess, so name it
    readline.set_completer(comp); readline.set_completer_delims("")
    readline.parse_and_bind("bind ^I rl_complete" if libedit else "tab: complete")
    readline.set_startup_hook(None if libedit else lambda: readline.insert_text(guess))
    hint = f"suggested: {guess}; " if libedit and guess else ""
    try: return input(f"\narchive folder ({hint}Tab completes, empty cancels): ").strip()
    except (EOFError, KeyboardInterrupt): return ""
    finally: readline.set_startup_hook(None)

def drop_cells(members):
    """Drop every grid cell of these sessions, under the grid's own lock; the running grid reloads a file
    newer than its last save. Returns how many cells went."""
    if not os.path.exists(g.STATE): return 0
    with open(g.STATE + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        st = json.load(open(g.STATE)); n = 0
        for ent in (st.get("workspaces") or {}).values():
            keep = [c for c in ent.get("cells", []) if c.get("uuid") not in members]
            n += len(ent.get("cells", [])) - len(keep); ent["cells"] = keep
        if n:
            tmp = g.STATE + ".tmp"
            with open(tmp, "w") as fh: json.dump(st, fh, indent=1, ensure_ascii=False); fh.write("\n")
            os.replace(tmp, g.STATE)
    return n

def gate(members):
    live, ok = g.live_sessions()
    if not ok: return "\033[1;31mRefused\033[0m — a claude process has no readable session id, so the live check is blind. Nothing changed."
    running = [u[:8] for u in members if u in live]
    return f"\033[1;31mRefused\033[0m — still RUNNING: {' '.join(running)}. Exit them and run this again. Nothing changed." if running else ""

def main(verb, uuid, check):
    titles = g.jload(g.TITLES, {}) or {}
    paths = g.transcripts()
    if not os.path.isfile(paths.get(uuid, "")): return "no transcript for that session in any project folder — nothing changed"
    members = g.lineage_members(uuid, titles)
    where = "transcripts to the Trash" if verb == "delete" else "into an archive folder"
    print(f"\n\033[1m{verb.capitalize()} this lineage — {len(members)} session(s), {where}:\033[0m")
    for u in sorted(members, key=lambda u: os.path.getmtime(paths[u]), reverse=True):
        print(f"  {u[:8]}  {g.transcript_title(paths[u]) or g.title_of(u, titles) or '(untitled)'}")
    if (why := gate(members)): return why
    if check: return "check only — the gates pass; nothing changed"
    if verb == "delete":
        if key(f"\ndelete all {len(members)}? y/N ") not in ("y", "Y"): return "aborted — nothing deleted"
        done, failed = [], []
        for u in members: (done if g.trash_transcript(u) else failed).append(u[:8])
        head = f"deleted {len(done)} transcript(s) to the Trash"
    else:
        bucket = ask_folder(g.guess_bucket(uuid, titles))
        if not bucket: return "aborted — nothing moved"
        if "/" in bucket or bucket.startswith("."): return f"'{bucket}' is not a folder name — nothing moved"
        new = not os.path.isdir(f"{g.ARCHIVE}/{bucket}")
        if key(f"archive all {len(members)} to {bucket}" + (" (a NEW folder, created now)" if new else "") + "? y/N ") not in ("y", "Y"): return "aborted — nothing moved"
        if (why := gate(members)): return why                 # the folder prompt can sit open
        if new: os.makedirs(f"{g.ARCHIVE}/{bucket}")
        done, failed = [], []
        for u in members: (done if g.archive_transcript(u, bucket) else failed).append(u[:8])
        head = f"archived {len(done)} transcript(s) to {bucket}"
    cells = drop_cells(set(members)) if not failed else 0
    return f"{head}, {cells} grid cell(s) dropped" + (f" — could not {verb}: {' '.join(failed)}" if failed else "")

if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) < 2 or a[0] not in ("delete", "archive"): sys.exit(__doc__)
    check = "--check" in a[2:]
    msg = main(a[0], a[1], check); print(msg)
    if not check: key("press any key ") if "Refused" in msg else time.sleep(1.2)   # a calling list UI redraws the moment this exits
