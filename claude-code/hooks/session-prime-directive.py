#!/usr/bin/env python3
"""session-prime-directive.py — UserPromptSubmit: re-inject the session's prime directive.

Reads this session's entry in ~/.claude/state/state_claude_session_title_lineage.json
(fields prime_directive / done_when / closed, written by claude_session_prime_directive.sh
and carried to a successor by the /successor hand-over) and prints ONE line to stdout, which UserPromptSubmit injects
into the model's context every turn:

  settled  -> "PRIME DIRECTIVE: <pd> | DONE WHEN: <dw>"        (~25-40 tokens/turn, resident)
  closed   -> nothing
  unsettled, 3+ human prompts -> the settle nudge naming the exact command to run
  unsettled, under 3 prompts  -> nothing (the topic is still forming)

The prompt count is derived from the transcript itself — no counter state. Only records
that are a HUMAN prompt count: type=="user" whose message content is prose, not a
tool_result array and not a harness injection (leading "<", e.g. <task-notification>).
The scan stops at 3 hits and never reads past READ_CAP bytes; a capped read counts as
3+ (an early nudge is harmless, a hook past its 5s budget is killed and injects nothing).
Both display fields are truncated at 300 chars — display only, the state keeps the full text.

Fail-open everywhere: any error prints nothing and exits 0.
"""
import json, os, sys

READ_CAP = 8 * 1024 * 1024
NUDGE = ('PRIME DIRECTIVE UNSET: settle this session\'s two sentences with the user. Name them '
         'in these words — "prime directive" and "done_when" — never a synonym of your own. Ask as TWO '
         'questions answered separately: what is this session FOR, and what fact will be true when it '
         'is DONE. A good done_when is decided by a command, a file or a number ("the CSV imports with '
         'zero rejected rows"); the literal `never` is for a standing watcher only, not for work that '
         'merely has no date. Raise it ALONE in a turn — as the last bullet of a report it gets skipped. '
         'Do not drop it after one try. On the answer run: '
         'claude_session_prime_directive.sh set {sid} "<directive>" "<done_when>". '
         'The /prime-directive skill shows, changes or closes them.')


def human_prompts_at_least(path, want):
    n, read = 0, 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            read += len(line)
            if read > READ_CAP:
                return True                       # unknowable cheaply -> treat as enough
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if obj.get("type") != "user":
                continue
            msg = obj.get("message") or {}
            c = msg.get("content")
            if isinstance(c, str):
                ok = c.strip() and not c.lstrip().startswith("<")
            elif isinstance(c, list):
                if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c):
                    continue
                ok = any(isinstance(b, dict) and b.get("type") == "text"
                         and b.get("text", "").strip() and not b.get("text", "").lstrip().startswith("<")
                         for b in c)
            else:
                ok = False
            if ok:
                n += 1
                if n >= want:
                    return True
    return False


def main():
    payload = json.load(sys.stdin)
    sid = payload.get("session_id") or ""
    if not sid:
        return
    state = os.path.expanduser("~/.claude/state/state_claude_session_title_lineage.json")
    try:
        with open(state, encoding="utf-8") as f:
            entry = json.load(f).get(sid) or {}
    except FileNotFoundError:
        entry = {}
    if entry.get("closed"):
        return
    pd = str(entry.get("prime_directive") or "").strip()
    dw = str(entry.get("done_when") or "").strip()
    if pd and dw:
        clip = lambda s: s if len(s) <= 300 else s[:300] + "…"
        print(f"PRIME DIRECTIVE: {clip(pd)} | DONE WHEN: {clip(dw)}")
        return
    tp = payload.get("transcript_path") or ""
    if tp and os.path.exists(tp) and human_prompts_at_least(tp, 3):
        print(NUDGE.format(sid=sid))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass                                      # fail open: a broken hook must never cost the turn
    sys.exit(0)
