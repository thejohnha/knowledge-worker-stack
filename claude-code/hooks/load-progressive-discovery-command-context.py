#!/usr/bin/env python3
"""PreToolUse(Bash) hook: put a document's own guidance in front of a command that needs it.

WHY THIS EXISTS
CLAUDE.md is loaded into every session before you type a word, so rules for a tool most
sessions never touch cost tokens and attention every time. This hook keeps such rules out
of CLAUDE.md and delivers them the first time a session actually runs the tool. The
trigger is the COMMAND TEXT, because this work often never touches a file path (its sibling
load-context-md-chain.py covers files).

THE SHAPE
A document declares which commands it governs, in the document itself. Nothing central lists
them, so adding a tool is one block in a Markdown file and this script never changes:

    <!-- claude-command-context: mode=guard; match=(^|[;&|(]\s*)mytool(\s|$) -->
    ... the guidance, verbatim ...
    <!-- end claude-command-context -->

  match   a Python regex tried against the whole Bash command string. MUST be the last field.
  mode    guard  the first matching command of the session is DENIED, with the guidance as
                 the reason, and the model re-issues it. Nothing runs unguided. Use it where
                 being one mistake late is unacceptable — anything outward-facing.
          notify the command runs and the guidance is injected alongside the result. Free,
                 but always one call late. Use it for reference that merely informs.

Both modes deliver ONCE per session and per agent, keyed by the block. A subagent has its
own context window and so gets its own claim.

WHERE IT LOOKS
Every *.md file, recursively, under ~/.claude/command-context/, plus any folders listed in
the environment variable CLAUDE_COMMAND_CONTEXT_DIRS (colon-separated), e.g. a docs repo.
A declaration inside a ``` fence is ignored, so documentation can show the syntax safely.

WHY guard IS A DENIAL AND NOT A WARNING
A PreToolUse hook's additionalContext IS delivered, but the model reads it AFTER the tool
result. The only way to speak before the command runs is to stop it. The refusal text says
plainly that re-running the identical command will now succeed.

THE INDEX
The folders are walked and stat-ed on every Bash call; only files whose mtime or size moved
are re-read, so a doc edit takes effect on the very next command. The index is machine-local
cache in ~/.claude/state/.

FAIL-OPEN. Any error at all exits 0 and allows the call.
"""
import sys, os, json, re, time, fcntl

HOME = os.path.expanduser("~")
STATE_DIR = os.path.join(HOME, ".claude", "state")
DELIVERED = os.path.join(STATE_DIR, "state_claude_cache_which_progressive_discovery_tool_rules_loaded.json")
INDEX = os.path.join(STATE_DIR, "state_claude_cache_command_context_markdown_index.json")
LOCK = os.path.join(STATE_DIR, "state_claude_cache_which_progressive_discovery_tool_rules_loaded.json.lock")

ROOTS = [os.path.join(HOME, ".claude", "command-context")] + [
    os.path.expanduser(d) for d in os.environ.get("CLAUDE_COMMAND_CONTEXT_DIRS", "").split(":") if d]
SKIP_DIRS = {".git", "node_modules", "__pycache__"}

OPEN_RE = re.compile(r"<!--\s*claude-command-context:\s*(.*?)\s*-->")
CLOSE_RE = re.compile(r"<!--\s*end\s+claude-command-context\s*-->")

MAX_BLOCK_CHARS = 12000         # per block: refuse and say so, rather than flooding the turn
# One line at the top of each state file so a person opening it knows what it is,
# re-seeded on every write so it survives a corrupt-file reset. Session titles are
# deliberately NOT copied in: a title can be changed later and a stale copy here would
# contradict the file that owns it, so the header carries the lookup instead.
README = ("Which tool rules each Claude Code session has already had loaded into it, so no session is given the same ones twice. Written by load-progressive-discovery-command-context.py. Each value names the document and the line where those rules start. Keys are Claude Code session ids. Rows older than 30 days are dropped automatically. Safe to delete -- it rebuilds itself.")
# The index carries the same header for the same reason. It is NOT written indented: it is
# read on every command and indenting it roughly triples a file nobody edits by hand.
INDEX_README = ("The size and last-changed time of every Markdown file in the command-context folders, so the hook re-reads only files that changed instead of all of them on every shell command. Written by load-progressive-discovery-command-context.py. Keys under `files` are absolute paths; `blocks` holds any tool rules declared in that file. `parser` is this script's own mtime and size -- when the script itself changes, every entry is rebuilt, because a cached value here is a parse result rather than raw text. Safe to delete -- it rebuilds itself.")

PRUNE_AGE = 30 * 86400          # matches the CONTEXT.md chain: sessions can live for weeks


def parse_declaration(raw):
    """'mode=guard; match=(^|[;&|]\\s*)mytool' -> {'mode': ..., 'match': ...}.

    `match` MUST come last and runs to the end of the declaration, because a regex is full
    of the characters a field separator would use (a split on ';' would shred `[;&|]`).
    Everything before `match=` is ordinary `key=value; key=value`."""
    out = {}
    head, sep, tail = raw.partition("match=")
    if sep:
        out["match"] = tail.strip()
    for part in head.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def blocks_in(path, text):
    """Every declared block in one file, as dicts. A block with no usable regex is dropped.

    Declarations inside a fenced code block are IGNORED. Documentation has to be able to show
    this syntax without arming it."""
    found, lines = [], text.splitlines()
    i, fenced = 0, False
    while i < len(lines):
        if lines[i].lstrip().startswith("```"):
            fenced = not fenced
            i += 1
            continue
        m = None if fenced else OPEN_RE.search(lines[i])
        if not m:
            i += 1
            continue
        decl = parse_declaration(m.group(1))
        body, j = [], i + 1
        while j < len(lines):
            if lines[j].lstrip().startswith("```"):
                fenced = not fenced          # a body may legitimately contain fenced examples
            elif not fenced and CLOSE_RE.search(lines[j]):
                break
            body.append(lines[j])
            j += 1
        i = j + 1
        pattern = decl.get("match", "")
        entry = {"path": path, "line": i, "body": "\n".join(body).strip(),
                 "mode": "guard" if decl.get("mode") == "guard" else "notify"}
        # A declaration that cannot work is REPORTED, never silently dropped. A block that
        # vanishes looks exactly like a block that was never written, and the operator finds
        # out when the guidance fails to arrive — which is the moment it mattered.
        if not pattern:
            entry.update(match=r"(?!)", broken="no match= field, so it can never fire")
        else:
            try:
                re.compile(pattern)
            except re.error as e:
                entry.update(match=r"(?!)", broken="match= does not compile (%s)" % e)
            else:
                entry["match"] = pattern
        found.append(entry)
    return found


def defects(blocks):
    """Declarations that are present but cannot fire. Reported once per session, not per call."""
    return [b for b in blocks if b.get("broken")]


def build_index():
    """Return [block, ...] across every root, re-reading only files that changed.

    The cache maps path -> {mtime, size, blocks}. Stat is cheap and content is not, so the
    walk is unconditional and the read is conditional."""
    # The cache is keyed on each document's mtime AND on this script's own, because the cached
    # value is a PARSE RESULT: change the parser and every entry is stale while every mtime
    # still matches. Rebuild everything when the script itself moves.
    try:
        st = os.stat(os.path.abspath(__file__))
        parser_sig = [st.st_mtime, st.st_size]
    except OSError:
        parser_sig = None
    try:
        with open(INDEX) as f:
            stored = json.load(f)
        cache = stored.get("files") or {} if stored.get("parser") == parser_sig else {}
    except Exception:
        cache = {}

    fresh, out = {}, []
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if not name.endswith(".md"):
                    continue
                p = os.path.join(dirpath, name)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                prev = cache.get(p)
                if prev and prev.get("mtime") == st.st_mtime and prev.get("size") == st.st_size:
                    fresh[p] = prev
                else:
                    try:
                        with open(p, encoding="utf-8", errors="replace") as f:
                            text = f.read()
                    except Exception:
                        continue
                    # Skip the overwhelming majority without paying for a line walk.
                    blocks = blocks_in(p, text) if "claude-command-context" in text else []
                    fresh[p] = {"mtime": st.st_mtime, "size": st.st_size, "blocks": blocks}
                out.extend(fresh[p]["blocks"])

    if fresh != cache:
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            tmp = INDEX + ".tmp.%d" % os.getpid()
            with open(tmp, "w") as f:
                json.dump({"_readme": INDEX_README, "parser": parser_sig, "files": fresh}, f)
            os.replace(tmp, INDEX)
        except Exception:
            pass                            # an unwritable cache costs speed, never correctness
    return out


def claim(session_id, agent, key):
    """Record key as delivered for this session+agent. True if WE claimed it first.

    Check and mark happen INSIDE the lock, so two commands racing in one turn deliver once."""
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(LOCK, "a+") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            try:
                try:
                    with open(DELIVERED) as f:
                        state = json.load(f)
                except Exception:
                    state = {}
                now = time.time()
                entry = state.get(session_id)
                if not isinstance(entry, dict):
                    entry = {"ts": now, "loaded": {}}
                seen = entry.setdefault("loaded", {}).setdefault(agent, [])
                if key in seen:
                    return False
                seen.append(key)
                entry["ts"] = now
                entry["loaded_at"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
                state[session_id] = entry
                state["_readme"] = README

                for k in [k for k, v in state.items()
                          if isinstance(v, dict) and now - v.get("ts", now) > PRUNE_AGE]:
                    del state[k]

                tmp = DELIVERED + ".tmp.%d" % os.getpid()
                with open(tmp, "w") as f:
                    json.dump(state, f, indent=2, ensure_ascii=False)
                    f.write("\n")
                os.replace(tmp, DELIVERED)
                return True
            finally:
                fcntl.flock(lk, fcntl.LOCK_UN)
    except Exception:
        return False                        # cannot claim -> stay silent, never block


def main():
    data = json.load(sys.stdin)
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if not cmd:
        return

    session_id = data.get("session_id") or "unknown-session"
    agent = data.get("agent_id") or "main"

    index = build_index()

    guard, notes = None, []
    for b in defects(index):
        if claim(session_id, agent, "defect:%s:%d" % (b["path"], b["line"])):
            notes.append("[DEFECT — NOT DELIVERED. The declaration at %s line %d is broken: "
                         "%s. Its guidance is NOT in your context. TELL THE OPERATOR in this "
                         "turn, naming the file and the line — this is a defect a person has "
                         "to fix, not a condition to work around.]"
                         % (b["path"], b["line"], b["broken"]))

    for b in index:
        if b.get("broken") or not re.search(b["match"], cmd):
            continue
        key = "%s:%d" % (b["path"], b["line"])
        if not claim(session_id, agent, key):
            continue
        body = b["body"]
        if len(body) > MAX_BLOCK_CHARS:
            body = ("[NOT DELIVERED — the declared block in %s is %d characters, past the "
                    "%d-character ceiling. Read that file directly before continuing, and "
                    "tell the operator the block needs splitting.]"
                    % (b["path"], len(body), MAX_BLOCK_CHARS))
        piece = "----- %s -----\n\n%s" % (b["path"], body)
        if b["mode"] == "guard" and guard is None:
            guard = piece
        else:
            notes.append(piece)

    if guard:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason":
                "STOP AND READ THIS, THEN RE-RUN THE IDENTICAL COMMAND — it will not be "
                "blocked again this session. This command touches a tool whose rules are not "
                "in your startup context, and they had to reach you before it ran rather "
                "than after.\n\n" + "\n\n".join([guard] + notes)}}))
        return

    if notes:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext":
                "Local context for the command just run. These documents govern that tool "
                "and are delivered once per session, because they are no longer carried in "
                "your startup context.\n\n" + "\n\n".join(notes)}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass                                # fail-open: never let this hook stop a command
    sys.exit(0)
