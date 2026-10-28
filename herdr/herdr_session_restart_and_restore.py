#!/usr/bin/env python3
"""Restart the herdr server and put a chosen set of sessions back, in one command.

The problem this solves is that the job kills its own runner. Restarting the herdr server tears
down every pane, so a plain `restart; then restore` typed into a pane dies halfway through — herdr
comes back with every tab bare and nothing to say why. This detaches from the terminal first
(double fork plus setsid, so it is not in the pane's process group and does not share its
controlling terminal), then does the restart and the restore from outside the blast radius.

Everything goes to ~/Library/Logs/knowledge-worker-stack/herdr_session_restart_and_restore.log, which is the only place the story
survives — by the time it matters, the terminal that launched it no longer exists.

Usage:  herdr_session_restart_and_restore.py <YYYYMMDD_HHMM>   restore that hour's set after the restart
        herdr_session_restart_and_restore.py --last            restore the last recorded live set
        herdr_session_restart_and_restore.py ... --check       validate and detach-test, do NOT restart
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
LOG = f"{HOME}/Library/Logs/knowledge-worker-stack/herdr_session_restart_and_restore.log"
SOCK = f"{HOME}/.config/herdr/herdr.sock"
HERDR = shutil.which("herdr") or "/opt/homebrew/bin/herdr"
AGENT = os.environ.get("HERDR_LAUNCH_AGENT", "local.herdr.server")   # the login LaunchAgent, herdr/README.md


def say(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


def herdr_up():
    if not os.path.exists(SOCK):
        return False
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(SOCK)
        s.sendall(b'{"id":"p","method":"ping","params":{}}\n')
        buf = b""
        while not buf.endswith(b"\n"):
            c = s.recv(65536)
            if not c:
                break
            buf += c
        s.close()
        return "result" in json.loads(buf.decode())
    except (OSError, ValueError):
        return False


def tab_count():
    try:
        with open(f"{HOME}/.config/herdr/session.json") as fh:
            return sum(len(w.get("tabs") or []) for w in json.load(fh).get("workspaces") or [])
    except (OSError, ValueError):
        return 0


def daemonize():
    """Double fork + setsid: leave the pane's process group and its controlling terminal, so that
    killing the pane cannot kill this. A single fork is not enough — the child keeps the terminal."""
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    os.close(os.open(os.devnull, os.O_RDONLY))
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)


def main():
    args = sys.argv[1:]
    check = "--check" in args
    args = [a for a in args if a != "--check"]
    if args in (["-h"], ["--help"]):
        print("Usage:" + __doc__.strip().split("Usage:")[-1])
        return 0
    if len(args) != 1 or (args[0].startswith("-") and args[0] != "--last"):
        print(__doc__.strip().split("Usage:")[-1], file=sys.stderr)
        return 2
    target = args[0]

    # Validate BEFORE detaching. A bad argument must fail on the terminal the human is looking at,
    # not into a log file after their whole workspace has already been torn down.
    sib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "herdr_session_restore.py")
    restore = [sib if os.access(sib, os.X_OK) else "herdr_session_restore.py"] + ([] if target == "--last" else ["--from", target])
    probe = subprocess.run(restore + ["--dry-run"], capture_output=True, text=True)
    if probe.returncode != 0:
        print(probe.stdout + probe.stderr, file=sys.stderr)
        print("refusing to restart: that restore would not work.", file=sys.stderr)
        return 2
    planned = probe.stdout.strip().splitlines()
    print(planned[0] if planned else "restore validated")
    before = tab_count()
    print(f"herdr currently has {before} tabs; they are rebuilt by the restart, not lost.")
    if check:
        print("--check: validated and NOT restarting.")
        return 0

    print(f"detaching; herdr restarts in a moment. Story lands in {LOG}")
    sys.stdout.flush()
    daemonize()

    say(f"=== restart + restore {target} ===")
    say(f"{before} tabs before; {len(planned) - 1} sessions to restore")
    # Stop the server and start it again through the login LaunchAgent. The old one must be gone
    # first: a second server refuses while the socket answers.
    r = subprocess.run([HERDR, "server", "stop"], capture_output=True, text=True)
    say(f"herdr server stop -> rc={r.returncode} {r.stdout.strip()} {r.stderr.strip()}")
    for i in range(30):
        if not herdr_up():
            break
        time.sleep(1)
    else:
        say("herdr still answering 30s after stop; restart NOT attempted")
        return 1
    r = subprocess.run(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{AGENT}"],
                       capture_output=True, text=True)
    say(f"launchctl kickstart {AGENT} -> rc={r.returncode} {r.stdout.strip()} {r.stderr.strip()}")
    if r.returncode != 0:
        say("FAILED to restart. herdr may be down; start it with  h")
        return 1

    for i in range(120):
        if herdr_up():
            say(f"herdr answered after {i}s")
            break
        time.sleep(1)
    else:
        say("herdr never answered. Start it with  h  then run the restore by hand.")
        return 1

    # The tabs are replayed from session.json, so wait for the count to come back rather than
    # racing it — a restore that runs against a half-built layout skips tabs as "not found".
    for i in range(60):
        if tab_count() >= before:
            say(f"layout rebuilt: {tab_count()} tabs after {i}s")
            break
        time.sleep(1)
    else:
        say(f"layout still at {tab_count()} of {before} tabs; restoring anyway")
    time.sleep(3)                       # let the rebuilt panes reach their shell prompt

    # Relaunching every session at once is the suspected trigger for Claude Code silently turning off
    # fullscreen for an account, which leaves a status line that scrolls away. The repair ships in
    # knowledge-worker-stack claude-code/; optional and fail-soft: absent or failing, the restore goes on.
    fixer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude_fix_status_line_lost_on_scroll.py")
    if not os.access(fixer, os.X_OK):
        fixer = shutil.which("claude_fix_status_line_lost_on_scroll.py")
    if fixer:
        try:
            fs = subprocess.run([fixer], capture_output=True, text=True, timeout=60)
            for line in (fs.stdout or "").strip().splitlines():
                say("fullscreen: " + line)
        except (OSError, subprocess.SubprocessError) as e:
            say(f"fullscreen: repair skipped ({e})")

    r = subprocess.run(restore, capture_output=True, text=True)
    say(r.stdout.strip())
    if r.stderr.strip():
        say("stderr: " + r.stderr.strip())
    say(f"restore rc={r.returncode}")
    say("=== done ===")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
