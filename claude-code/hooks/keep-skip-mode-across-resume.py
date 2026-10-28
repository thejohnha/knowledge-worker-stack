#!/usr/bin/env python3
"""SessionStart hook: a session that was in skip mode (bypassPermissions) when it last took a prompt, and
has just been RESUMED without it, restarts itself into skip mode: a session in skip mode stays in skip
mode. herdr's own restore after a reboot types a bare `claude --resume <id>`, and other resume paths pass
their own mode, so every resume path otherwise drops the mode silently.

It restores what the user chose for THIS session, so both modes come only from records Claude Code
itself writes, never from screen text or anything the model printed. The previous mode is the top-level
`permissionMode` of the transcript's newest record that carries one (a prompt records the mode it was
sent in), read before this run writes any. The current mode is the hook input's `permission_mode`, else
the flag on the claude process's command line. The restart is
claude_restart_session.sh <uuid> --dangerously-skip-permissions, with the effort of the last reply (a resume restores neither),
fired from a detached waiter once herdr lists the session as an agent in its pane, which it may not yet
at SessionStart. The waiter's second resume arrives in skip mode, so this hook then does nothing. A
per-session guard allows one arming per 15 minutes, so a restart that fails to apply the flag cannot loop.
Prints one line into the session's context, so it knows the restart is coming rather than guessing.
Log: ~/.claude/state/state_claude_session_keep_skip_mode.log
"""
import json, mmap, os, subprocess, sys, time

STATE = os.path.expanduser("~/.claude/state/state_claude_session_keep_skip_mode.json")
LOG = os.path.expanduser("~/.claude/state/state_claude_session_keep_skip_mode.log")
GUARD_S = 15 * 60

def newest(path, needle, pick):
    """Scan the transcript backwards for the newest record containing `needle` that `pick` accepts."""
    try:
        with open(path, "rb") as fh, mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            pos = len(mm)
            while True:
                i = mm.rfind(needle, 0, pos)
                if i < 0: return None
                s = mm.rfind(b"\n", 0, i) + 1; e = mm.find(b"\n", i)
                try: d = json.loads(mm[s:e if e >= 0 else len(mm)])
                except ValueError: d = None
                v = pick(d) if isinstance(d, dict) else None
                if v: return v
                pos = i
    except (OSError, ValueError): return None

def mode_from_process():
    """Walk up from this hook to the claude process and read its flags."""
    pid = os.getppid()
    for _ in range(6):
        out = subprocess.run(["ps", "-o", "ppid=,args=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        if not out: return ""
        ppid, args = out.split(None, 1)
        if args.split()[0].endswith("claude"): return "bypassPermissions" if "--dangerously-skip-permissions" in args else "other"
        pid = int(ppid)
    return ""

def log(msg):
    with open(LOG, "a") as fh: fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")

def main():
    try: d = json.load(sys.stdin)
    except ValueError: return
    sid, tp = d.get("session_id") or "", d.get("transcript_path") or ""
    if d.get("source") != "resume" or not sid or not os.path.isfile(tp): return
    now = d.get("permission_mode") or mode_from_process()
    if now == "bypassPermissions": return
    was = newest(tp, b'"permissionMode"', lambda r: r.get("permissionMode"))
    if was != "bypassPermissions": return
    # A resume triggered by an outside event (the comms manager, if installed) stays in auto mode on purpose:
    # nobody is watching, so the classifier must stay on. That waker stamps the target in this file just
    # before it resumes it; a stamp under 15 minutes old means this resume is that wake. No file, no stamps.
    try: wakes = json.load(open(os.path.expanduser("~/.claude/state/state_claude_frontdesk_wakes.json")))
    except (OSError, ValueError): wakes = {}
    if time.time() - (wakes.get(sid) or 0) < GUARD_S:
        log(f"{sid[:8]} was in skip mode, resumed as {now or 'unknown'} by a watcher wake — left in auto mode"); return
    if not os.environ.get("HERDR_PANE_ID"):
        log(f"{sid[:8]} was in skip mode, resumed as {now or 'unknown'} outside herdr — the restart needs a herdr pane; not armed"); return
    try: st = json.load(open(STATE))
    except (OSError, ValueError): st = {}
    if time.time() - st.get(sid, 0) < GUARD_S:
        log(f"{sid[:8]} was in skip mode, resumed as {now or 'unknown'} again within 15 min of an arming — not re-armed (loop guard)"); return
    st[sid] = time.time()
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".tmp", "w") as fh: json.dump(st, fh)
    os.replace(STATE + ".tmp", STATE)
    effort = newest(tp, b'"effort"', lambda r: r.get("effort") if r.get("type") == "assistant" else None) or ""
    flags = f"--dangerously-skip-permissions --no-continue{' --effort ' + effort if effort else ''}"   # no auto-continue: a reboot restore would wake every session at once
    waiter = (f'for i in $(seq 1 45); do herdr agent list 2>/dev/null | jq -e --arg u {sid} '
              f'\'.result.agents[]|select(.agent_session.value==$u)\' >/dev/null && break; sleep 2; done; '
              f'RESTART_POLLS=720 claude_restart_session.sh {sid} {flags}')   # wait up to an hour for idle: a session resumed into a long job can stay busy past the default 10 min
    with open(LOG, "a") as fh:
        fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + f"{sid[:8]} was in skip mode, resumed as {now or 'unknown'} — arming: claude_restart_session.sh {flags}\n"); fh.flush()
        subprocess.Popen(["bash", "-c", waiter], stdout=fh, stderr=fh, stdin=subprocess.DEVNULL, start_new_session=True)
    print(f"SKIP MODE: this session was in skip mode before this resume and came back without it. It will "
          f"restart itself into skip mode{' at effort ' + effort if effort else ''} in a few seconds, once idle — "
          f"do not tell the user it is in skip mode before then. Log: {LOG.replace(os.path.expanduser('~'), '~')}")

if __name__ == "__main__":
    main()
