#!/usr/bin/env python3
# git-commit-pathspec-guard.py — PreToolUse(Bash) hook: keep commits scoped in a shared repo.
# Three footguns when several sessions work in one repo at once, all DENIED here:
#   1. A bare `git commit` (or -a/-am/no-arg) commits whatever is staged — including files
#      another concurrent session staged in the gap. Fix: require an explicit `-- <pathspec>`.
#   2. `git commit -- <path>` commits the WORKING TREE of <path>, NOT the staged index. If a
#      named path was partial-staged (staged version differs from the working tree), the commit
#      silently ignores your stage and grabs the whole working tree — how an unrelated in-flight
#      edit gets swept in. Fix: DENY a pathspec commit when a named path is both staged
#      AND unstaged (porcelain `MM`); stage it fully or don't commit a partially-staged file.
#   3. `git commit --amend` with no pathspec is footgun 1 wearing a disguise: it rewrites the last
#      commit using everything staged, so an amend meant only to reword a message swallows whatever
#      another session staged meanwhile. Fix: hold --amend to the same rule as a plain commit — but only
#      when something is actually staged, so `--amend --no-edit` on a clean index stays free.
# Allows non-committing forms, and only ever judges the EXECUTABLE position of each command —
# `git commit` inside a quoted argument or a heredoc body is text, not a commit. Fail-open
# (parse/git error -> allow) so a broken guard never bricks Bash.
import sys, json, shlex, os, re, subprocess

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
cmd = (data.get("tool_input") or {}).get("command", "") or ""

# A heredoc BODY is data, not commands. shlex knows no shell grammar, so prose like
# `… a bare git commit …` would split into bare `git` + `commit` tokens and deny a call that
# runs no git at all. Drop the bodies before tokenizing.
HEREDOC_RE = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

def unquoted_at(line, pos):
    """True if `pos` falls outside a quoted span — a `<<` inside quotes is text, not a heredoc."""
    q = None
    for ch in line[:pos]:
        if q:
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
    return q is None

def strip_heredocs(s):
    """Body dropped only when the `<<` is unquoted AND its terminator line is actually present,
    so neither an arithmetic left-shift nor a quoted `<<` can swallow the commands that follow."""
    lines, out, i = s.split("\n"), [], 0
    n = len(lines)
    while i < n:
        out.append(lines[i])
        delims = [m.group(2) for m in HEREDOC_RE.finditer(lines[i]) if unquoted_at(lines[i], m.start())]
        i += 1
        for d in delims:
            j = i
            while j < n and lines[j].strip() != d:
                j += 1
            if j < n:
                i = j + 1          # terminator found → skip the body
    return "\n".join(out)

def shell_tokens(s):
    """shlex in punctuation mode, so `;`/`&&`/`|`/`(` come back as their own tokens even when
    written tight. Plain shlex.split glues `;` onto the word before it, so the real command in
    `echo hi; git commit …` would look like an argument to `echo` and slip the guard."""
    s = strip_heredocs(s).replace("\\\n", " ")   # join line continuations
    lex = shlex.shlex(s.replace("\n", " ; "), posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    return list(lex)

try:
    tokens = shell_tokens(cmd)
except Exception:
    sys.exit(0)  # unbalanced quotes / heredoc body — never block on a parse failure

GLOBAL_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
OPERATORS = {"&&", "||", ";", "|", "|&", "&", "(", ")", "{", "}", "!"}
# Flags that mean "not a plain index commit" → leave alone.
SAFE_FLAGS = {"--dry-run", "-h", "--help", "--interactive", "--patch", "-p"}
REDIR_PREFIXES = ("<", ">")  # stop pathspec collection at a shell redirection / heredoc token

DOC = "(git-commit-pathspec-guard.py hook)"

def deny(reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
        "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    sys.exit(0)

def repo_dir(seg, tokens):
    """Repo dir from this command's own `git -C <dir>`, else a leading `cd <dir>`, else the
    hook's cwd. Shell state does not persist between tool calls, so a commit command carries
    its own `cd`/`-C` — one of these two branches almost always resolves it."""
    for i, t in enumerate(seg):
        if t == "-C" and i + 1 < len(seg):
            return os.path.expanduser(seg[i + 1])
    if tokens and tokens[0] == "cd" and len(tokens) > 1 and not tokens[1].startswith("-"):
        return os.path.expanduser(tokens[1])
    return os.getcwd()

def paths_after_ddash(args):
    """Pathspecs after `--`, stopping at any shell redirection / heredoc / operator token."""
    if "--" not in args:
        return []
    out = []
    for a in args[args.index("--") + 1:]:
        if a.startswith(REDIR_PREFIXES) or a in OPERATORS:
            break
        out.append(a)
    return out

def has_staged_and_unstaged(repo, paths):
    """True if any named path shows BOTH a staged and an unstaged change (porcelain XY both
    non-space) — the case where `git commit -- <path>` commits the working tree and silently
    ignores the distinct staged version. None on any error (fail-open)."""
    if not paths:
        return None
    try:   # core.fsmonitor off: a repo's own .git/config could otherwise name a program for git to run
        r = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", repo, "status", "--porcelain", "--"] + paths,
                           capture_output=True, text=True, timeout=3)
    except Exception:
        return None
    if r.returncode != 0:
        return None
    for line in r.stdout.splitlines():
        if len(line) < 2:
            continue
        x, y = line[0], line[1]
        if x not in (" ", "?") and y not in (" ", "?"):
            return True
    return False

def index_has_staged(repo):
    """True if anything is staged in `repo` (index differs from HEAD). None on any error (fail-open)."""
    try:
        r = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", repo, "diff", "--cached", "--quiet", "--no-ext-diff"],
                           capture_output=True, timeout=3)
    except Exception:
        return None
    return r.returncode == 1 if r.returncode in (0, 1) else None

def command_segments(tokens):
    """One list per command in a compound statement, split at the shell operators."""
    segs, cur = [], []
    for t in tokens:
        if t in OPERATORS:
            segs.append(cur); cur = []
        else:
            cur.append(t)
    segs.append(cur)
    return segs

ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Programs that run the real command that follows them, mapped to their value-taking flags
# (skipping a value blindly would eat the `git` token and let a bare commit through).
WRAPPERS = {"env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"},
            "sudo": {"-u", "-g", "-C", "-p", "-r", "-t", "-U", "-h", "-D", "-R"},
            "doas": {"-u", "-C"}, "nice": {"-n", "--adjustment"},
            "ionice": {"-c", "-n", "-p", "-P", "-u"}, "stdbuf": {"-i", "-o", "-e"},
            "nohup": set(), "command": set(), "time": set(), "builtin": set()}

def commit_args(seg):
    """Args after `commit` when this command actually EXECUTES `git … commit`, else None.
    Only the executable position counts — a quoted or heredoc mention of `git commit` in an
    argument to some other program is text, not a commit."""
    i, n = 0, len(seg)
    while i < n and (ASSIGN_RE.match(seg[i]) or os.path.basename(seg[i]) in WRAPPERS):
        if ASSIGN_RE.match(seg[i]):
            i += 1; continue
        value_flags = WRAPPERS[os.path.basename(seg[i])]
        i += 1
        while i < n and (ASSIGN_RE.match(seg[i]) or seg[i].startswith("-")):
            if seg[i] in value_flags and i + 1 < n:
                i += 1
            i += 1
    if i >= n or os.path.basename(seg[i]) != "git":
        return None
    j = i + 1
    while j < n and seg[j].startswith("-"):                 # skip git global options
        j += 2 if seg[j] in GLOBAL_OPTS_WITH_VALUE else 1
    return seg[j + 1:] if j < n and seg[j] == "commit" else None

for seg in command_segments(tokens):
    args = commit_args(seg)
    if args is None:
        continue
    if any(a in SAFE_FLAGS for a in args):
        continue                       # dry-run / help / patch → allow
    amend = "--amend" in args
    if "--" not in args:
        if amend:
            if index_has_staged(repo_dir(seg, tokens)) is not True:
                continue        # nothing staged: an amend can only rewrite the commit itself
            deny("git-commit guardrail: `git commit --amend` with no `-- <pathspec>` rewrites the "
                 "last commit using EVERYTHING currently staged — including files another session "
                 "staged in the gap. Name the paths and take only-those semantics: "
                 "`git commit --amend --only -- path/one path/two`. Check the staged set first: "
                 "`git -C <repo> diff --cached --stat`. " + DOC)
        deny("git-commit guardrail (multi-session safety): this `git commit` has no explicit "
             "`-- <pathspec>`, so it would commit EVERYTHING currently staged — including files "
             "another concurrent session may have staged in the gap. Re-run naming the files with "
             "the `--` separator, e.g. `git commit -m \"...\" -- path/one path/two`. "
             "Check the staged set first: `git -C <repo> diff --cached --stat`. "
             "PARTIALLY-staged file (one hunk staged, rest of the file still dirty)? `git commit -- "
             "<path>` commits its WORKING TREE, not your stage, and is denied too — first make the "
             "tree match what you want committed: `git add <path>`, or (to commit ONLY the staged "
             "hunk) back the file up, `git show :<path> > <path>`, commit, restore the backup. " + DOC)
    # Pathspec present, but `git commit -- <path>` commits the WORKING TREE, not the index.
    if has_staged_and_unstaged(repo_dir(seg, tokens), paths_after_ddash(args)) is True:
        deny("git-commit guardrail: `git commit -- <path>` commits the WORKING TREE of the named "
             "paths, NOT the staged index. A named path here is BOTH staged and unstaged (porcelain "
             "`MM`), so this commit would IGNORE what you staged and grab the full working tree — "
             "sweeping in the unstaged part, possibly another session's in-flight edit. Either "
             "`git add <path>` so the working tree matches what you want committed, or don't commit a "
             "file you've only partially staged (bare `git commit` commits the index, but is blocked "
             "here for the multi-session reason above — so isolate the change instead). "
             "Inspect: `git status --porcelain -- <path>`. " + DOC)

sys.exit(0)
