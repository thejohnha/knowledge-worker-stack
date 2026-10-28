#!/usr/bin/env python3
"""SessionStart hook: keep a session's ctrl+t task list attached to the session across a resume.

Claude Code stores the task list in `<config>/tasks/session-<8hex>/<n>.json`, one file per item,
and the panel reads whichever directory the CURRENT LAUNCH picked. On a fresh start that directory
is named after the session id, so it lines up. On a resume the app mints a new per-launch id and
opens an EMPTY store under it, leaving the session's real items stranded in the old directory --
the panel comes back blank and the list is useless for reorienting after a restart.

This hook replaces that empty new store with a relative symlink to the session-id-named one, so
reads, writes and the directory watcher all land on a single store that outlives every relaunch.
A symlink rather than a copy because a copy needs a write-back on exit to stay current, and a
process that is killed never runs one.

The new store cannot be named from the payload -- the payload reports the RESUMED session id, not
the launch id -- so it is identified by elimination: a directory under tasks/ that is not this
session's own, holds no items, was created seconds ago, and is not named after a session that has
a transcript. Anything less than exactly one match is left alone; a blank panel is a small loss
and pointing a session at another session's list is not.

stdout stays empty: SessionStart stdout is injected into the model's context.
"""
import json
import os
import sys
import time
from pathlib import Path

# How recently the launch store must have been created to be this launch's. The hook fires within
# milliseconds of it, so this only has to cover a loaded machine, not a slow user. Without it an
# empty store left by a crashed launch would stay a candidate for ever.
FRESH_SECONDS = float(os.environ.get("CLAUDE_TASK_PIN_FRESH_SECONDS") or 20)
# The store is created around the same moment the hook fires; wait briefly rather than lose the
# carry-over to a race the next resume would only repeat.
WAIT_SECONDS = 2.0
POLL_SECONDS = 0.1
# What Claude Code leaves in a store that holds no items: the advisory lock and the id counter.
EMPTY_STORE_FILES = {".lock", ".highwatermark"}


def config_dir():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def born(path):
    """Creation time, using birthtime where the filesystem keeps one (macOS does)."""
    st = path.stat()
    return getattr(st, "st_birthtime", st.st_ctime)


def has_items(store):
    return any(store.glob("*.json"))


def session_ids_with_transcripts(cfg):
    """The 8-hex prefixes of every transcript, i.e. every id that names a real session's own store.

    A session starting fresh at the same moment owns a store named after its session id. Excluding
    those keeps the common collision -- one session resuming while another starts -- from making
    this hook ambiguous.
    """
    out = set()
    projects = cfg / "projects"
    try:
        slugs = list(projects.iterdir())
    except OSError:
        return out
    for slug in slugs:
        try:
            for entry in os.scandir(slug):
                if entry.name.endswith(".jsonl"):
                    out.add(entry.name[:8])
        except OSError:
            continue
    return out


def launch_stores(tasks, canonical_name, known_ids, now):
    """Candidate stores for the current launch, newest-looking first."""
    found = []
    try:
        entries = list(tasks.iterdir())
    except OSError:
        return found
    for d in entries:
        if d.name == canonical_name or d.is_symlink() or not d.is_dir():
            continue
        if not d.name.startswith("session-"):
            continue
        if d.name[len("session-"):] in known_ids:
            continue
        try:
            if has_items(d) or now - born(d) > FRESH_SECONDS:
                continue
        except OSError:
            continue
        found.append(d)
    return found


def prune_stale_links(tasks, canonical_name, keep):
    """Drop this session's earlier launch symlinks, so a long-lived session leaves one, not dozens."""
    try:
        entries = list(tasks.iterdir())
    except OSError:
        return
    for d in entries:
        if d == keep or not d.is_symlink():
            continue
        try:
            if os.readlink(d) == canonical_name:
                d.unlink()
        except OSError:
            continue


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("source") != "resume":
        return 0
    sid = payload.get("session_id") or ""
    if len(sid) < 8:
        return 0

    cfg = config_dir()
    tasks = cfg / "tasks"
    canonical = tasks / f"session-{sid[:8]}"
    try:
        if canonical.is_symlink() or not canonical.is_dir() or not has_items(canonical):
            return 0
    except OSError:
        return 0

    known_ids = session_ids_with_transcripts(cfg)
    deadline = time.time() + WAIT_SECONDS
    while True:
        found = launch_stores(tasks, canonical.name, known_ids, time.time())
        if len(found) == 1 or time.time() >= deadline:
            break
        time.sleep(POLL_SECONDS)
    if len(found) != 1:
        return 0

    launch = found[0]
    try:
        # A store that has never held an item still carries its lock and counter, so requiring a
        # literally empty directory would silently never fire. Anything ELSE in there means this
        # is not the store this hook thinks it is, and it is left untouched.
        if set(os.listdir(launch)) - EMPTY_STORE_FILES:
            return 0
        for meta in EMPTY_STORE_FILES:
            p = launch / meta
            if p.is_file():
                p.unlink()
        launch.rmdir()
        os.symlink(canonical.name, launch)
    except OSError:
        return 0
    prune_stale_links(tasks, canonical.name, launch)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
