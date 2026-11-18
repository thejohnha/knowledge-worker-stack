#!/usr/bin/python3
"""claude_restart_sessions_after_update.py — a sweep every 5 minutes (LaunchAgent): every live claude session in
herdr whose footer shows "✔ Update installed · /restart to apply" gets `/restart` typed into it, but only while
it is safe.

/restart re-execs claude IN PLACE on the newly installed build: same process id, same pane, same
session id, same permission mode (skip mode comes back as `--permission-mode bypassPermissions`), and
it takes no model turn. Session-only CronCreate jobs survive it. It REFUSES by itself while background
work runs ("Can't restart while work is running in the background"), so a shell or Monitor is never killed.

Gates, in order — every one must pass:
  1. a claude agent with a session id, agent_status idle or done (never working, never blocked —
     blocked is a permission prompt or question dialog)
  2. the pane's claude process runs an OLDER version than ~/.local/bin/claude points at
  3. the notice sits on the line directly above the input box's top border (a conversation that
     merely quotes the phrase does not count)
  4. the footer's mode line shows no background work ("· 1 shell", "· 2 monitors", ...)
  5. the transcript has not been written for IDLE_MIN minutes
  6. you are not at the pane: it is not focused while this Mac has had keyboard/mouse input in the
     last 10 minutes (the comms manager's rule)
  7. a /restart this session refused is not retried for RETRY_MIN minutes
  8. under tell's per-pane lock, and the comms manager's per-session wake lock when it is installed:
     still idle, and the input box is EMPTY
     (`herdr_session_manage.sh draft` exit 0 — exit 1 is a draft, exit 2 is "could not look")
At most MAX_PER_RUN restarts per sweep. Each is verified: same session id back in the pane on the
installed version, notice gone. Log: ~/.claude/state/state_claude_restart_sessions_after_update.log

  claude_restart_sessions_after_update.py            # the sweep (LaunchAgent)
  claude_restart_sessions_after_update.py --dry-run  # print what it would restart, touch nothing
  claude_restart_sessions_after_update.py --only <uuid prefix>   # restrict to one session (testing)
Doc: herdr/README.md in knowledge-worker-stack, step 9.
"""
import fcntl, json, os, re, shutil, subprocess, sys, time

HOME = os.path.expanduser("~")
_path = os.environ.get("PATH", "/usr/bin:/bin").split(":")   # launchd's bare PATH: add the usual homes, after
os.environ["PATH"] = ":".join(_path + [d for d in (f"{HOME}/bin", f"{HOME}/.local/bin", "/opt/homebrew/bin",
                                                   "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")
                                       if d not in _path])
STATE = f"{HOME}/.claude/state/state_claude_restart_sessions_after_update.json"
LOG = f"{HOME}/.claude/state/state_claude_restart_sessions_after_update.log"
IDLE_MIN = float(os.environ.get("AUTORESTART_IDLE_MIN", 3))
RETRY_MIN = 30
MAX_PER_RUN = int(os.environ.get("AUTORESTART_MAX", 3))
AWAY = 10 * 60
NOTICE = "Update installed · /restart to apply"
REFUSED = "Can't restart while work is running"
VER = re.compile(r"^\d+\.\d+\.\d+$")


def log(msg):
    with open(LOG, "a") as fh:
        fh.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")


def run(*cmd, timeout=30):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except (OSError, subprocess.SubprocessError):
        return -1, ""


def agents():
    rc, out = run("herdr", "agent", "list")
    try:
        return json.loads(out)["result"]["agents"] if rc == 0 else []
    except (ValueError, KeyError):
        return []


def agent(pane):
    return next((a for a in agents() if a.get("pane_id") == pane), None)


def version(pane):
    rc, out = run("herdr", "pane", "process-info", "--pane", pane)
    try:
        names = [p.get("name", "") for p in json.loads(out)["result"]["process_info"]["foreground_processes"]]
    except (ValueError, KeyError, TypeError):
        return None
    return next((n for n in names if VER.match(n)), None)


def screen(pane):
    return run("herdr", "pane", "read", pane, "--source", "visible", "--format", "text")[1].splitlines()


def notice_shown(lines):
    """The notice is the line right above the input box's top border; the box is the LAST ❯ line."""
    box = max((i for i, l in enumerate(lines) if l.startswith("❯")), default=-1)
    if box < 2 or not lines[box - 1].lstrip().startswith("─"):
        return False
    return lines[box - 2].rstrip().endswith(NOTICE)


def background_work(lines):
    mode = next((l for l in reversed(lines) if l.strip().startswith("⏵")), "")
    return re.search(r"·\s*\d+\s+\w+", mode) is not None


def hid_idle():
    rc, out = run("ioreg", "-c", "IOHIDSystem", timeout=10)
    try:
        return int(next(l for l in out.splitlines() if '"HIDIdleTime"' in l).split("=")[-1]) / 1e9
    except (StopIteration, ValueError):
        return None


def transcript_age_min(uuid):
    rc, path = run("claude_session_transcript.sh", uuid)
    path = path.strip()
    return (time.time() - os.path.getmtime(path)) / 60 if path and os.path.isfile(path) else None


TELL_LOCKS = f"{HOME}/.claude/state/herdr_tell_locks"   # herdr_session_manage.sh tell's per-pane lock


def send(pane, uuid):
    """Runs under tell's per-pane lock (and the wake lock, when the comms manager is installed), so no tell
    can start typing between the empty-box check and the /restart: re-check idle + empty box, then type /restart."""
    os.makedirs(TELL_LOCKS, exist_ok=True)
    lk = open(f"{TELL_LOCKS}/{pane.replace(':', '_')}.lock", "w")
    end = time.time() + 60
    while True:
        try: fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB); break
        except BlockingIOError:
            if time.time() > end: print("a tell held the box for 60 s"); return 5
            time.sleep(0.2)
    a = agent(pane)
    if not a or (a.get("agent_session") or {}).get("value") != uuid or a.get("agent_status") not in ("idle", "done"):
        print("not idle at send time"); return 3
    rc, out = run("herdr_session_manage.sh", "draft", pane, timeout=60)
    if rc != 0:
        print("draft in box" if rc == 1 else "input box unreadable"); return 4
    run("herdr", "agent", "prompt", pane, "/restart")
    return 0


def verify(pane, uuid, installed):
    """Up to 90 s: same session back in the pane on the installed build, notice gone; or a refusal."""
    for _ in range(18):
        time.sleep(5)
        lines = screen(pane)
        if any(REFUSED in l for l in lines[-15:]):
            return "refused"
        a = agent(pane)
        if (a and (a.get("agent_session") or {}).get("value") == uuid and version(pane) == installed
                and any(l.startswith("❯") for l in lines) and not notice_shown(lines)):
            return "ok"
    return "unconfirmed"


def main():
    if sys.argv[1:2] == ["_send"]:
        sys.exit(send(sys.argv[2], sys.argv[3]))
    dry = "--dry-run" in sys.argv
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
    if not dry:                                    # a dry run writes nothing, not even the lock
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        lock = open(STATE + ".lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return                                 # previous sweep still verifying
    installed = os.path.basename(os.path.realpath(f"{HOME}/.local/bin/claude"))
    if not VER.match(installed):
        msg = f"ERROR cannot read installed version from ~/.local/bin/claude ({installed})"
        print(msg) if dry else log(msg)
        return
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    idle = hid_idle()
    done = 0
    for a in agents():
        if done >= MAX_PER_RUN:
            break
        uuid, pane = (a.get("agent_session") or {}).get("value"), a.get("pane_id")
        if a.get("agent") != "claude" or not uuid or not uuid.startswith(only) or a.get("agent_status") not in ("idle", "done"):
            continue
        v = version(pane)
        if not v or v == installed:
            continue
        lines = screen(pane)
        if not notice_shown(lines):
            continue
        why = None
        if background_work(lines):
            why = "background work in footer"
        elif (age := transcript_age_min(uuid)) is None or age < IDLE_MIN:
            why = f"transcript written {age:.1f} min ago" if age is not None else "no transcript"
        elif a.get("focused") and idle is not None and idle < AWAY:
            why = "you are at this pane"
        elif time.time() - state.get(uuid, {}).get("refused_at", 0) < RETRY_MIN * 60:
            why = "refused recently"
        if why:
            if dry:
                print(f"skip {pane} {uuid[:8]} {v}: {why}")
            continue
        if dry:
            print(f"WOULD restart {pane} {uuid[:8]} {v} -> {installed}  {a.get('terminal_title_stripped', '')}")
            continue
        sender = [sys.executable, os.path.abspath(__file__), "_send", pane, uuid]
        if shutil.which("ai_comms_manager.py"):    # optional: share the comms manager's per-session wake lock
            rc, out = run("ai_comms_manager.py", "wake-lock", uuid, "--wait", "10", "--", *sender, timeout=120)
        else:
            rc, out = run(*sender, timeout=120)
        if rc != 0:
            log(f"skipped {uuid[:8]} {pane}: {out.strip() or 'wake lock busy' if rc == 75 else out.strip() or f'rc {rc}'}")
            continue
        done += 1
        res = verify(pane, uuid, installed)
        if res == "refused":
            state[uuid] = {"refused_at": time.time()}
            with open(STATE + ".tmp", "w") as fh:
                json.dump(state, fh)
            os.replace(STATE + ".tmp", STATE)
        log(f"{'restarted' if res == 'ok' else res} {uuid[:8]} {pane} {v} -> {installed}  {a.get('terminal_title_stripped', '')}")


if __name__ == "__main__":
    main()
