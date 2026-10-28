#!/usr/bin/env python3
# Claude Code status line. Claude Code feeds the session state as JSON on stdin; this prints two lines.
#
#   line 1:  mymac | Sonnet 5.5 high | B Cx:56k | 📁 ~/project | 🌿 main +1 ~2 ↑3
#            host | model + effort (+ token-age warning) | account letter + context in the window (colored) | cwd + git branch/staged/modified/ahead/behind
#   line 2:  ●●●○○ 2.4h | ●●○○○ 50% 3.5d ▲1.6× | 5MB abcd1234 | +12/-3 lines | $14⏱️2.1h
#            5-hour usage | weekly usage (+ pace when over par) | transcript size + session id | changed lines | cost + duration
#
# Every section earns its width: values that only sometimes matter (the 5h %, the pace token, the account
# letter) appear only when they carry information, so a healthy session renders the shortest line. Line 2 is
# ordered so the droppable parts (cost, duration) roll off the right edge first on a narrow terminal.
import json, sys, subprocess, os, tempfile, time, hashlib, socket

# A repo's own .git/config can name a program for git to run (core.fsmonitor); a downloaded repo is not trusted to.
GIT = ['git', '-c', 'core.fsmonitor=false']

# Colors
GREEN, YELLOW, RED, DIM, RESET = '\033[32m', '\033[33m', '\033[31m', '\033[2m', '\033[0m'
BLUE = '\033[38;2;137;180;250m'   # Catppuccin Blue — session size
# Catppuccin Mocha (current/5h bar)
CURRENT_OK   = '\033[38;2;166;227;161m'
CURRENT_WARN = '\033[38;2;249;226;175m'
CURRENT_CRIT = '\033[38;2;243;139;168m'
# Weekly bar: own OK hue (Rosé Pine foam, bluish — tells the bars apart) but the SAME warn/crit
# as the 5h bar, so yellow/red carry one meaning everywhere (incl. the pace accents).
WEEKLY_OK    = '\033[38;2;156;207;216m'
WEEKLY_WARN  = CURRENT_WARN
WEEKLY_CRIT  = CURRENT_CRIT

HOME = os.environ.get('HOME', '')
TMPDIR = tempfile.gettempdir()
CFG_DIR = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(HOME, '.claude')

def safe_read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None

def safe_write_json(path, obj):
    # Unique tmp per writer. Several sessions render at once and share these caches, and one fixed
    # ".tmp" lets two writers interleave into the SAME file before either renames it (the rename itself is atomic).
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, 'w') as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass

def account_name():
    # Which account this session bills, from ~/.config/knowledge-worker-stack/accounts.json
    # ({"default": "~/.claude", "<name>": "<CLAUDE_CONFIG_DIR path>"}). The session's config dir picks the row;
    # no file, or no matching row, means "default".
    d = safe_read_json(os.path.join(HOME, '.config', 'knowledge-worker-stack', 'accounts.json'))
    if not isinstance(d, dict):
        return 'default'
    mine = os.path.realpath(CFG_DIR)
    for name, path in d.items():
        if isinstance(path, str) and os.path.realpath(os.path.expanduser(path)) == mine:
            return name
    return 'default'

def fmt_tokens(n):
    # Compact context sizes: 9.5k / 110k / 1.2M — precision fades as the number grows, and a bare
    # .0 is dropped so round window sizes read as advertised (1M, not 1.0M).
    if n >= 1_000_000: t = f"{n/1e6:.1f}M"
    elif n >= 10_000:  t = f"{n/1e3:.0f}k"
    elif n >= 1_000:   t = f"{n/1e3:.1f}k"
    else:              return str(n)
    return t.replace('.0M', 'M').replace('.0k', 'k')

def color_by_remaining(pct, weekly=False):
    # Shared severity scale for anything that drains toward zero (usage bars, context %):
    # OK above 30% remaining, WARN below 30%, CRIT below 10%. The 30% line also doubles as
    # the threshold where the 5h bar starts printing its exact % (see _bar_window).
    if weekly:
        if pct < 10: return WEEKLY_CRIT
        if pct < 30: return WEEKLY_WARN
        return WEEKLY_OK
    if pct < 10: return CURRENT_CRIT
    if pct < 30: return CURRENT_WARN
    return CURRENT_OK

def circle_bar(utilization, n=5, weekly=False):
    # Render a usage window as filled/hollow circles. The bubbles show what REMAINS (not what was
    # used): 5 bubbles at 20% each, colored by the severity scale above. Returns (bar, remaining%).
    pct_used = int(utilization or 0)
    remaining = 100 - pct_used
    filled = remaining * n // 100
    color = color_by_remaining(remaining, weekly)
    if filled == 0:
        # An empty bar carries no information beyond "empty", and with zero filled bubbles there
        # would be no bright glyph left to carry the warning color. Collapse to ONE full-brightness
        # hollow circle: narrower, and the red/yellow pops.
        return f"{color}○{RESET}", remaining
    return f"{color}{'●' * filled}{DIM}{'○' * (n - filled)}{RESET}", remaining

def _fmt_reset_secs(secs):
    try:
        secs = int(secs)
    except Exception:
        return "?"
    if secs < 0: return "?"
    if secs >= 86400: return f"{secs / 86400:.1f}d".replace(".0d", "d")   # 0.1-day granularity; whole days drop the .0
    if secs >= 3600: return f"{secs / 3600:.1f}h".replace(".0h", "h")   # 0.1-hour granularity; whole hours drop the .0
    return f"{secs // 60}m"

def reset_from_epoch(epoch):   # payload rate_limits.resets_at = Unix epoch seconds
    try: return _fmt_reset_secs(int(epoch) - time.time())
    except Exception: return "?"

try:
    # Parse input
    data = json.load(sys.stdin)
    model = (data.get('model') or {}).get('display_name', '?').replace(' context', '')
    effort = (data.get('effort') or {}).get('level') \
          or (safe_read_json(os.path.join(CFG_DIR, 'settings.json')) or {}).get('effortLevel')
    cwd_path = (data.get('workspace') or {}).get('current_dir', '')
    directory = '~' + cwd_path[len(HOME):] if HOME and cwd_path.startswith(HOME) else cwd_path
    cost = data.get('cost') or {}
    session_cost = cost.get('total_cost_usd', 0) or 0
    duration_ms = cost.get('total_duration_ms', 0) or 0
    lines_added = cost.get('total_lines_added', 0) or 0
    lines_removed = cost.get('total_lines_removed', 0) or 0
    # Session duration: minutes under 1h, tenths of hours to 10h, whole hours beyond — precision
    # fades as the number grows and exactness stops mattering.
    total_min = duration_ms // 60000
    if total_min < 60:
        time_str = f"{total_min}m"
    elif total_min < 600:
        time_str = f"{total_min/60:.1f}h"
    else:
        time_str = f"{total_min//60}h"

    # Session size (on-disk .jsonl) — Catppuccin blue, line 2, clustered with the session id
    size_disp = ""
    try:
        tp = data.get('transcript_path', '')
        if tp:
            sz = os.path.getsize(tp)
            num = f"{sz/1048576:.0f}MB" if sz >= 1048576 else f"{sz/1048576:.1f}MB".lstrip("0")
            size_disp = f"{BLUE}{num}{RESET}"
    except Exception:
        pass

    # Git info (cached 5s per directory)
    branch = ""
    git_dirty = ""
    git_sync = ""
    try:
        cache_key = hashlib.md5(cwd_path.encode()).hexdigest()[:12]
        git_cache = os.path.join(TMPDIR, f"statusline-git-{cache_key}")
        git_cached = None
        try:
            if time.time() - os.path.getmtime(git_cache) < 5:
                git_cached = safe_read_json(git_cache)
        except OSError:
            pass

        if git_cached is None:
            git_cached = {}
            # The branch lookup lives inside the 5s cache with the counts it labels, so a non-repo cwd
            # does not pay for a git call on every render.
            try:
                git_cached['branch'] = subprocess.check_output(GIT + ['branch', '--show-current'],
                                                               cwd=cwd_path, text=True,
                                                               stderr=subprocess.DEVNULL, timeout=3).strip()
            except Exception:
                git_cached['branch'] = ''
            if git_cached['branch']:
                try:
                    lines = subprocess.check_output(GIT + ['status', '--porcelain'],
                                                    cwd=cwd_path, text=True, stderr=subprocess.DEVNULL, timeout=3).splitlines()
                    git_cached['staged'] = sum(1 for l in lines if l and l[0] not in (' ', '?'))
                    git_cached['modified'] = sum(1 for l in lines if len(l) > 1 and l[1] not in (' ', '?'))
                except Exception:
                    pass
                try:
                    counts = subprocess.check_output(
                        GIT + ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
                        cwd=cwd_path, text=True, stderr=subprocess.DEVNULL, timeout=3).strip()
                    ahead, behind = counts.split()
                    git_cached['ahead'] = int(ahead)
                    git_cached['behind'] = int(behind)
                except Exception:
                    pass
            safe_write_json(git_cache, git_cached)

        b = git_cached.get('branch', '')
        if b:
            branch = f" | 🌿 {b}"
            parts = []
            if git_cached.get('staged'):   parts.append(f"{GREEN}+{git_cached['staged']}{RESET}")
            if git_cached.get('modified'): parts.append(f"{YELLOW}~{git_cached['modified']}{RESET}")
            if parts: git_dirty = " " + " ".join(parts)

            sync_parts = []
            if git_cached.get('ahead'):  sync_parts.append(f"↑{git_cached['ahead']}")
            if git_cached.get('behind'): sync_parts.append(f"↓{git_cached['behind']}")
            if sync_parts: git_sync = " " + " ".join(sync_parts)
    except Exception:
        pass

    # Context window — omit display if payload missing fields (don't fabricate)
    ctx = data.get('context_window') or {}
    ctx_size = ctx.get('context_window_size')
    remain_pct = ctx.get('remaining_percentage')
    ctx_valid = isinstance(ctx_size, int) and isinstance(remain_pct, (int, float))
    # The tokens RESIDENT in the window right now, not what the session has spent (cumulative billed
    # tokens run far higher, since every call re-reads the cached prefix; that is line 2's job, as cost).
    # Summed from current_usage the same way the client derives the % it reports:
    # (input + cache_creation + cache_read) / window. Output tokens are deliberately not counted.
    _cu = ctx.get('current_usage') or {}
    ctx_used = sum(_cu.get(k, 0) or 0 for k in
                   ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')) if _cu \
               else ctx.get('total_input_tokens')
    ctx_used = min(ctx_used, ctx_size) if ctx_valid and isinstance(ctx_used, int) else None
    # Context color: thresholds in ABSOLUTE tokens (green <150k, yellow 150k+, red 200k+ — past ~150k a
    # model's attention to early context degrades), combined with the shared %-remaining scale as a floor;
    # the more severe tier wins. Without the floor a small window would fill to the brim still green
    # because 150k never arrives; without the absolute scale a 1M window would sit green until 700k.
    if ctx_valid:
        _sev = 2 if remain_pct < 10 else 1 if remain_pct < 30 else 0
        if isinstance(ctx_used, int):
            _sev = max(_sev, 2 if ctx_used >= 200_000 else 1 if ctx_used >= 150_000 else 0)
        ctx_color = (CURRENT_OK, CURRENT_WARN, CURRENT_CRIT)[_sev]
    else:
        ctx_color = ""

    # Usage bars: fed by Claude Code's own rate_limits (in the payload, matches /usage and the website —
    # no token, no network). The client emits the field only on subscriber accounts, after the session's
    # first API response, so the first render(s) of a fresh session show "usage: —" for a few seconds.
    def _bar_window(used, reset_str, weekly=False, remain_secs=None):
        # The two bars deliberately answer DIFFERENT questions:
        #   5h bar     -> "how much is left?"          (remaining-based color only)
        #   weekly bar -> "is this rate sustainable?"  (adds a burn-rate-vs-par indicator)
        # Pace is intentionally NOT computed for the 5h window: that window is bursty by design —
        # burning it hard in one focused sitting is correct use, so the warning would fire constantly.
        bar, rem = circle_bar(used, weekly=weekly)
        if not weekly:
            # The exact % appears only once it's actionable (<30% remaining, where the bubble
            # colors already turn WARN/CRIT); a healthy bar is just bubbles + reset time.
            pct = f" {rem}%" if rem < 30 else ""
            return f"{bar}{pct} {reset_str}"
        # Weekly pace: par means used% == elapsed% of the 7-day window (e.g. 50% used at day 3.5).
        # ratio > 1 means burning faster than the week can sustain — at 1.6x you run dry around
        # day 4.4 and sit empty until the reset. Bubbles keep their remaining-based color; the pace
        # verdict shows as the % digits recolored plus a ▲N.N× token, and ONLY when over par —
        # an on-pace week renders completely plain, so silence means "fine".
        pct_str, pace = f"{rem}%", ""
        if remain_secs is not None:
            elapsed = 1 - remain_secs / (7 * 86400)
            # Guard on the NUMERATOR: pace stays silent until >=10% of the week is burned. An early spike
            # is harmless when little was spent (5% used at 1% elapsed is "5x over" on a trivial stake),
            # whereas 40% used in the first day is exactly what this indicator exists to catch, so an
            # elapsed-based guard would mask it. The small elapsed floor (~3h) only avoids absurd division
            # right after a reset. Tunables: warm above 1.15x, hot above 1.5x.
            if (used or 0) >= 10 and 0.02 <= elapsed <= 1:
                ratio = used / 100 / elapsed
                col = WEEKLY_CRIT if ratio > 1.5 else WEEKLY_WARN if ratio > 1.15 else ""
                if col:
                    pct_str = f"{col}{rem}%{RESET}"
                    pace = f" {col}▲{ratio:.1f}×{RESET}"
        return f"{bar} {pct_str} {reset_str}{pace}"

    five = seven = None
    rl = data.get('rate_limits') or {}
    pf, ps = rl.get('five_hour') or {}, rl.get('seven_day') or {}
    if pf.get('used_percentage') is not None:
        five = _bar_window(pf['used_percentage'], reset_from_epoch(pf.get('resets_at')))
    if ps.get('used_percentage') is not None:
        try: wk_remain = int(ps['resets_at']) - time.time()
        except Exception: wk_remain = None
        seven = _bar_window(ps['used_percentage'], reset_from_epoch(ps.get('resets_at')), weekly=True, remain_secs=wk_remain)

    # Build output
    lines_str = f"+{lines_added}/-{lines_removed} lines" if (lines_added or lines_removed) else ""

    host = socket.gethostname().split('.')[0]
    effort_part = f" {DIM}{effort}{RESET}" if effort else ""
    # Account letter: shown only for a non-default account, as its first letter uppercased in bright white.
    _acct = account_name()
    acct = f"\033[1;97m{_acct[0].upper()}{RESET}" if _acct and _acct != 'default' else ''
    # Token-age warning (no API call): a long-lived sign-in token lasts about a year and its file's mtime is
    # the mint date (this only ever reads it), so warn as it nears expiry. Yellow from 330 days, red from 355.
    # No token file (a normal claude.ai login) shows nothing.
    tok_warn = ""
    try:
        _age = (time.time() - os.path.getmtime(os.path.join(CFG_DIR, '.oauth_token'))) / 86400
        if _age >= 330: tok_warn = f" {(RED if _age >= 355 else YELLOW)}⚠tok{int(_age)}d{RESET}"
    except OSError:
        pass
    sid = data.get('session_id', '')
    if sid:
        # Width: the payload carries no terminal width and Claude runs the status line on pipes with no
        # controlling tty, so $COLUMNS (which Claude exports) is the source that answers.
        try: cols = int(data.get('terminal_width') or os.environ.get('COLUMNS') or 0)
        except (TypeError, ValueError): cols = 0
        if not cols:
            try: cols = os.get_terminal_size().columns
            except OSError: cols = 100
        sid_str = sid if cols >= 160 else sid.split('-')[0]
        sid_part = f" {DIM}{sid_str}{RESET}"
    else:
        sid_part = ""
    # Tokens in the window, colored by the severity tier above; the % itself does not print. If the
    # payload omits the token count, fall back to the colored % rather than dropping the reading.
    if ctx_valid and ctx_used is not None:
        ctx_str = f"Cx:{ctx_color}{fmt_tokens(ctx_used)}{RESET}"
    elif ctx_valid:
        ctx_str = f"Cx:{ctx_color}{remain_pct}%{RESET}"
    else:
        ctx_str = ""
    metrics = " ".join(s for s in (acct, ctx_str) if s)   # account letter leftmost, space-separated
    metrics_part = f"{metrics} | " if metrics else ""
    line1 = (
        f"{host} | "
        f"{model}{effort_part}{tok_warn} | "
        f"{metrics_part}"
        f"📁 {directory}{branch}{git_dirty}{git_sync}"
    )

    line2_parts = []
    if five or seven:
        if five: line2_parts.append(five)
        if seven: line2_parts.append(seven)
    else:
        line2_parts.append(f"{DIM}usage: —{RESET}")
    # Transcript size + session id share a SPACE (no pipe) — both describe this session's transcript.
    size_sid = " ".join(s for s in (size_disp, sid_part.strip()) if s)
    if size_sid: line2_parts.append(size_sid)
    if lines_str: line2_parts.append(lines_str)
    line2_parts.append(f"${session_cost:.0f}⏱️{time_str}")  # cost + duration last; rolls off the right edge first

    print(line1)
    print(" | ".join(line2_parts))

except Exception as e:
    print(f"{YELLOW}{socket.gethostname()}{RESET} | {DIM}statusline error: {type(e).__name__}: {e}{RESET}")
