#!/usr/bin/env python3
"""Resume the sessions that were running when herdr stopped, each back into its own tab.

The list comes from state_claude_herdr_live_sessions.json, written every minute by
herdr_session_record_live.sh while herdr is up and never written while it is down — so after
herdr stops, that file still holds the set that was live at the end. This is the "which sessions did
I have open?" question, and it is answered from a recording rather than inferred from herdr, whose
own layout file cannot distinguish a pane that was live from one rebuilt bare.

Each session goes back into ITS OWN TAB, resolved by tab id at restore time rather than by a
remembered pane id, so a pane renumbered underneath us cannot land a session in the wrong tab.

Resumes through `cr`, never `claude --resume`: cr refuses to open a second live copy of a session,
which is the move that forks a transcript in two and silently drops one branch.

Does NOT start herdr — `h` (or the login LaunchAgent) does that. This only fills the tabs back in. When herdr is down it
prints the list it WOULD restore and says to run `h`, so the answer to "which ones did I have
open?" is available whether or not herdr is up yet.

Usage:  herdr_session_restore.py [-n|--dry-run] [--only <TAB> ...]
        herdr_session_restore.py --list                 what the hourly local backups hold
        herdr_session_restore.py --from <YYYYMMDD_HHMM> restore the set from that hour instead
The hourly backups are herdr_session_snapshot.sh's folder: $HERDR_BACKUP_DIR, default
~/knowledge-worker-stack-backups/herdr.
Exit 0 all done or nothing to do, 1 herdr is not running, 2 no record to restore from or a bad argument.
"""
import glob
import json
import os
import re
import socket
import sys
import time

HOME = os.path.expanduser("~")
SOCK = os.environ.get("HERDR_SOCKET_PATH", f"{HOME}/.config/herdr/herdr.sock")
STORE = os.environ.get("HERDR_LIVE_STORE", f"{HOME}/.claude/state/state_claude_herdr_live_sessions.json")
BACKUPS = os.path.expanduser(os.environ.get("HERDR_BACKUP_DIR", "~/knowledge-worker-stack-backups/herdr"))


def config_dirs():
    """Every Claude Code config dir: ~/.claude plus each account in accounts.json."""
    dirs = [f"{HOME}/.claude"]
    try:
        with open(f"{HOME}/.config/knowledge-worker-stack/accounts.json") as fh:
            acc = json.load(fh)
    except (OSError, ValueError):
        acc = {}
    if isinstance(acc, dict):
        dirs += [os.path.expanduser(v) for v in acc.values() if isinstance(v, str)]
    return dirs


def transcript_exists(uuid):
    return any(glob.glob(f"{d}/projects/*/{uuid}.jsonl") for d in config_dirs())


def call(method, params, timeout=10):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    s.sendall((json.dumps({"id": "restore", "method": method, "params": params}) + "\n").encode())
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.decode())


def herdr_up():
    if not os.path.exists(SOCK):
        return False
    try:
        return "result" in call("ping", {}, timeout=5)
    except (OSError, ValueError):
        return False




def panes_by_tab():
    """tab id -> a pane id in that tab, plus whichever session is live in it right now."""
    out = {}
    ws_ids = [w["workspace_id"] for w in call("workspace.list", {})["result"]["workspaces"]]
    for w in ws_ids:
        for p in call("pane.list", {"workspace_id": w})["result"]["panes"]:
            out.setdefault(p["tab_id"], (p["pane_id"], (p.get("agent_session") or {}).get("value")))
    return out


CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def encode(n):
    """int -> Crockford base32, the form herdr prints in a public tab id."""
    if n == 0:
        return "0"
    out = ""
    while n:
        n, r = divmod(n, 32)
        out = CROCKFORD[r] + out
    return out


def snapshot_names():
    """The layout backups, oldest first. Names embed a sortable YYYYMMDD_HHMM stamp."""
    try:
        return sorted(n for n in os.listdir(BACKUPS) if n.startswith("herdr-") and n.endswith("tabs-session.json"))
    except OSError:
        return []


def fetch(name):
    try:
        with open(os.path.join(BACKUPS, name)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def title_of(uuid):
    """A snapshot knows the tab LABEL but not the session title, and the label is the short word in
    the tab bar, not what the session is. Join the real title on at read time from the optional
    title store; absent, the tab label is shown instead."""
    try:
        with open(os.path.expanduser("~/.claude/state/state_claude_session_titles.json")) as fh:
            row = json.load(fh).get(uuid)
    except (OSError, ValueError):
        return ""
    if not isinstance(row, dict):
        return ""
    for f in ("last_written", "cached_custom", "cached_ai"):
        if row.get(f):
            return row[f]
    return ""


def sessions_from_layout(doc):
    """A herdr layout snapshot -> the sessions that were LIVE at that moment.

    agent_session is present in the layout only while an agent is alive, so the entries in an hourly
    backup ARE that hour's running set. Panes are keyed by herdr's internal id, so the public tab id
    is rebuilt from the workspace's public_tab_numbers list, positionally against tabs[].
    """
    out = []
    for ws in doc.get("workspaces") or []:
        nums, tabs = ws.get("public_tab_numbers") or [], ws.get("tabs") or []
        if len(nums) != len(tabs):
            continue
        for num, tab in zip(nums, tabs):
            for pane in (tab.get("panes") or {}).values():
                uuid = ((pane or {}).get("agent_session") or {}).get("value")
                if uuid:
                    out.append({"tab": f"{ws['id']}:t{encode(num)}", "uuid": uuid,
                                "title": tab.get("custom_name") or "",
                                "stored_title": title_of(uuid)})
                    break
    return sorted(out, key=lambda s: s["tab"])


def list_snapshots(limit=24):
    names = snapshot_names()[-limit:]
    if not names:
        print(f"no backups in {BACKUPS} (herdr_session_snapshot.sh writes them hourly).", file=sys.stderr)
        return 1
    print(f"the last {len(names)} hourly backups, and how many sessions were running in each:")
    for n in names:
        m = re.search(r"herdr-(\d{8})_(\d{4})-", n)
        doc = fetch(n)
        c = len(sessions_from_layout(doc)) if doc else "?"
        print(f"   {m.group(1)}_{m.group(2)}   {c} running")
    print("\nrestore one with:  hr --from <YYYYMMDD_HHMM>")
    return 0


def usage():
    return __doc__.strip().split("Usage:", 1)[1].split("Exit 0")[0].rstrip()


def main():
    args = sys.argv[1:]
    # Validate every argument before acting: an unknown flag must never fall through to a REAL restore.
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-h", "--help"):
            print("Usage:" + usage())
            return 0
        if a in ("-n", "--dry-run", "--list"):
            i += 1
        elif a in ("--only", "--from"):
            if i + 1 >= len(args) or args[i + 1].startswith("-"):
                print(f"{a} needs a value\nUsage:{usage()}", file=sys.stderr)
                return 2
            i += 2
        else:
            print(f"unknown argument: {a}\nUsage:{usage()}", file=sys.stderr)
            return 2
    dry = "-n" in args or "--dry-run" in args
    only = [args[i + 1] for i, a in enumerate(args) if a == "--only" and i + 1 < len(args)]
    frm = next((args[i + 1] for i, a in enumerate(args) if a == "--from" and i + 1 < len(args)), None)
    if "--list" in args:
        return list_snapshots()

    if frm:
        # Restore a set from a point in TIME rather than the last live one. This is the "bring back
        # the set I had before something opened many more" case: the current recording holds the
        # larger set, so the answer has to come from the hourly archive instead.
        match = [n for n in snapshot_names() if frm in n]
        if not match:
            print(f"no backup in {BACKUPS} matching '{frm}'. Try  hr --list", file=sys.stderr)
            return 2
        doc = fetch(match[-1])
        if doc is None:
            print(f"could not read {match[-1]} in {BACKUPS}.", file=sys.stderr)
            return 2
        rec = {"captured_at": match[-1], "sessions": sessions_from_layout(doc)}
    else:
        try:
            with open(STORE) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            print(f"no record at {STORE} — nothing to restore from.", file=sys.stderr)
            print("It is written every minute while herdr is up; if herdr has never run since the "
                  "recorder was installed, there is nothing to recover.", file=sys.stderr)
            return 2
    wanted = [s for s in rec.get("sessions", []) if not only or s["tab"] in only]
    if not wanted:
        print("the record holds no sessions to restore.")
        return 0

    when = rec.get("captured_at", "unknown")
    if frm:
        m = re.search(r"(\d{8})_(\d{4})-", when)
        when = f"{m.group(1)} at {m.group(2)[:2]}:{m.group(2)[2:]}" if m else when
        print(f"{len(wanted)} sessions were running on {when}:")
    else:
        print(f"{len(wanted)} sessions were running when herdr was last seen (recorded {when}):")
    for s in wanted:
        print(f"   {s['tab']:10} {s.get('stored_title') or s.get('title') or s['uuid']}")
    if dry:
        print("\n--dry-run: nothing started")
        return 0

    # This does NOT start herdr. Starting it is `h` or the login LaunchAgent, and a restore script
    # that also launched the server would be two jobs wearing one name.
    if not herdr_up():
        print("\nherdr is not running. Start it with  h  and run this again.", file=sys.stderr)
        return 1

    tabs = panes_by_tab()
    started = skipped = failed = 0
    for s in wanted:
        tab, uuid = s["tab"], s["uuid"]
        name = s.get("stored_title") or s.get("title") or uuid
        if not transcript_exists(uuid):
            print(f"   SKIP {tab}  transcript is gone: {name}")
            skipped += 1
            continue
        if tab not in tabs:
            print(f"   SKIP {tab}  no such tab in herdr now: {name}")
            skipped += 1
            continue
        pane, live = tabs[tab]
        if live == uuid:
            print(f"   SKIP {tab}  already running: {name}")
            skipped += 1
            continue
        if live:
            print(f"   SKIP {tab}  a different session is running there: {name}")
            skipped += 1
            continue
        try:
            r = call("pane.send_text", {"pane_id": pane, "text": f"cr {uuid}\n"})
            if r.get("error"):
                raise RuntimeError(r["error"].get("message", "unknown"))
        except (OSError, ValueError, RuntimeError) as e:
            print(f"   FAIL {tab}  {name}: {e}", file=sys.stderr)
            failed += 1
            continue
        print(f"   started {tab}  {name}")
        started += 1
        time.sleep(1)      # each cr launches a claude; do not start a dozen in the same instant
    print(f"\n{started} started, {skipped} skipped, {failed} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
