#!/usr/bin/env python3
"""PreToolUse(Bash) guard for another session's input box: one rule for reading it, one for typing into it.

READ. Claude Code paints a "prompt suggestion" (promptSuggestionEnabled in settings) into every EMPTY
input box: gray text predicting the user's next prompt. On screen it is plainly not typed, because it
carries the ANSI dim attribute (SGR 2). `herdr pane read --format text` strips that attribute, so an
empty box reads back as an unsent draft, and an agent then reports drafts the user never typed, or
refuses to quit panes it believes hold unsent work. Format is the only thing that tells them apart:
every --source ends at the input box, --lines returns the TAIL (a small count includes the box more
surely, not less), and over the socket only "format":"ansi" keeps the attribute. So ANSI-preserving
reads (--format ansi, --ansi, --raw) pass and plain-text reads are denied. `herdr agent read` and a
raw socket pane.read/agent.read get the same treatment. A command substitution or subshell wrap,
x=$(herdr pane read ...), is seen: segments split at parentheses and backticks as well as ;|&.

SEND. `herdr agent prompt` does not clear the target's input box before it types: it APPENDS and
submits both together, so a send into a pane holding an unsent draft submits the user's draft for them.
`herdr_session_manage.sh tell` exists to replace it. This rule LOOKS before it refuses: it resolves the
target through `herdr agent list` and asks `herdr_session_manage.sh draft <PANE>`, the same check the
sender uses. Empty box and a target that is not blocked pass untouched; a draft, or a target blocked on
a permission prompt, is denied.

ESCAPE HATCH, both rules. A trailing  # not-a-draft-check  marker (the exact substring, "# " included)
runs the command as-is: a plain-text read that is not a draft check (grepping scrollback for a log
line), or a send into a box already cleared.

FAIL OPEN. Unparseable input, an error, a timeout, an unknown target or an unreadable box allows the
call (the send rule prints a warning): a guard that cannot look must not brick Bash. The subprocess
timeouts are capped so the whole check fits inside this hook's 5 s harness timeout. Deny, not ask,
because auto mode honors only deny.

KNOWN LIMITS. A command wrapped in `bash -c "..."` or run over ssh arrives as one quoted token and is
not seen. `herdr pane send-text` is out of scope: it stages text without submitting it.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

MARKER = "# not-a-draft-check"
REASON = (
    "A plain-text herdr read shows Claude Code's prompt suggestion — the gray text in "
    "every EMPTY input box — as if the user typed it: text mode strips the dim attribute "
    "that marks it, and every --source and --lines variant still includes the box. "
    "Draft check -> herdr_session_manage.sh draft <PANE>. "
    "Quit -> herdr_session_manage.sh quit <PANE>. "
    "What a session found -> read its transcript backwards, not its screen. "
    "Any other screen read -> add --format ansi (dim = suggestion; socket: "
    "\"format\":\"ansi\"), or append # not-a-draft-check to run this as-is."
)

SEND_REASON = (
    "REFUSED: {why}. "
    "Use herdr_session_manage.sh tell <UUID|PANE> \"<message>\" instead — it checks the "
    "box, waits for the target to be ready, resumes it if it is stopped, and proves delivery "
    "from the target's own transcript. Its wait can outlast your 120s tool timeout, so run it "
    "in the background; on a killed call READ the target's transcript before resending, never "
    "blind-retry. Sending anyway (you have cleared the box yourself) -> append "
    + repr(MARKER).strip("'") + " to the command."
)

READ_TOOLS = {"herdr", "h"}          # h (herdr/h) passes every argument straight through to herdr
ANSI_FLAGS = {"--ansi", "--raw", "--format=ansi"}
# ( ) and backtick are segment cuts so x=$(herdr ...), `herdr ...` and (herdr ...) put herdr
# in argv[0]: the capture wrap is exactly the draft-check shape.
SEGMENT_RE = re.compile(r"(?:\|\||&&|[;|&\n()`])")


def is_text_read(argv):
    """True if argv is a `herdr pane|agent read` without an ANSI-preserving flag."""
    if argv[0].rsplit("/", 1)[-1] not in READ_TOOLS:
        return False
    if len(argv) < 3 or argv[1] not in ("pane", "agent") or argv[2] != "read":
        return False
    for i, word in enumerate(argv):
        if word in ANSI_FLAGS:
            return False
        if word == "--format" and i + 1 < len(argv) and argv[i + 1] == "ansi":
            return False
    return True


def is_socket_text_read(command):
    """True for a raw-socket pane.read/agent.read that does not ask for ANSI.
    Requires herdr.sock in the same command, so prose and greps about pane.read pass."""
    if "herdr.sock" not in command:
        return False
    if not re.search(r'"(?:pane|agent)\.read"', command):
        return False
    return not re.search(r'"format"\s*:\s*"ansi"', command)


def gates(command):
    if MARKER in command:
        return False
    if is_socket_text_read(command):
        return True
    for segment in SEGMENT_RE.split(command):
        try:
            argv = shlex.split(segment)
        except ValueError:
            argv = segment.split()
        if argv and is_text_read(argv):
            return True
    return False


# --- second rule: a bare `herdr agent prompt` into a box that is not safe to type into ---

# Overridable so the send rule can be tried against stand-ins instead of a live herdr.
MANAGER = os.environ.get("AGENT_SESSIONS_MANAGER") or next(
    (p for p in (os.path.expanduser("~/bin/herdr_session_manage.sh"), shutil.which("herdr_session_manage.sh")) if p and os.access(p, os.X_OK)),
    "herdr_session_manage.sh")
HERDR = os.environ.get("AGENT_SESSIONS_HERDR") or "herdr"
# Ceilings, not a budget (both calls normally take milliseconds): they keep a sick herdr inside this
# hook's own 5 s harness timeout.
LIST_TIMEOUT = 2.0
DRAFT_TIMEOUT = 2.5       # the box check retries 5x1s on an unreadable pane and so runs past
                          # this on purpose: a pane that unreadable is a fail-open case
PANE_RE = re.compile(r"^w[^:\s]+:p[^:\s]+$")
# `herdr agent prompt --until idle w9:p3 "..."` — without this the VALUE of a flag is read
# as the target, the target then resolves to nothing, and a dangerous send fails open.
VALUE_FLAGS = {"--until", "--timeout"}


def send_target(command):
    """The target of a `herdr agent prompt` in this command, or None if there is no send."""
    if re.search(r'"agent\.prompt"', command) and "herdr.sock" in command:
        hit = re.search(r'"(?:agent_id|pane_id|agent)"\s*:\s*"([^"]+)"', command)
        return hit.group(1) if hit else ""      # "" = a send we cannot address -> fail open
    for segment in SEGMENT_RE.split(command):
        try:
            argv = shlex.split(segment)
        except ValueError:
            continue                            # unbalanced quotes: not a runnable send
        if len(argv) < 4 or argv[0].rsplit("/", 1)[-1] not in READ_TOOLS:
            continue
        if argv[1] != "agent" or argv[2] != "prompt":
            continue
        skip = False
        for word in argv[3:]:
            if skip:
                skip = False
                continue
            if word.startswith("-"):
                skip = word in VALUE_FLAGS          # its VALUE is not the target
                continue
            return word
        return ""
    return None


def run(argv, timeout):
    """(returncode, stdout) — or (None, reason) when the command could not be run."""
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"{argv[0].rsplit('/', 1)[-1]} did not answer within {timeout}s"
    except OSError as exc:
        return None, f"could not run {argv[0]}: {exc}"
    return proc.returncode, proc.stdout


def resolve(target):
    """(pane_id, agent_status) for an agent name or pane id, or (None, reason)."""
    rc, out = run([HERDR, "agent", "list"], LIST_TIMEOUT)
    if rc is None:
        return None, out
    if rc != 0:
        return None, "herdr agent list exited %s" % rc
    try:
        agents = json.loads(out)["result"]["agents"]
    except (json.JSONDecodeError, ValueError, KeyError, TypeError):
        return None, "herdr agent list returned no readable agent list"
    for agent in agents:
        if target in (agent.get("pane_id"), agent.get("name")):
            return agent.get("pane_id"), agent.get("agent_status")
    if PANE_RE.match(target):
        return target, None                     # a pane herdr does not list; let draft judge it
    return None, f"herdr lists no agent named {target!r}"


def send_verdict(command):
    """("deny"|"warn", text) for a herdr agent prompt worth acting on, else None."""
    target = send_target(command)
    if target is None:
        return None
    if not target:
        return "warn", "a herdr agent prompt whose target this guard could not read"
    pane, status = resolve(target)
    if pane is None:
        return "warn", status
    if status == "blocked":
        return "deny", SEND_REASON.format(
            pane=pane, why=f"{pane} is BLOCKED — it is waiting on a permission prompt, so a "
                           "raw prompt lands in a box that is not accepting one")
    rc, out = run([MANAGER, "draft", pane], DRAFT_TIMEOUT)
    if rc == 0:
        return None                             # box empty, target not blocked: allow, untouched
    if rc == 1:
        return "deny", SEND_REASON.format(
            pane=pane, why=f"{pane} holds an UNSENT DRAFT — `herdr agent prompt` appends to the "
                           "box and submits both, so this call would send the user's draft for them. "
                           f"See it with: herdr_session_manage.sh draft {pane}")
    if rc == 2:
        return "warn", f"could not read {pane}'s input box (draft exited 2)"
    return "warn", f"the box check on {pane} was inconclusive ({(out or '').strip() or 'no answer'})"


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    command = payload.get("tool_input", {}).get("command", "")
    if gates(command):
        return deny(REASON)
    if MARKER in command:
        return
    verdict = send_verdict(command)
    if verdict is None:
        return
    kind, text = verdict
    if kind == "deny":
        return deny(text)
    print(json.dumps({"systemMessage":
                      f"input-box guard: allowed a raw `herdr agent prompt` unchecked — {text}. "
                      "Prefer herdr_session_manage.sh tell, which checks the box itself."}))


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


if __name__ == "__main__":
    main()
