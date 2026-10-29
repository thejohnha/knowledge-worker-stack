#!/usr/bin/env python3
"""priorities.py — the chief of staff's Priorities list: one ranked list of what needs the user (comms/README.md).

  priorities.py                          the screen: the open rows by tier, then due; keys below
  priorities.py list [DAYS] [--done] [--json]
                                         the open rows, for the chief's passes. DAYS keeps the rows whose start_by
                                         or due is at most DAYS from today, overdue included, undated left out.
                                         --done lists the done records instead, oldest first. --json prints every
                                         field plus the period title.
  priorities.py add title=... [field=value ...]   add a row; prints its id
  priorities.py set ID field=value ...   change fields; field= clears one; a tier the user set is refused
  priorities.py done ID                  mark row ID done, as d on the screen does: a repeating row leaves its done
                                         record and moves on to the next period
  priorities.py remove ID                mark row ID removed; it stays on file

The file: ~/.config/knowledge-worker-stack/priorities.json (PRIORITIES_FILE overrides). One JSON object: row ids
(integer strings, never reused) mapping to rows, plus "_settings": {"next_id": N}. The chief of staff writes the
rows through add, set, done and remove, never by hand; the screen changes them only on the user's keys, and re-reads the file just before every save, so a row the
chief wrote meanwhile is not lost. Fields, all optional but title, dates as "YYYY-MM-DD":
  title      as shown; a repeating row's period is added on screen, never stored
  due        the outside world's date; leave it out for a row waiting on an event, which sorts last in its tier
  start_by   the judgment of when work must begin; k and z move it, never due
  prep       what the user must do or bring; the evening note's source
  tier       1-4. 1 money, legal, security, or a hard date within 3 days; 2 a hard date within 14
             days, or blocks other work; 3 useful, no date; 4 done, an archive candidate. Unranked sorts with 3
  tier_by    "user" when the user set the tier with p; the chief leaves that tier alone
  owner      the owning session's tab label
  notes      free text
  watcher    on a row waiting on an event: the comms manager wake request that will date it
  created    the day the row was added
  done, removed   the day it was marked; the row leaves the list and stays on file, never deleted
  repeat_of  on a done record: the id of the repeating row it came from
A repeating row carries its rule and holds the current period's due and start_by:
  repeat "weekly" + day m/t/w/r/f/s/u · "monthly" + day 1-31 (clamped to the month's end)
  "quarterly" + offset (days after the quarter ends) · "annual" + month 1-12 and day 1-31
  lead       days start_by falls before due in each new period; without it the row keeps its current gap
Done on a repeating row leaves a done record titled with the period ("Estimated tax (Q3 2026)") and moves the
row on to the next period.

Keys on the screen: ↑/↓ move · Enter or e open the row · 1-9, 0 open that row · p set its tier · d done · z push
start_by · r remove · a add · h the done history · q quit. On a row's own screen: a field's number edits it (erase
the text to clear it; where python3's line editor is libedit, as Apple's and Homebrew's are, the old text cannot be
pre-filled, so Enter keeps it and - clears it), k kicks
start_by 45-90 days out, d marks it done.
"""

import calendar
import json
import os
import random
import shutil
import sys
from datetime import date, timedelta

PRIORITIES = os.path.expanduser(os.environ.get("PRIORITIES_FILE", "~/.config/knowledge-worker-stack/priorities.json"))
KICK_DAYS = (45, 90)  # k: a random day this far ahead, so kicked rows spread out instead of landing together
WEEKDAY_MAP = {"m": 0, "t": 1, "w": 2, "r": 3, "f": 4, "s": 5, "u": 6}
RULE_FIELDS = ("repeat", "day", "month", "offset", "lead")
PRIORITY_FIELDS = ("title", "due", "start_by", "prep", "owner", "notes", "watcher")

# ---------------------------------------------------------------- the file

def load_priorities():
    """The Priorities file, or an empty one when it does not exist yet. A corrupt file raises, so nothing overwrites it."""
    try:
        with open(PRIORITIES) as f:
            dl = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(dl, dict):
        raise json.JSONDecodeError("the file is not one JSON object", "", 0)
    for rid, row in dl.items():   # the file is hand-written: a null field counts as absent, a text field as text
        if not isinstance(row, dict):
            raise json.JSONDecodeError(f"row {rid} is not a JSON object", "", 0)
        for k in [k for k, v in row.items() if v is None]:
            del row[k]
        for k in PRIORITY_FIELDS:
            if k in row and not isinstance(row[k], str):
                row[k] = str(row[k])
    return dl

def save(dl):
    """Write the file whole: a private temp file beside it, synced, then renamed over it."""
    os.makedirs(os.path.dirname(PRIORITIES), mode=0o700, exist_ok=True)
    tmp = PRIORITIES + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(dl, f, indent=1, ensure_ascii=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, PRIORITIES)

def next_id(dl):
    """Auto-increment integer id, never reused."""
    settings = dl.setdefault("_settings", {})
    rid = settings.get("next_id", 1)
    existing = [int(k) for k in dl if k != "_settings" and k.isdigit()]
    if existing:
        rid = max(rid, max(existing) + 1)
    settings["next_id"] = rid + 1
    return str(rid)

# ---------------------------------------------------------------- terminal input

def clear():
    print("\033[2J\033[H", end="", flush=True)

def getch():
    """One raw keypress."""
    import termios, tty
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        return sys.stdin.read(1)
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

def key(prompt, valid, enter=None, arrows=False):
    """Single keypress input. Returns the pressed key if in valid set; with arrows, also "up" or "down"."""
    print(prompt, end="", flush=True)
    while True:
        ch = getch()
        if ch == "\x1b":
            seq = getch() + getch()
            if arrows and seq in ("[A", "[B"):
                return "up" if seq == "[A" else "down"
            continue
        if ch in ("\x03", "\x04"):
            print()
            sys.exit(0)
        if enter is not None and ch in ("\r", "\n"):
            print(enter)
            return enter
        low = ch.lower()
        if low in valid:
            print(low)
            return low

def ask(prompt, default=""):
    """Text input with enter. Empty = default."""
    suffix = f" [{default}]" if default else ""
    try:
        val = input(f"{prompt}{suffix}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    return val if val else default

def ask_int(prompt, default):
    """Text input that must be an integer."""
    val = ask(prompt, str(default))
    try:
        return int(val)
    except ValueError:
        print(f"Invalid number: {val}")
        return None

def ask_edit(prompt, prefill=""):
    """Text input with pre-filled editable text. libedit (Apple's and Homebrew's python3) cannot pre-fill a line, so there the old
    text is shown above the prompt instead: Enter keeps it, - clears it."""
    import readline
    if "libedit" in (readline.__doc__ or ""):
        if prefill:
            print(f"  now: {prefill}")
        try:
            val = input(f"{prompt} (enter keeps it, - clears it): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit(0)
        return prefill if not val else "" if val == "-" else val
    def hook():
        readline.insert_text(prefill)
        readline.redisplay()
    readline.set_pre_input_hook(hook)
    try:
        val = input(f"{prompt}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    finally:
        readline.set_pre_input_hook()
    return val  # erasing the pre-filled text clears the field

def pause():
    try:
        input("Press Enter...")
    except (EOFError, KeyboardInterrupt):
        print()

# ---------------------------------------------------------------- dates

def as_date(v):
    try:
        return date.fromisoformat(str(v))
    except (ValueError, TypeError):
        return None

def format_period(dd):
    """Format period date: 'Mar 15' or 'Mar 15, 2025' if different year."""
    if dd.year != date.today().year:
        return dd.strftime("%b %-d, %Y")
    return dd.strftime("%b %-d")

def format_date_summary(d):
    """Format a date with day name and relative distance."""
    days_out = (d - date.today()).days
    day_name = d.strftime("%a %b %-d")
    if days_out < 0:
        return f"{day_name} ({-days_out}d ago)"
    elif days_out == 0:
        return f"{day_name} (today)"
    elif days_out == 1:
        return f"{day_name} (tomorrow)"
    elif days_out < 7:
        return f"{day_name} ({days_out} days)"
    elif days_out < 30:
        weeks = days_out // 7
        rem = days_out % 7
        return f"{day_name} ({weeks}w {rem}d)" if rem else f"{day_name} ({weeks}w)"
    else:
        months = days_out // 30
        return f"{day_name} (~{months}mo)"

def parse_date_flexible(s):
    """Parse date, handling missing hyphens (YYYYMMDD)."""
    try:
        return date.fromisoformat(s)
    except ValueError:
        pass
    digits = ''.join(c for c in s if c.isdigit())
    if len(digits) == 8:
        try:
            return date.fromisoformat(f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}")
        except ValueError:
            pass
    return None

def add_months(d, n):
    """Add n months, clamping day to the target month's last valid day."""
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    last = calendar.monthrange(y, m)[1]
    return date(y, m, min(d.day, last))

def kick_date(today=None):
    """The kick: a random day KICK_DAYS ahead of TODAY, never of the row's current date, so rows kicked down the
    road spread out instead of landing together. Returns the date and how many days ahead it is."""
    days = random.randint(*KICK_DAYS)
    return (today or date.today()) + timedelta(days=days), days

def pick_date(prompt="When?", default_date=None, default_label=None):
    """Weekday picker: instant letter keys for tomorrow through +7, n = +1 month,
    k = a random KICK_DAYS ahead, digit+Enter for day# (asks month) or full ISO
    date. Enter returns default_date or None. Today is intentionally excluded —
    reachable only via default_date+Enter or day#."""
    today = date.today()
    RDAY = {0: "m", 1: "t", 2: "w", 3: "r", 4: "f", 5: "s", 6: "u"}
    DFMT = {0: "[M]on", 1: "[T]ue", 2: "[W]ed", 3: "thu[R]", 4: "[F]ri", 5: "[S]at", 6: "s[U]n"}
    shortcuts = {}
    hints = []
    for offset in range(1, 8):
        d = today + timedelta(days=offset)
        letter = RDAY[d.weekday()]
        shortcuts[letter] = d
        month_label = f" {d.strftime('%b')}" if d.month != today.month else ""
        hints.append(f"{DFMT[d.weekday()]}{month_label} {d.day}")
    valid_letters = "".join(shortcuts.keys())
    enter_hint = f" (enter={default_label}, [b]ack)" if default_label else " ([b]ack)"
    kick_hint = f"[k]ick {KICK_DAYS[0]}-{KICK_DAYS[1]}d"
    print(f"{prompt} {'  '.join(hints)}  or day# / [n]ext mo / {kick_hint}{enter_hint}: ", end="", flush=True)
    while True:
        ch = getch()
        if ch in ("\x03", "\x04"):
            print()
            sys.exit(0)
        if ch == "\x1b":
            getch()
            getch()
            continue
        if ch in ("\r", "\n"):
            print(default_label or "")
            return default_date
        low = ch.lower()
        if low == "b":
            print("back")
            return None
        if low == "n":
            base = default_date if (default_date and default_date > today) else today
            result = add_months(base, 1)
            print(f"next month ({result})")
            return result
        if low == "k":
            result, days = kick_date(today)
            print(f"kick +{days} days ({result})")
            return result
        if low in valid_letters:
            print(low)
            return shortcuts[low]
        if ch.isdigit():
            print(ch, end="", flush=True)
            try:
                rest = input()
            except (EOFError, KeyboardInterrupt):
                print()
                sys.exit(0)
            day_str = (ch + rest).strip()
            parsed = parse_date_flexible(day_str)
            if parsed:
                return parsed
            try:
                day_num = int(day_str)
            except ValueError:
                print("Invalid input.")
                pause()
                return None
            if day_num < 1 or day_num > 31:
                print(f"Day must be 1-31, got {day_num}.")
                pause()
                return None
            while True:
                mo = ask_int("Month", today.month)
                if mo is None:
                    continue
                try:
                    return date(today.year, mo, day_num)
                except ValueError:
                    print(f"Invalid date: {today.year}-{mo}-{day_num}. Try again.")

# ---------------------------------------------------------------- rows

def priority_title(row):
    """A repeating row names its period: monthly and weekly by the due date, quarterly by the quarter that ended,
    annual by the year — 'Rent (Oct)', 'Estimated tax (Q3 2026)'."""
    title, rep, due = row.get("title", "?"), row.get("repeat"), as_date(row.get("due"))
    if not rep or not due:
        return title
    try:
        return f"{title} ({priority_period(row, rep, due)})"
    except (ValueError, TypeError):
        return title

def priority_period(row, rep, due):
    if rep == "monthly":
        period = due.strftime("%b") if due.year == date.today().year else due.strftime("%b %Y")
    elif rep == "quarterly":
        qe = due - timedelta(days=int(row.get("offset", 0)))
        period = f"Q{(qe.month - 1) // 3 + 1} {qe.year}"
    elif rep == "annual":
        period = str(due.year)
    else:
        period = format_period(due)
    return period

def clamp_date(y, m, d):
    return date(y, m, min(d, calendar.monthrange(y, m)[1]))

def next_priority_due(row, after):
    """The repeat rule's first due date after `after`. weekly day=m..u, monthly day=1-31 (clamped to the month's
    end), quarterly offset=days after quarter end, annual month+day."""
    rep = row.get("repeat")
    if rep == "weekly":
        wd = WEEKDAY_MAP.get(row.get("day", "m"), 0)
        return after + timedelta(days=(wd - after.weekday() - 1) % 7 + 1)
    if rep == "monthly":
        day = int(row.get("day", 1))
        d = clamp_date(after.year, after.month, day)
        if d > after:
            return d
        y, m = (after.year + 1, 1) if after.month == 12 else (after.year, after.month + 1)
        return clamp_date(y, m, day)
    if rep == "quarterly":
        offset = int(row.get("offset", 0))
        y, q = after.year - 2, 4
        while True:
            qe = date(y, 12, 31) if q == 4 else date(y, q * 3 + 1, 1) - timedelta(days=1)
            if qe + timedelta(days=offset) > after:
                return qe + timedelta(days=offset)
            y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    if rep == "annual":
        m, day = int(row.get("month", 1)), int(row.get("day", 1))
        d = clamp_date(after.year, m, day)
        return d if d > after else clamp_date(after.year + 1, m, day)
    return None

def close_priority(dl, rid, today):
    """Mark a row done. A repeating row leaves a done record of this period behind and moves on to the next one,
    its start_by again `lead` days before the new due (or as many as it had, when there is no lead)."""
    row = dl[rid]
    due = as_date(row.get("due"))
    try:
        new_due = next_priority_due(row, due) if row.get("repeat") and due else None
    except (ValueError, TypeError) as e:
        print(f"Row {rid} has an unreadable repeat rule ({e}); marked done without a next period", file=sys.stderr)
        new_due = None
    if not new_due:
        row["done"] = today.isoformat()
        return
    rec = {k: v for k, v in row.items() if k not in RULE_FIELDS}
    rec.update(title=priority_title(row), done=today.isoformat(), repeat_of=int(rid))
    start = as_date(row.get("start_by"))
    lead = row.get("lead", (due - start).days if start else None)
    dl[next_id(dl)] = rec
    row["due"] = new_due.isoformat()
    if lead is not None:
        row["start_by"] = (new_due - timedelta(days=int(lead))).isoformat()

def change_priority(rid, fn):
    """Re-read the file, apply fn(file, row) to row rid, save. Returns the row, or None when it has gone meanwhile."""
    dl = load_priorities()
    if rid not in dl:
        print("That row is no longer in the file.")
        return None
    fn(dl, dl[rid])
    save(dl)
    return dl.get(rid)

TIERS = {1: "money, legal, security, or a hard date within 3 days",
         2: "a hard date within 14 days, or blocks other work", 3: "useful, no date", 4: "done, an archive candidate"}

def tier_of(row):
    """The row's tier 1-4, written as 1 or "P1"; None while the chief has not ranked it."""
    t = str(row.get("tier", "")).upper().lstrip("P")
    return int(t) if t in ("1", "2", "3", "4") else None

def open_priorities(dl):
    """Open rows by tier, then due, undated last within a tier. A row not ranked yet sorts with P3."""
    rows = [(rid, r) for rid, r in dl.items() if rid != "_settings" and not r.get("done") and not r.get("removed")]
    return sorted(rows, key=lambda x: (tier_of(x[1]) or 3, as_date(x[1].get("due")) or date.max,
                                       x[1].get("title", "").lower()))

def priority_line(row):
    due, start = as_date(row.get("due")), as_date(row.get("start_by"))
    parts = []
    if due:
        parts.append(f"due {format_date_summary(due)}")
    if start and start != due:
        parts.append(f"start {format_date_summary(start)}")
    line = f"{priority_title(row)} — {', '.join(parts) if parts else 'undated'}"
    if row.get("owner"):
        line += f"  [{row['owner']}]"
    return line

def short_day(d, today):
    """'today', 'tomorrow', '3d late', a weekday inside the coming week, else 'Nov 1'."""
    n = (d - today).days
    if n < 0:
        return f"{-n}d late"
    if n < 2:
        return ("today", "tomorrow")[n]
    if n < 7:
        return d.strftime("%a")
    return d.strftime("%b %-d" if d.year == today.year else "%b %-d %Y")

# ---------------------------------------------------------------- the screen
# Dim around a bright title, so the columns part by tone, not by rules.
CYAN, GOLD, RED, BOLD, DIM, RESET = "\033[1;36m", "\033[1;38;5;220m", "\033[1;31m", "\033[1m", "\033[2m", "\033[0m"

REVERSE = "\033[7m"
CURSOR = {"rid": None, "i": 0, "top": 0}   # the highlighted row and the first line shown, kept across redraws
TIER_COLOR = {1: RED, 2: GOLD, 3: "", 4: DIM}

def term_size():
    """The terminal's size, 200x50 where it reports none (Python before 3.11 passes a zero through)."""
    cols, lines = shutil.get_terminal_size((200, 50))
    return os.terminal_size((cols or 200, lines or 50))

def due_color(n):
    """Late red, today gold, tomorrow bold, this week plain, later dim."""
    return RED if n < 0 else GOLD if n == 0 else BOLD if n == 1 else "" if n < 7 else DIM

def clip(text, n):
    """text cut to n characters, the last one an ellipsis when anything was cut."""
    return text if len(text) <= n else text[:max(0, n - 1)] + "…"

def priority_screen_line(row, today, width, owner_width=0):
    """The list's row: tier; due; start only while it is still ahead and before due; the title, padded to width so
    the owner lines up after it. Padding is counted on the plain text, then the color goes on. P4 recedes."""
    t = tier_of(row)
    due, start = as_date(row.get("due")), as_date(row.get("start_by"))
    starts = short_day(start, today) if start and start > today and (not due or start < due) else ""
    title = clip(priority_title(row), width)
    pad = " " * max(0, width - len(title))
    tier = f"{TIER_COLOR[t]}P{t}{RESET}  " if t else f"{DIM}--{RESET}  "
    when = f"{due_color((due - today).days)}{short_day(due, today):<10}{RESET}" if due else f"{DIM}{'-':<10}{RESET}"
    return (f"{tier}{when}{DIM}{starts:<10}{RESET}{DIM if t == 4 else CYAN}{title}{RESET}{pad}"
            f"  {DIM}{clip(row.get('owner', ''), owner_width):<{owner_width}}{RESET}")

def priorities_view(today):
    """One pass of the screen: draw, read one key, act. Returns False to quit."""
    try:
        rows = open_priorities(load_priorities())
    except json.JSONDecodeError as e:
        print(f"=== Priorities ===\n\n  {PRIORITIES} is corrupt: {e}\n  Nothing here changes it; fix or restore the file.\n")
        key("[q]uit: ", "q", enter="q")
        return False
    lines, at, head = [], [], ["=== Priorities ===", ""]   # at[i] = the line row i sits on; None in lines = blank
    if not rows:
        head += ["  No open rows.", ""]
    else:   # one screen line per row, so the arrows and the scroll count stay true: titles pad to the longest, the
        # owner is capped at 30 characters, and the title gets what the terminal has left after the fixed columns
        owner_width = min(30, max(len(r.get("owner", "")) for _, r in rows))
        room = term_size().columns - 6 - 4 - 20 - 2 - owner_width - 2
        width = min(70, room, max(len(priority_title(r)) for _, r in rows))
        head.append(f"{DIM}{'':<10}{'due':<10}{'start':<10}{'':<{width}}  owner{RESET}")
    for i, (rid, row) in enumerate(rows, 1):
        if i > 1 and (tier_of(row) or 3) != (tier_of(rows[i - 2][1]) or 3):
            lines.append(None)   # a blank line between tiers
        label = "0." if i == 10 else f"{i}." if i < 10 else ""   # only the rows a number key opens; arrows reach the rest
        at.append(len(lines))
        lines.append(f"{DIM}{label:>4}{RESET}  {priority_screen_line(row, today, width, owner_width)}")
    valid = "adzerhqp"
    if rows:
        valid += "".join(str(i) for i in range(1, min(len(rows) + 1, 10)))
        if len(rows) >= 10:
            valid += "0"
    cur = next((i for i, (rid, _) in enumerate(rows) if rid == CURSOR["rid"]), min(CURSOR["i"], len(rows) - 1))
    # the list scrolls once it is taller than the screen: head, two "more" lines, the blank and a prompt that may wrap
    body = max(5, term_size().lines - len(head) - 6)
    fits = len(lines) <= body
    top = 0 if fits else min(CURSOR["top"], len(lines) - body)
    redraw = False
    while True:   # an arrow redraws in place: home, overwrite each line, erase the rest; no blank frame to flicker
        if not fits and rows:
            top = min(at[cur], max(top, at[cur] - body + 1))
        shown = lines if fits else lines[top:top + body]
        out = list(head)
        if not fits:
            out.append(f"{DIM}        ↑ {sum(l is not None for l in lines[:top])} more{RESET}" if top else "")
        for k, line in enumerate(shown, 0 if fits else top):
            out.append("" if line is None else REVERSE + line.replace(RESET, RESET + REVERSE) + RESET
                       if rows and k == at[cur] else line)
        if not fits:
            below = sum(l is not None for l in lines[top + body:])
            out.append(f"{DIM}        ↓ {below} more{RESET}" if below else "")
        sys.stdout.write(("\033[H" if redraw else "") + "\n".join(l + "\033[K" for l in out)
                         + ("\n\n" if rows else "\n") + ("\033[J" if redraw else ""))
        ch = key("[↑↓] move [enter] open [p]riority [d]one [z]push [r]emove [a]dd [h]istory [q]uit: ",
                 valid, enter="open", arrows=True)
        if ch not in ("up", "down"):
            break
        cur, redraw = max(0, min(len(rows) - 1, cur + (1 if ch == "down" else -1))), True
        if rows:
            CURSOR.update(rid=rows[cur][0], i=cur, top=top)
    if rows:
        CURSOR.update(rid=rows[cur][0], i=cur, top=top)
    if ch == "q":
        return False
    try:
        if ch == "a":
            add_priority()
        elif ch == "h":
            show_done_priorities()
        elif ch.isdigit():
            n = int(ch) if ch != "0" else 10
            if 1 <= n <= len(rows):
                CURSOR.update(rid=rows[n - 1][0], i=n - 1)
                edit_priority(rows[n - 1][0])
        elif rows and ch == "p":
            set_tier(rows[cur][0])
            CURSOR.update(rid=None)   # the highlight stays put and the next row moves under it, for ranking down a list
        elif rows and ch in ("open", "e", "d", "z", "r"):
            {"open": edit_priority, "e": edit_priority, "d": done_priority, "z": push_priority,
             "r": remove_priority}[ch](rows[cur][0])
    except json.JSONDecodeError as e:   # the file broke between drawing the list and the action
        print(f"{PRIORITIES} became unreadable: {e}")
        pause()
    return True

def set_tier(rid):
    """p: the user's tier for the row, marked tier_by = "user" so the chief's re-ranking leaves it alone."""
    row = load_priorities().get(rid)
    if not row:
        return
    print(f"\n{priority_title(row)} — now {'P' + str(tier_of(row)) if tier_of(row) else 'not ranked'}")
    for t, what in TIERS.items():
        print(f"  {t}) P{t}  {what}")
    ch = key("Tier (enter=back): ", "1234b", enter="b")
    if ch != "b":
        change_priority(rid, lambda dl, r: r.update(tier=int(ch), tier_by="user"))

def show_done_priorities():
    """h: the finished rows, newest first — the record of what was met."""
    clear()
    print("=== History === Priorities ===\n")
    dl = load_priorities()
    done = sorted((r for k, r in dl.items() if k != "_settings" and r.get("done")), key=lambda r: r["done"],
                  reverse=True)
    room = max(10, term_size().lines - 6)
    if not done:
        print("  Nothing marked done yet.")
    for r in done[:room]:
        print(f"  {r['done']}  {priority_title(r)}")
    if len(done) > room:
        print(f"\n  {len(done) - room} older: priorities.py list --done")
    pause()

def add_priority():
    clear()
    print("=== Add === Priorities ===\n")
    title = ask("Title")
    if not title:
        return
    row = {"title": title, "created": date.today().isoformat()}
    due = pick_date("Due?", default_date=None, default_label="undated, waits on an event")
    if due:
        row["due"] = due.isoformat()
        start = pick_date("Start by?", default_date=due, default_label="same as due")
        row["start_by"] = (start or due).isoformat()
    else:
        watcher = ask("Waits on (optional)")
        if watcher:
            row["watcher"] = watcher
    for f in ("prep", "owner", "notes"):
        v = ask(f"{f.capitalize()} (optional)")
        if v:
            row[f] = v
    dl = load_priorities()
    dl[next_id(dl)] = row
    save(dl)
    print(f"\nAdded: {title}")
    pause()

def edit_priority(rid):
    """The row's own screen: every field and the repeat rule, then one key."""
    clear()
    print("=== Edit === Priorities ===")
    row = load_priorities().get(rid)
    if not row:
        return
    print(f"\nEditing: {priority_title(row)}")
    for i, f in enumerate(PRIORITY_FIELDS, 1):
        v = row.get(f, "")
        if f in ("due", "start_by") and as_date(v):
            v = f"{v}  {format_date_summary(as_date(v))}"
        print(f"  {i}) {f} = {v}")
    if row.get("repeat"):
        print(f"     repeats: {', '.join(f'{k} {row[k]}' for k in RULE_FIELDS if k in row)}")
    t = tier_of(row)
    print(f"     {'P' + str(t) + (' (set by you)' if row.get('tier_by') == 'user' else '') if t else 'not ranked'}"
          f" — p on the list changes it")
    print(f"  k) Kick start_by {KICK_DAYS[0]}-{KICK_DAYS[1]} days out")
    print(f"  d) Done")
    print(f"  b) Back")
    valid = "".join(str(i) for i in range(1, len(PRIORITY_FIELDS) + 1)) + "kdb"
    ch = key("\n#: ", valid, enter="b")
    if ch == "b":
        return
    if ch == "d":
        return done_priority(rid)
    if ch == "k":
        kicked, days = kick_date()
        new = change_priority(rid, lambda dl, r: r.update(start_by=kicked.isoformat()))
        if new:
            print(f"\nkick +{days} days — start by {format_date_summary(kicked)}")
            due = as_date(new.get("due"))
            if due and kicked > due:
                print(f"Note: that is after the due date, {due}.")
        pause()
        return
    field = PRIORITY_FIELDS[int(ch) - 1]
    if field in ("due", "start_by"):
        current = as_date(row.get(field))
        target = pick_date(default_date=current, default_label=f"keep {current}" if current else "cancel")
        if not target:
            return
        newval = target.isoformat()
    else:
        newval = ask_edit(field, str(row.get(field, "")))
    if field == "title" and not newval.strip():
        print("Title cannot be empty.")
        pause()
        return
    def apply(dl, r):
        if newval:
            r[field] = newval
        else:
            r.pop(field, None)
    if change_priority(rid, apply):
        print("Updated.")
    pause()

def done_priority(rid):
    """d: the row is marked done with today's date and stays on file. A "y" goes straight back to the list; only a
    "no" or a failure waits for Enter."""
    row = load_priorities().get(rid)
    if not row:
        return
    ch = key(f"Confirm done: {priority_title(row)}? [y/n]: ", "yn", enter="n")
    if ch != "y":
        print("Not marked done.")
        pause()
        return
    if not change_priority(rid, lambda dl, r: close_priority(dl, rid, date.today())):
        pause()
        return
    print(f"Done: {priority_title(row)}")

def push_priority(rid):
    """z: move start_by later — the judgment, never due, which is the outside world's date."""
    row = load_priorities().get(rid)
    if not row:
        return
    today = date.today()
    base = as_date(row.get("start_by")) or as_date(row.get("due")) or today
    print(f"Start by: {format_date_summary(base)}")
    ch = key("Push: [t] +1 day / [a] +2 days / [w] +1 week / [d]ate (enter=back): ", "tawd", enter="b")
    if ch == "b":
        return
    target = base + timedelta(days={"t": 1, "a": 2, "w": 7}[ch]) if ch != "d" else pick_date("New date?")
    if not target:
        print("Cancelled.")
        pause()
        return
    if target <= today:
        print("Must be a future date.")
        pause()
        return
    if change_priority(rid, lambda dl, r: r.update(start_by=target.isoformat())):
        print(f"Pushed {priority_title(row)} → start {format_date_summary(target)}")
    pause()

def remove_priority(rid):
    """r: the row is marked removed with today's date and stays on file; it only leaves the list."""
    row = load_priorities().get(rid)
    if not row:
        return
    ch = key(f"Remove '{priority_title(row)}'? It stays on file, marked removed. [y/n]: ", "yn", enter="n")
    if ch != "y":
        print("Not removed.")
        pause()
        return
    if change_priority(rid, lambda dl, r: r.update(removed=date.today().isoformat())):
        print(f"Removed: {priority_title(row)}")
    pause()

def tui():
    while True:
        clear()
        if not priorities_view(date.today()):
            return

# ---------------------------------------------------------------- the read command

def list_priorities(args):
    """list — the open rows, by tier then due, for the chief of staff's passes."""
    as_json, done = "--json" in args, "--done" in args
    rest = [a for a in args if a not in ("--json", "--done")]
    if len(rest) > 1 or (rest and not rest[0].isdigit()):
        print(__doc__)
        return 2
    try:
        dl = load_priorities()
    except json.JSONDecodeError as e:
        print(f"{PRIORITIES} is corrupt: {e}")
        return 1
    if done:
        rows = sorted(((rid, r) for rid, r in dl.items() if rid != "_settings" and r.get("done")),
                      key=lambda x: x[1]["done"])
    else:
        rows = open_priorities(dl)
    if rest:
        horizon = date.today() + timedelta(days=int(rest[0]))
        rows = [(rid, r) for rid, r in rows
                if any(d and d <= horizon for d in (as_date(r.get("start_by")), as_date(r.get("due"))))]
    if as_json:
        print(json.dumps([dict(r, id=int(rid), display_title=priority_title(r)) for rid, r in rows], indent=1,
                         ensure_ascii=False))
        return 0
    for rid, r in rows:
        t = f"P{tier_of(r)}" if tier_of(r) else "--"
        prefix = f"done {r['done']}" if done else f"{t}  start {r.get('start_by', '-'):<10}  due {r.get('due', '-'):<10}"
        print(f"{prefix}  #{rid}  {priority_line(r)}")
    return 0

def write_command(cmd, args):
    """add, set, done, remove: the chief's writes, each a re-read, one change and a save, so it never hand-edits."""
    try:
        if cmd == "add":
            fields = parse_fields(args)
            if not fields or not fields.get("title"):
                return usage("add needs title=...")
            fields = {k: v for k, v in fields.items() if v != ""}
            dl = load_priorities()
            rid = next_id(dl)
            dl[rid] = dict(fields, created=date.today().isoformat())
            save(dl)
            print(f"Added: #{rid} {priority_title(dl[rid])}")
            return 0
        if not args:
            return usage(f"{cmd} needs a row id")
        rid, rest = args[0], args[1:]
        if cmd == "set":
            fields = parse_fields(rest)
            if not fields:
                return usage("set needs field=value ...")
            row = load_priorities().get(rid)
            if row and "tier" in fields and row.get("tier_by") == "user":
                print(f"#{rid}: the user set this tier; it changes only with p on the screen.")
                return 1
            if fields.get("title") == "":
                return usage("title cannot be empty")
            def apply(dl, r):
                for k, v in fields.items():
                    if v == "":
                        r.pop(k, None)
                    else:
                        r[k] = v
            row = change_priority(rid, apply)
        elif cmd == "done" and not rest:
            row = change_priority(rid, lambda dl, r: close_priority(dl, rid, date.today()))
        elif cmd == "remove" and not rest:
            row = change_priority(rid, lambda dl, r: r.update(removed=date.today().isoformat()))
        else:
            return usage()
    except json.JSONDecodeError as e:
        print(f"{PRIORITIES} is corrupt: {e}")
        return 1
    if not row:
        return 1
    if cmd == "done":
        print(f"Done: #{rid}" + (f", next due {row['due']}" if not row.get("done") else ""))
    else:
        print(f"{'Updated' if cmd == 'set' else 'Removed'}: #{rid} {priority_title(row)}")
    return 0

SETTABLE = PRIORITY_FIELDS + ("tier",) + RULE_FIELDS

def parse_fields(args):
    """field=value pairs, checked: known fields only, dates as YYYY-MM-DD, tier 1-4, the rule's numbers as numbers.
    An empty value (notes=) clears the field. Returns None, after saying why, when any pair is wrong."""
    out = {}
    for a in args:
        k, eq, v = a.partition("=")
        if not eq or k not in SETTABLE:
            print(f"Not a field=value pair this list knows: {a}  (fields: {', '.join(SETTABLE)})")
            return None
        v = v.strip()
        if v and k in ("due", "start_by") and not as_date(v):
            print(f"{k} takes YYYY-MM-DD, not {v}")
            return None
        if v and k == "tier":
            if tier_of({"tier": v}) is None:
                print(f"tier takes 1-4, not {v}")
                return None
            v = tier_of({"tier": v})
        elif v and k in RULE_FIELDS and k != "repeat" and v.isdigit():
            v = int(v)
        out[k] = v
    return out

def usage(why=""):
    print((why + "\n\n" if why else "") + __doc__)
    return 2

def main(argv):
    if len(argv) > 1 and argv[1] == "list":
        return list_priorities(argv[2:])
    if len(argv) > 1 and argv[1] in ("add", "set", "done", "remove"):
        return write_command(argv[1], argv[2:])
    if len(argv) > 1 or not sys.stdin.isatty():
        print(__doc__)
        return 0 if argv[1:] in (["-h"], ["--help"]) else 2
    tui()
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
