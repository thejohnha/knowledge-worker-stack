#!/usr/bin/env python3
# settings-silent-deny-explainer.py — PreToolUse(Bash) hook: a settings.json deny rule such as
# `Bash(rm -rf:*)` blocks a command SILENTLY — the agent sees a denial with no reason, and can spend
# a long time guessing why. This hook reads YOUR deny rules (user settings, the session's config dir,
# and the project's .claude/settings*.json), matches their prefixes FIRST, and denies with the reason
# and a sanctioned alternative, so a silent rule is never reached without an explanation.
# A prefix matches only where Claude Code matches it: at the start of the command or of a subcommand
# after `&&`, `||`, `;`, `|` or a newline. A mention inside an argument, a quoted string or a heredoc
# body is text, so this hook never denies a command Claude Code itself would allow.
# The deny rules stay in settings.json as the backstop. Fail-open: any error allows.
import json, os, re, shlex, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "") or ""
if not cmd:
    sys.exit(0)

# The better path for the common rules; any other rule gets the generic advice.
ADVICE = {
    "rm -rf": "Use `rm -r` (directories), `rm -f` (files) or `shutil.rmtree` in python — and `trash` "
              "for the user's own files on macOS.",
    "git push --force": "A force-push can erase someone else's work: rebase instead, or hand the "
              "decision to the user.",
    "git reset --hard": "Use `git restore <path>` for single files, or hand the decision to the user — "
              "a hard reset can erase uncommitted work.",
}

HEREDOC_RE = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
SEPARATORS = {"&&", "||", ";", "|", "|&", "&", ";;"}


def unquoted_at(line, pos):
    q = None
    for ch in line[:pos]:
        if q:
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
    return q is None


def strip_heredocs(s):
    """A heredoc BODY is data, not commands: drop it when its terminator line is present."""
    lines, out, i = s.split("\n"), [], 0
    while i < len(lines):
        out.append(lines[i])
        delims = [m.group(2) for m in HEREDOC_RE.finditer(lines[i]) if unquoted_at(lines[i], m.start())]
        i += 1
        for d in delims:
            j = i
            while j < len(lines) and lines[j].strip() != d:
                j += 1
            if j < len(lines):
                i = j + 1
    return "\n".join(out)


def subcommands(s):
    """Each subcommand as its words joined by single spaces, split at the shell's separators.
    Quotes are respected, so a separator inside a quoted argument does not start a subcommand."""
    s = strip_heredocs(s).replace("\\\n", " ")
    lex = shlex.shlex(s.replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    segs, cur = [], []
    for t in lex:
        if t in SEPARATORS:
            segs.append(cur); cur = []
        else:
            cur.append(t)
    segs.append(cur)
    return [" ".join(x) for x in segs if x]


def settings_files():
    home = os.path.expanduser("~")
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
    cwd = data.get("cwd") or os.getcwd()
    seen, out = set(), []
    for p in (os.path.join(home, ".claude", "settings.json"), os.path.join(cfg, "settings.json"),
              os.path.join(cwd, ".claude", "settings.json"), os.path.join(cwd, ".claude", "settings.local.json")):
        r = os.path.realpath(p)
        if r not in seen and os.path.isfile(r):
            seen.add(r)
            out.append(p)
    return out


def deny_prefixes():
    """The prefix of every Bash deny rule written as `Bash(<prefix>:*)` or `Bash(<prefix> *)`."""
    out = []
    for p in settings_files():
        try:
            with open(p, encoding="utf-8") as f:
                rules = ((json.load(f).get("permissions") or {}).get("deny") or [])
        except Exception:
            continue
        for r in rules:
            m = re.fullmatch(r"Bash\((.+?)(?::\*| \*)\)", r.strip()) if isinstance(r, str) else None
            if m and m.group(1).strip() and (m.group(1).strip(), r, p) not in out:
                out.append((m.group(1).strip(), r, p))
    return out


try:
    rules = deny_prefixes()
    if not rules:
        sys.exit(0)
    subs = subcommands(cmd)
    for prefix, rule, path in rules:
        # whole words only (`curl` matches `curl -s x`, never `curlie`): where it is unclear whether
        # Claude Code would block, this hook stays out and the rule itself decides
        if any(sc == prefix or sc.startswith(prefix + " ") for sc in subs):
            advice = ADVICE.get(prefix, "Find another way to do it, or ask the user to run it themselves.")
            print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                "permissionDecision": "deny", "permissionDecisionReason":
                f"silent-deny explainer — this command runs `{prefix}`, which the deny rule "
                f"`{rule}` in {path.replace(os.path.expanduser('~'), '~')} blocks without a reason. {advice}"}}))
            sys.exit(0)
except SystemExit:
    raise
except Exception:
    pass
sys.exit(0)
