#!/usr/bin/env python3
"""Copy a session's OPEN task-list items (the ctrl+t panel) into its successor's store.

The task list is keyed to the session id, so it does not travel to a successor on its own: the new
session would open with a blank panel. Called by claude_successor_skill_handover.sh once the
successor's id is known.

Completed items are LEFT BEHIND on purpose: they are a record of what the predecessor did, and
carrying them pushes the items that still need doing off the few lines the panel shows.

    claude_copy_task_list_to_successor.py <predecessor-uuid> <successor-uuid>

Refuses rather than merges when the successor already holds items, exits 0 with a message when
there is nothing to carry, and never writes to the predecessor. Claude Code keeps the list in
<config>/tasks/session-<first 8 of the session id>/<n>.json, one file per item.
"""
import json
import os
import sys
from pathlib import Path

OPEN = ("pending", "in_progress")
KEEP = ("subject", "description", "activeForm", "status")


def tasks_root():
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude")) / "tasks"


def store(root, uuid):
    return root / f"session-{uuid[:8]}"


def read_items(d):
    """Every item in id order. A file that is not an item is skipped, never guessed at."""
    items = []
    for p in sorted(d.glob("*.json"), key=lambda p: (len(p.stem), p.stem)):
        try:
            v = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(v, dict) and v.get("subject"):
            items.append(v)
    return items


def carry(items):
    """The open items, renumbered from 1, with dependencies kept only where both ends survive."""
    kept = [v for v in items if v.get("status") in OPEN]
    remap = {str(v.get("id")): str(i) for i, v in enumerate(kept, 1)}
    out = []
    for i, v in enumerate(kept, 1):
        n = {k: v[k] for k in KEEP if k in v}
        n["id"] = str(i)
        for link in ("blocks", "blockedBy"):
            n[link] = [remap[str(x)] for x in v.get(link) or [] if str(x) in remap]
        out.append(n)
    return out


def main(argv):
    if len(argv) != 3:
        print(f"usage: {Path(argv[0]).name} <predecessor-uuid> <successor-uuid>", file=sys.stderr)
        return 2
    pred, succ = argv[1], argv[2]
    for u in (pred, succ):
        if len(u) < 8:
            print(f"not a session id: {u}", file=sys.stderr)
            return 2
    if pred[:8] == succ[:8]:
        print("predecessor and successor are the same session — nothing to do", file=sys.stderr)
        return 2

    root = tasks_root()
    src, dst = store(root, pred), store(root, succ)
    if not src.is_dir():
        print("task list: the predecessor has no store, nothing to carry")
        return 0
    items = carry(read_items(src))
    if not items:
        print("task list: no open items to carry")
        return 0

    dst.mkdir(parents=True, exist_ok=True)
    if read_items(dst):
        print(f"task list: the successor already holds items — carried nothing, see {dst}",
              file=sys.stderr)
        return 1
    for v in items:
        (dst / f"{v['id']}.json").write_text(json.dumps(v, indent=2) + "\n")
    (dst / ".highwatermark").write_text(str(len(items)))
    print(f"task list: carried {len(items)} open item{'s' if len(items) != 1 else ''} "
          f"to the successor")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
