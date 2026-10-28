#!/usr/bin/env python3
"""Turn a herdr tab id into the Claude Code session that belongs to it.

Two sources, consulted in this order:

  1. ~/.claude/state/state_claude_session_herdr_tabs.json — the durable record, written by the
     SessionStart hook record-herdr-tab.sh, and every minute by
     herdr_session_record_live.sh for a tab whose session has moved. Survives an agent
     exiting, which is the whole point.
  2. ~/.config/herdr/session.json — herdr's own live layout. Authoritative while an agent is
     alive and EMPTY the moment it exits, so it can only ever add a tab the hook missed.

Deliberately does not speak to the herdr socket. The CLI refuses every call whenever the
installed binary is newer than the running server ("client protocol 22 is newer than server
protocol 20"), which is exactly the state the machine is in when a restart is due — the one
moment this lookup has to keep working.

Public ids (wA:t2F) are Crockford base32: digits 0-9 then ABCDEFGHJKMNPQRSTVWXYZ, with I, L, O
and U left out so they cannot be misread as 1, 1, 0 and V. session.json stores the decoded
NUMBER in each workspace's public_tab_numbers list, positionally against tabs[], and the panes
map is keyed by herdr's internal pane id rather than by anything public.

Usage:  herdr_session_resolve_tab.py <TAB_ID>\n        -> "uuid<TAB>source<TAB>title<TAB>recorded_label<TAB>live_label" on stdout
Exit 0 found, 1 not found, 2 bad arguments.
"""
import glob
import json
import os
import sys

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
HOME = os.path.expanduser("~")
STORE = os.environ.get("HERDR_TAB_STORE", f"{HOME}/.claude/state/state_claude_session_herdr_tabs.json")
LIVE = os.environ.get("HERDR_SESSION_JSON", f"{HOME}/.config/herdr/session.json")
TITLES = os.environ.get("CLAUDE_TITLE_STORE", f"{HOME}/.claude/state/state_claude_session_titles.json")


def decode(sym):
    """Crockford base32 -> int. Raises ValueError on a symbol outside the alphabet."""
    n = 0
    for ch in sym.upper():
        n = n * 32 + CROCKFORD.index(ch)   # .index raises ValueError, which is the wanted signal
    return n


def load(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def config_dirs():
    """Every Claude Code config dir: ~/.claude plus each account in accounts.json."""
    dirs = [f"{HOME}/.claude"]
    acc = load(f"{HOME}/.config/knowledge-worker-stack/accounts.json")
    if isinstance(acc, dict):
        dirs += [os.path.expanduser(v) for v in acc.values() if isinstance(v, str)]
    return dirs


def alive(uuid):
    """True when the session's transcript still exists in any project folder of any account."""
    return bool(uuid) and any(glob.glob(f"{d}/projects/*/{uuid}.jsonl") for d in config_dirs())


def from_store(tab):
    """The tab's current session, or the most recent PREVIOUS one whose transcript still exists.

    The current row is not always the right answer. Any claude started inside a pane inherits that
    pane's HERDR_TAB_ID and records itself as the tab's session, throwaway ones included, so a row
    can be taken over by a session that is then deleted. Falling back beats resolving a tab to a
    transcript that is not there, which presents to the human as "hr cannot find my session".
    """
    d = load(STORE) or {}
    row = (d.get("tabs") or {}).get(tab)
    if not isinstance(row, dict):
        return None
    if alive(row.get("uuid")):
        return row["uuid"]
    for prev in row.get("history") or []:
        if alive(prev.get("uuid")):
            return prev["uuid"]
    return row.get("uuid") or None      # nothing survives; hand the current one back and let cr say so


def recorded_label(tab):
    d = load(STORE) or {}
    row = (d.get("tabs") or {}).get(tab)
    return (row.get("label") or "") if isinstance(row, dict) else ""


def live_label(tab):
    """The tab's CURRENT label, straight out of herdr's own layout file.

    hr compares this against the label recorded beside the session id. They agree unless the tab
    ids themselves moved, which is the one failure that would make hr resume the WRONG session:
    it would look like an ordinary success. Public ids are stored in session.json and replayed
    from it across a restart; the check backs that property up rather than trusting it.
    """
    d = load(LIVE)
    if not d:
        return ""
    try:
        ws_id, _, tab_sym = tab.partition(":")
        if not tab_sym.startswith("t"):
            return ""
        want = decode(tab_sym[1:])
    except ValueError:
        return ""
    for ws in d.get("workspaces") or []:
        if ws.get("id") != ws_id:
            continue
        nums = ws.get("public_tab_numbers") or []
        tabs = ws.get("tabs") or []
        if want in nums and nums.index(want) < len(tabs):
            return tabs[nums.index(want)].get("custom_name") or ""
    return ""


def from_live(tab):
    """Walk session.json for the tab's panes and return the first session id one carries."""
    d = load(LIVE)
    if not d:
        return None
    try:
        ws_id, _, tab_sym = tab.partition(":")
        if not tab_sym.startswith("t"):
            return None
        want = decode(tab_sym[1:])
    except ValueError:
        return None
    for ws in d.get("workspaces") or []:
        if ws.get("id") != ws_id:
            continue
        nums = ws.get("public_tab_numbers") or []
        tabs = ws.get("tabs") or []
        if want not in nums:
            return None
        i = nums.index(want)
        if i >= len(tabs):
            return None                     # a truncated or mid-write file, not a missing tab
        for pane in (tabs[i].get("panes") or {}).values():
            sess = (pane or {}).get("agent_session") or {}
            if sess.get("value"):
                return sess["value"]
    return None


def title_of(uuid):
    """Title for display only — never a key, so a miss costs a bare uuid and nothing else.

    Reads the optional title store. last_written is the title the session currently shows, but a
    hand-retitled session can carry cached_custom with no last_written at all, so fall through
    rather than print nothing.
    """
    d = load(TITLES) or {}
    row = d.get(uuid)
    if not isinstance(row, dict):
        return ""
    for field in ("last_written", "cached_custom", "cached_ai"):
        if row.get(field):
            return row[field]
    return ""


def main():
    args = sys.argv[1:]
    # --live-label prints the tab's current herdr label and nothing else. record-herdr-tab.sh calls
    # it so the label is written down BESIDE the session id, at the same moment, by one reader.
    if len(args) == 2 and args[0] == "--live-label":
        print(live_label(args[1]))
        return 0
    if args in (["-h"], ["--help"]):
        print(__doc__.strip().split("Usage:")[-1].strip())
        return 0
    if len(args) != 1 or not args[0] or args[0].startswith("-"):
        print("usage: herdr_session_resolve_tab.py [--live-label] <TAB_ID>", file=sys.stderr)
        return 2
    tab = args[0]
    for source, fn in (("store", from_store), ("herdr", from_live)):
        uuid = fn(tab)
        if uuid:
            print("\t".join([uuid, source, title_of(uuid),
                              recorded_label(tab), live_label(tab)]))
            return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
