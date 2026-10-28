#!/usr/bin/env python3
# load-context-md-chain.py — CONTEXT.md injector: PostToolUse(Read), PreToolUse(Write|Edit|MultiEdit).
#
# WHAT IT DOES. When Claude touches a file, this walks UP from that file's directory
# collecting EVERY CONTEXT.md above it, and hands the whole chain to the model — each
# file once per session, ordered broadest first. Without it, local conventions reach the
# model only if it remembers to look; with it, touching a file in a folder simply puts
# that folder's CONTEXT.md, and every one above it, in front of the model.
#
# WHY THE WHOLE CHAIN, NOT JUST THE NEAREST. The chain is what lets each file stay
# narrow: the root explains the repository once, an area file explains its corner, the
# leaf explains one folder, and none repeats another. Broadest first, because the nearest
# file is the most specific: where two disagree, the last one read should win.
#
# HOW THE INJECTION WORKS. A hook's stdout JSON `hookSpecificOutput.additionalContext`
# enters the model's context, on PreToolUse and PostToolUse alike.
#
# WHY READS AND WRITES ARE TIMED DIFFERENTLY. A READ is PostToolUse: arriving one call late
# costs nothing. A WRITE is PreToolUse in guard shape — the first write into a folder is
# DENIED once, with the chain as the refusal reason, and the model re-issues the identical
# call. A PreToolUse `additionalContext` is read by the model AFTER the tool result, so the
# only way to speak before a write runs is to stop it. Every file is CLAIMED before the
# denial is emitted, so the retry finds nothing left to deliver and proceeds — the deny
# fires at most once per file per session, and cannot loop.
#
# FAIL OPEN, ON PURPOSE. Every error path exits 0 silently. The worst outcome of a failure
# is that the model misses context it could have read by hand; failing closed would block
# file operations.
#
# SIZE. The hook delivers; it does not judge. The one limit, RUNAWAY_CHARS per FILE, is a
# refusal, not a ration: a file arrives complete or not at all, because a truncated or
# dropped rule silently stops applying. It exists for a CONTEXT.md that is really a symlink
# to a log or a generated file; a refused file is NAMED so a person fixes it.
#
# WHERE IT LOOKS: only under $HOME, and the walk stops after checking $HOME. A folder outside
# $HOME is searched only if it is under a root listed in TRUSTED_ROOTS (one absolute path per
# line, `#` comments), and the walk then stops at that root. A CONTEXT.md not owned by you is
# skipped: the notes arrive as instructions, so a file someone else could write is not loaded.
# Depth is capped at 25 levels.
#
# STATE: ~/.claude/state/state_claude_cache_which_context_md_files_loaded.json, keyed by
# session id, then per agent, because a subagent has its own context window:
#   {"<session-id>": {"ts": <epoch>, "loaded": {"main": ["/abs/CONTEXT.md"], ...}}}
# Read-modify-write happens under an flock, so twenty reads in one folder inject exactly
# once. Entries untouched for 30 days are pruned. Safe to delete; it rebuilds itself.
import sys, os, json, time, fcntl

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".claude", "state", "state_claude_cache_which_context_md_files_loaded.json")
LOCK = STATE + ".lock"
RUNAWAY_CHARS = 200000          # per FILE: refuse and name it. The only limit here.
PRUNE_AGE = 30 * 86400          # sessions can live for weeks; a shorter window re-injects
MAX_DEPTH = 25
NAME = "CONTEXT.md"
TRUSTED_ROOTS = os.path.join(HOME, ".config", "knowledge-worker-stack", "context-md-trusted-roots.txt")

# One line at the top of the state file so a person opening it knows what it is,
# re-seeded on every write so it survives a corrupt-file reset. Session titles are
# deliberately NOT copied in: a title can be changed later and a stale copy here would
# contradict the file that owns it, so the header carries the lookup instead.
README = ("Which CONTEXT.md files each Claude Code session has already had loaded into it, so no session is given the same one twice. Written by load-context-md-chain.py. Keys are Claude Code session ids. Rows older than 30 days are dropped automatically. Safe to delete -- it rebuilds itself.")


def roots():
    """$HOME, then every root in TRUSTED_ROOTS; each as written and with its symlinks resolved."""
    out = [HOME]
    try:
        with open(TRUSTED_ROOTS, encoding="utf-8") as f:
            out += [os.path.expanduser(l.strip()) for l in f if l.strip() and not l.lstrip().startswith("#")]
    except OSError:
        pass
    return [r for root in out if os.path.isabs(root)
            for r in (os.path.normpath(root), os.path.realpath(root))]


def under(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def find_context_md_chain(start_dir):
    """Every CONTEXT.md at or above start_dir, up to and including its root, ordered broadest first.

    The walk COLLECTS rather than stopping at the first hit, so a file three
    levels down arrives with its area file and its repository's root map, not
    only the folder it happens to sit in. That is what lets each file stay
    narrow: the root explains the repository once, the leaf explains the
    folder, and neither has to repeat the other.

    Broadest first because the nearest file is the most specific one. Where two
    disagree, the last one read is the one that should win.
    """
    d, top = None, None
    for cand in (start_dir, os.path.realpath(start_dir)):
        top = next((r for r in roots() if under(cand, r)), None)
        if top:
            d = cand
            break
    if not top:
        return []                                  # outside $HOME and every trusted root
    found, uid = [], os.getuid()
    for _ in range(MAX_DEPTH):
        cand = os.path.join(d, NAME)
        try:
            if os.path.isfile(cand) and os.stat(cand).st_uid == uid:
                found.append(cand)
        except OSError:
            pass
        if d == top or d == os.path.dirname(d):    # the root, or the filesystem root
            break
        d = os.path.dirname(d)
    found.reverse()
    return found


def claim(session_id, agent, path):
    """Record path as delivered for this session+agent. True if WE claimed it (first)."""
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(LOCK, "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            try:
                with open(STATE) as f:
                    state = json.load(f)
                if not isinstance(state, dict):
                    state = {}
            except Exception:
                state = {}                      # missing or corrupt -> start clean

            now = time.time()
            entry = state.get(session_id)
            if not isinstance(entry, dict):
                entry = {"ts": now, "loaded": {}}
            delivered = entry.get("loaded")
            if not isinstance(delivered, dict):
                delivered = {}
            seen = delivered.get(agent)
            if not isinstance(seen, list):
                seen = []
            if path in seen:
                return False

            seen.append(path)
            delivered[agent] = seen
            entry["loaded"], entry["ts"] = delivered, now
            entry["loaded_at"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
            state[session_id] = entry
            state["_readme"] = README
            for k in [k for k, v in state.items()
                      if isinstance(v, dict) and now - v.get("ts", now) > PRUNE_AGE]:
                del state[k]

            tmp = STATE + ".tmp.%d" % os.getpid()
            with open(tmp, "w") as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.replace(tmp, STATE)
            return True
        finally:
            fcntl.flock(lk, fcntl.LOCK_UN)


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name") or "PostToolUse"
    fp = (data.get("tool_input") or {}).get("file_path") or ""
    if not fp:
        return
    fp = os.path.abspath(os.path.expanduser(fp))
    chain = find_context_md_chain(os.path.dirname(fp))
    if not chain:
        return

    session_id = data.get("session_id") or "unknown-session"
    agent = data.get("agent_id") or "main"

    # Each file in the chain is claimed independently, so a session that already holds
    # the root map and then walks into a new folder is given the leaf alone. A file the
    # model just read itself is claimed but never echoed back.
    blocks, refused = [], []
    for ctx in chain:
        if not claim(session_id, agent, ctx):
            continue
        if fp == ctx:
            continue
        try:
            with open(ctx, encoding="utf-8", errors="replace") as f:
                body = f.read(RUNAWAY_CHARS + 1)
        except Exception:
            continue                            # unreadable -> skip it, allow the call
        if len(body) > RUNAWAY_CHARS:           # not a CONTEXT.md any more — see the header
            refused.append("%s (%d characters)" % (ctx, os.path.getsize(ctx)))
            continue
        blocks.append("----- %s -----\n\n%s" % (ctx, body))

    if refused:
        blocks.append(
            "[DEFECT — NOT DELIVERED. These files govern the folder just accessed but were "
            "refused for being past the %d-character ceiling, which means they are "
            "generated, mistaken, or symlinked to something they should not be, rather "
            "than local context: %s.\n"
            "TELL THE OPERATOR, in this turn, naming the file and its size — this is a "
            "defect a person has to fix, not a condition to work around. Their guidance is "
            "NOT in your context: read the file directly if the work touches what it "
            "governs, and do not assume you know what it says.]"
            % (RUNAWAY_CHARS, "; ".join(refused)))
    if not blocks:
        return

    header = ("Local context for the file just accessed (%s). These are the CONTEXT.md "
              "files governing that folder and the directories above it, injected "
              "automatically once per session each, ordered broadest first — where two "
              "disagree the LAST one wins, and all of them beat general guidance for "
              "work there.\n\n" % fp)

    if event == "PreToolUse":
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason":
                "STOP AND READ THIS, THEN RE-ISSUE THE IDENTICAL CALL — it will not be "
                "blocked again this session. You are about to WRITE into a folder whose "
                "local conventions were not in your context, and they had to reach you "
                "before the write rather than after.\n\n" + header
                + "\n\n".join(blocks)}}))
        return

    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PostToolUse",
        "additionalContext": header + "\n\n".join(blocks)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass                                    # fail open, always — see header
    sys.exit(0)
