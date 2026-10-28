#!/usr/bin/env python3
"""PreToolUse(CronCreate|Monitor|Bash) hook: make the comms manager the default way to watch.

WHY THIS EXISTS
A watch on new mail or messages, or a wake at a set time, belongs to the comms manager
(claude_frontdesk.py, comms/README.md). The in-session tools all die with the session: CronCreate is
in-memory and expires after 7 days, Monitor is cut off at 30 minutes, a background loop dies with its
shell. None of them screens outside text before the model reads it.

WHAT IT STOPS, ONCE PER SESSION PER TOOL
  CronCreate                every call: each one is a timed wake the comms manager's `timer` can do
  Monitor                   a command that reads mail or messages (`g search`, `gws gmail`, Messages'
                            chat.db, Outlook's Graph API, Mattermost's API)
  Bash, run_in_background   the same, inside a loop (while/until/sleep)
The first such call is DENIED with the comms manager's usage as the reason; re-issuing it goes
through, so a watch that really should end with the session (the user ran /loop, a build being
narrated) costs one round trip. A denial is the only way to speak before the call runs:
additionalContext arrives after the result.

FAIL-SOFT: silent when the comms manager is not running on this Mac (heartbeat older than
10 minutes or missing), and on any error at all.
"""
import fcntl, json, os, re, sys, time

STATE = os.environ.get("FRONTDESK_GUARD_STATE") or os.path.expanduser("~/.claude/state")   # tests: a temp dir
HEARTBEAT = os.path.join(STATE, "state_claude_frontdesk", "heartbeat")
SEEN = os.path.join(STATE, "state_claude_session_frontdesk_nudged.json")
README = ("Which Claude Code sessions watch-use-frontdesk-guard.py has already stopped once, per tool, so "
          "each is told about the comms manager only once. Keys are session ids; values map tool name to the "
          "time. Rows older than 30 days are dropped. Safe to delete.")
MESSAGES = re.compile(r"\bg\s+search\b|\bgws\s+gmail\b|chat\.db\b|graph\.microsoft\.com|/api/v4/\S*posts")
LOOP = re.compile(r"\b(while|until|sleep)\b")
REASON = (
    "STOP: watches go to the comms manager (claude_frontdesk.py) by default. Re-issue this identical call and it "
    "will go through; do that only if the watch SHOULD end with this session (the user ran /loop, a build or "
    "deploy you are narrating).\n\n"
    "%s dies with this session. The comms manager (a launchd job, every minute) outlives it: it wakes this "
    "session or its newest successor, even after the session stops; outside text is screened by an AI "
    "injection check and handed over as a file, never typed in. Rules: comms/README.md in knowledge-worker-stack, "
    "and `claude_frontdesk.py --help`.\n\n"
    "  claude_frontdesk.py add <description> --what TEXT --then TEXT \\\n"
    "    (--every 10m | --daily HH:MM | --at 'YYYY-MM-DD HH:MM') --until 14d|YYYY-MM-DD|never \\\n"
    "    [--repeat] [--max-per-day N] -- <kind> <args>\n"
    "  kinds: gmail_new '<gmail query>' | outlook_new <address> | imessage_new <thread> | "
    "mattermost_new <channel> | new_files <dir> <patterns> | timer (no args)\n"
    "  claude_frontdesk.py list | rm <name>")


def claim(sid, tool):
    """True the first time this session meets this tool; records the claim."""
    with open(SEEN + ".lock", "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            with open(SEEN) as f:
                d = json.load(f)
        except Exception:
            d = {}
        now = time.time()
        rows = {k: v for k, v in d.items() if k != "_readme" and isinstance(v, dict)
                and max(v.values(), default=0) > now - 30 * 86400}
        if tool in rows.get(sid, {}):
            return False
        rows.setdefault(sid, {})[tool] = now
        tmp = SEEN + ".tmp.%d" % os.getpid()
        with open(tmp, "w") as f:
            json.dump(dict(_readme=README, **rows), f, indent=1)
        os.replace(tmp, SEEN)
        return True


def main():
    data = json.load(sys.stdin)
    tool, inp = data.get("tool_name", ""), data.get("tool_input") or {}
    cmd = inp.get("command") or ""
    if tool == "CronCreate":
        what = "CronCreate (in-memory, gone when Claude exits, expires after 7 days)"
    elif tool == "Monitor" and MESSAGES.search(cmd):
        what = "Monitor (cut off at 30 minutes)"
    elif tool == "Bash" and inp.get("run_in_background") and MESSAGES.search(cmd) and LOOP.search(cmd):
        what = "A background loop"
    else:
        return
    if time.time() - os.path.getmtime(HEARTBEAT) > 600:
        return
    if claim(data.get("session_id") or "unknown", tool):
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
              "permissionDecision": "deny", "permissionDecisionReason": REASON % what}}))


try:
    main()
except Exception:
    pass
sys.exit(0)
