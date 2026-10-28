#!/usr/bin/env python3
"""Undo Claude Code's automatic fullscreen opt-out, for every account.

Claude Code draws its conversation on the terminal's ALTERNATE screen ("fullscreen"). That is what
keeps the status line and the input box pinned while you scroll: the alternate screen has no
scrollback, so herdr has nothing to scroll into and the wheel goes to Claude Code, which scrolls its
own view. When fullscreen is off, output becomes ordinary terminal scrollback, herdr owns the
scroll, and the footer scrolls away with everything else.

Claude Code turns fullscreen off BY ITSELF after repeated failures to enter it, and records the
decision in the account's state file as:

    "fullscreenAutoDisabled": {"version": "<version>", "at": <epoch ms>, "strikes": <n>}

It is permanent until the key is removed, and nothing in the UI says it happened.

A herdr restart relaunches every session at once, so this runs after a herdr restore as a cheap
guard.

Removing the key does not force fullscreen on; it restores the automatic behavior, so Claude Code
tries again on the next launch. Sessions ALREADY RUNNING keep whatever they started with — the flag
is read once, at startup.

Usage:  claude_fix_status_line_lost_on_scroll.py [--check]
Exit 0 whether or not anything was found; 1 only if a file could not be written.
"""
import json
import os
import shutil
import sys
import time

HOME = os.path.expanduser("~")
KEY = "fullscreenAutoDisabled"
LOG = f"{HOME}/Library/Logs/knowledge-worker-stack/claude_fix_status_line_lost_on_scroll.log"


def state_files():
    """Every account's state file, from ~/.config/knowledge-worker-stack/accounts.json (absent = one account,
    default, at ~/.claude). The ~/.claude account keeps it in HOME, at ~/.claude.json; any other
    config dir keeps it inside, at <dir>/.claude.json. ~/.claude/.claude.json is NOT the default
    account's file and must not be read as such."""
    try:
        with open(f"{HOME}/.config/knowledge-worker-stack/accounts.json") as fh:
            acc = json.load(fh)
    except (OSError, ValueError):
        acc = {}
    if not isinstance(acc, dict):
        acc = {}
    dirs = {k: os.path.expanduser(v) for k, v in acc.items() if isinstance(v, str)}
    dirs.setdefault("default", f"{HOME}/.claude")
    out, seen = [], set()
    for name, d in dirs.items():
        if os.path.realpath(d) == os.path.realpath(f"{HOME}/.claude"):
            path = f"{HOME}/.claude.json"
        else:
            path = f"{d}/.claude.json"
        if path not in seen and os.path.exists(path):
            seen.add(path)
            out.append((name, path))
    return out


def say(msg):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
    print(line)
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def main():
    args = sys.argv[1:]
    if any(a in ("-h", "--help") for a in args):
        print(__doc__.strip())
        return 0
    bad = [a for a in args if a != "--check"]
    if bad:
        print(f"unknown argument: {bad[0]} — usage: {os.path.basename(sys.argv[0])} [--check]", file=sys.stderr)
        return 2
    check = "--check" in args
    found = fixed = 0
    for acct, path in state_files():
        try:
            with open(path) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        if KEY not in d:
            continue
        found += 1
        v = d[KEY]
        when = ""
        if isinstance(v, dict) and v.get("at"):
            when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(v["at"] / 1000))
        strikes = v.get("strikes") if isinstance(v, dict) else "?"
        say(f"{acct}: fullscreen was auto-disabled at {when or 'unknown'} after {strikes} strikes")
        if check:
            continue
        shutil.copy2(path, f"{path}.before-fullscreen-fix")
        del d[KEY]
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(d, fh, indent=2)
            with open(tmp) as fh:
                json.load(fh)              # parses before it replaces the live file
        except (OSError, ValueError) as e:
            say(f"{acct}: REFUSING to replace {path}: {e}")
            try: os.remove(tmp)
            except OSError: pass
            return 1
        os.replace(tmp, path)
        fixed += 1
        say(f"{acct}: removed. New sessions get a pinned footer again; running ones keep what they have.")
    if not found:
        say("no account has fullscreen auto-disabled" if check else "nothing to fix")
    elif check:
        say(f"{found} account(s) affected — run without --check to fix")
    return 0


if __name__ == "__main__":
    sys.exit(main())
