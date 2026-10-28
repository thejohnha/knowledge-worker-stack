#!/usr/bin/env python3
"""What every live Claude session is waiting on the user for, rebuilt from the transcripts on every
run. The chief of staff runs it on every wake (~/.claude/chief-of-staff.md, steps 1-2).

  claude_chief_of_staff_owed_scan.py              # the sorted list, with counts and the left-off list
  claude_chief_of_staff_owed_scan.py --json       # same rows as JSON
  claude_chief_of_staff_owed_scan.py --no-model   # skip the Haiku pass; every unclear row counts as owed
  claude_chief_of_staff_owed_scan.py --dry        # write neither the stamp nor the serve log (testing)
  claude_chief_of_staff_owed_scan.py log shown|answer|note <uuid> "<text>"   # the serve log, below

No queue file, on purpose. Every row is recomputed from the transcripts each run and every live
session gets one, so the list cannot go stale in the chief's context, skip an old session, or rest
on the last few hundred characters of one reply.

PER SESSION. Find the user's last REAL prompt, then read every assistant reply after it, the latest in
full. A relay, a peer message, a scheduled wake or a successor kickoff carries the same marks as the
user's typing, so look-alikes are told apart by their opening words (LOOKALIKE_PREFIX: only what
Claude Code itself and the tools in this package write). An ask stays open while the session's replies still carry it — sessions repeat open asks
("Still waiting on you", "Your call"). One event narrows the window: a "From the user via the chief of
staff:" relay carries the user's answer, so once the session has replied to it only the replies after
it are judged.

BUCKETS, in this order:
  live-in-its-own-tab  the user typed in that tab within the last hour: shown, never served
  stuck-restart        the latest reply announced a restart and nothing came after it
  owed                 an explicit ask to the user, or an unclear row the model called owed or could not judge
  maybe                the model's call on an unclear row: possibly waiting on the user
  none                 nothing asked of the user
Explicit wording decides first; Haiku sees only unclear rows. A failed model call is OWED, never clear.

LEFT OFF. Sessions never served, each printed with its reason: the chief itself, sessions whose title
matches LEAVE_OFF (empty by default), and sessions whose prime directive entry is closed, whose last
ask is printed but is usually stale.

STATE. Each run writes ~/.claude/state/state_claude_chief_of_staff_scan_stamp.json (time and
counts), which the chief's Stop hook (chief-of-staff-nothing-waiting-guard.py) reads before letting
it say nothing is waiting. The serve log ~/.claude/state/state_claude_chief_of_staff_serve_log.jsonl
is append-only: one line per scan (owed sessions, left-off and why), one per `log shown` (what the
chief put to the user), `log answer` (their words) and `log note`. Read-only toward every session.
"""
import argparse, json, os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import claude_chief_of_staff_find as finder

HOME = os.path.expanduser('~')
LINEAGE = os.path.join(HOME, '.claude/state/state_claude_session_title_lineage.json')
STAMP = os.path.join(HOME, '.claude/state/state_claude_chief_of_staff_scan_stamp.json')
SERVE_LOG = os.path.join(HOME, '.claude/state/state_claude_chief_of_staff_serve_log.jsonl')
OWN_TAB_MIN = 60
TAIL_CAP = 96 * 1024 * 1024          # read back at most this far looking for the user's last prompt
BLOCK = 4 * 1024 * 1024

# ---------------------------------------------------------------- the user's prompts vs look-alikes
PASTE = re.compile(r'</?pasted_content\b[^>]*>')
LOOKALIKE_PREFIX = (
    # Claude Code's own wrappers
    '<system-reminder>', '<local-command', '<task-notification', '<cross-session-message',
    '<teammate-message', 'Another Claude session sent a', '[Cross-session', 'Stop hook feedback',
    'This session is being continued from a previous conversation',
    # this package: the chief, its hourly wake, and the comms manager
    'From the user via the chief of staff', 'From the chief of staff', 'Scheduled wake (',
    'From claude_frontdesk.py',
    # this package: /successor's first prompt and closing report, and the auto-successor job
    'You are session ', 'You are the successor to ', 'CLOSING REPORT FROM YOUR PREDECESSOR', '[auto-successor]',
    # one session messaging another with `tell` opens "From session <its title>:" (the package's convention)
    'From session ',
)
RELAY_OF_USER = 'From the user via the chief of staff'


def flat(v):
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return ''.join(b.get('text', '') for b in v if isinstance(b, dict) and b.get('type') == 'text')
    return ''


def ts_epoch(ts):
    try:
        return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
    except (ValueError, AttributeError):
        return None


def prompt_kind(rec):
    """('user'|'relay'|'other'|None, text). relay = the user's words via the chief; None = not a prompt."""
    if rec.get('isSidechain'):
        return None, ''
    if rec.get('type') == 'attachment':
        a = rec.get('attachment') or {}
        if a.get('type') != 'queued_command':
            return None, ''
        text, origin, has_origin = flat(a.get('prompt')), a.get('origin'), 'origin' in a
    elif rec.get('type') == 'user':
        c = (rec.get('message') or {}).get('content')
        if isinstance(c, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c):
            return None, ''
        text, origin, has_origin = flat(c), rec.get('origin'), 'origin' in rec
        if rec.get('isMeta'):
            return 'other', text
    else:
        return None, ''
    text = PASTE.sub('', text).strip()
    if not text:
        return None, ''
    kind = origin.get('kind') if isinstance(origin, dict) else None
    if kind and kind != 'human':
        return 'other', text
    if not kind and (has_origin or text.startswith('<')):
        return 'other', text                      # a harness wrapper or an origin-less local command
    if text.startswith(RELAY_OF_USER):
        return 'relay', text
    if text.startswith(LOOKALIKE_PREFIX):
        return 'other', text
    return 'user', text


def reverse_records(path):
    """Yield records newest first, reading back at most TAIL_CAP bytes."""
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        pos, carry = size, b''
        while pos > 0 and size - pos < TAIL_CAP:
            step = min(BLOCK, pos)
            pos -= step
            f.seek(pos)
            lines = (f.read(step) + carry).split(b'\n')
            carry = lines.pop(0) if pos > 0 else b''
            for line in reversed(lines):
                if line.strip():
                    try:
                        yield json.loads(line)
                    except ValueError:
                        continue


def scan_transcript(path):
    """The user's last real prompt, the newest relay of their words after it, and the replies since."""
    replies, relay_after, user = [], None, None
    for rec in reverse_records(path):
        if rec.get('type') == 'assistant' and not rec.get('isSidechain'):
            t = flat((rec.get('message') or {}).get('content'))
            if t.strip():
                replies.append({'ts': rec.get('timestamp'), 'text': t})
            continue
        kind, text = prompt_kind(rec)
        if kind == 'user':
            user = {'ts': rec.get('timestamp'), 'text': text}
            break
        if kind == 'relay' and relay_after is None:
            relay_after = len(replies)            # how many replies are newer than the relay
    replies.reverse()
    return user, relay_after, replies


# ---------------------------------------------------------------- explicit wording
NOTHING = re.compile(r"nothing (is )?(on|needed from|owed to|waiting on) (you|the user)\b"
                     r"|no action (needed|required) from (you|the user)\b|nothing for (you|the user) to do|not blocked on (you|the user)\b"
                     r"|(blocked on|needed from|need from|waiting on) (you|the user)\W*\s*(no|nothing|none)\b", re.I)
ASK = re.compile(
    r"still waiting on you|waiting (on|for) (you|the user|your)\b|needed from (you|the user)|need(s|ed)? from you|"
    r"\byour (call|move|go|decision|approval|answer|choice|pick|okay|ok|yes|word)\b|"
    r"\bfor you to (approve|decide|choose|pick|confirm|review|answer|say|sign|check)|"
    r"\b(reply|say|answer|type) (yes|go)\b|\b(reply|say|answer|type) (\*\*|[\"'“])\s*(yes|go|no|ok|approve|delete|send)\b|"
    r"\b(want me to|shall i|should i|can i|may i|do i)\b[^.\n]*\?|\bdo you want\b|\bwould you like\b|\byes or no\b|"
    r"\btell me (any|which|what|whether|if)\b|"
    r"\bwhich (one|option|do you|would you)\b[^.\n]*\?|\bok(ay)? to (send|proceed|go|deploy|delete|submit|commit)\b|"
    r"\bon hold until you\b|\bstill open\b(\s+for (you|the user))?\**\s*:|\breply with\b|\b(next|one|last|open|my) questions? for you\b|\bwhat is this session for\b|\b(done_when|prime directive)\b[^\n]*\?|"
    r"\b(type|say|reply|send)\b[^.\n]{0,30}[\"“][^\"”]{1,40}[\"”]|\bwhich works for you\b|"
    r"\bplease (confirm|approve|decide|choose|review)\b|\bblocked on (you|the user)\b|\bawaiting your\b", re.I)
# Lines that name an action only to say the user need not take it: "You don't need to type "continue"".
NOT_ASK = re.compile(r"\b(you )?(don'?t|do not|won'?t) (need|have) to\b|\bno need (for you )?to\b", re.I)
RESTART = re.compile(r"\b(restart(ing)?|relaunch(ing)?|reopen(ing)?)\b[^.\n]{0,60}\b(skip mode|this session|now|armed|set up|in a few seconds)"
                     r"|\b(the )?restart is (set|armed)\b"
                     r"|this session (will|is going to|is now) (quit|close|exit|restart|relaunch|reopen|come back)", re.I)


QUESTION = re.compile(r"\?(\s|$|[*_)\]])")
YOU_QUESTION = re.compile(r"\b(you|your)\b[^.!?\n]*\?(\s|$|\*)", re.I)


def ask_lines(text):
    """Lines in a reply that carry an ask to the user — the quoted evidence. A bare label line ("## Your
    call") is quoted together with the line after it, which is where the ask itself sits."""
    out, lines = [], [l.strip() for l in text.splitlines()]
    for i, s in enumerate(lines):
        if s and not NOTHING.search(s) and not NOT_ASK.search(s) and (ASK.search(s) or YOU_QUESTION.search(s)):
            if len(s.strip('#*_:- ')) < 30:
                s += ' ' + next((n for n in lines[i + 1:] if n), '')
            out.append(s)
    return out


def question_lines(text):
    """Lines ending in a question, markdown emphasis and all. Table rows and headings are not asks."""
    return [l.strip() for l in text.splitlines()
            if QUESTION.search(l) and not l.strip().startswith(('#', '|'))]


def clip(s, n):
    s = ' '.join(s.split())
    return s if len(s) <= n else s[:n - 1] + '…'


# ---------------------------------------------------------------- the model, on unclear rows only
def model_env():
    """The child needs the login token the shell profile exports only to interactive shells; a scan run from a
    session or launchd has none and the child answers "Not logged in"."""
    env = {**os.environ, 'DATE_PREFIX_TITLE_CLASSIFYING': '1'}
    tok = os.path.join(HOME, '.claude/.oauth_token')
    if not env.get('CLAUDE_CODE_OAUTH_TOKEN') and os.path.isfile(tok):
        env['CLAUDE_CODE_OAUTH_TOKEN'] = open(tok).read().strip()
    return env


def ask_model(title, latest):
    prompt = ("A Claude Code work session's latest reply to its user is below. Is the session waiting on the user "
              "for something: a decision, an approval, an answer, a choice, or an action only they can take? "
              "Reply with one word, OWED, MAYBE or NONE, then ' | ' and the ask quoted exactly from the reply "
              "(empty if NONE).\n\nSession title: " + title + "\n\nLatest reply:\n" + latest[-6000:])
    try:
        r = subprocess.run(['claude', '-p', '--model', 'haiku', '--no-session-persistence', '--setting-sources', '',
                            '--tools', '', '--output-format', 'json', '--system-prompt',
                            'You triage whether a work session is waiting on its owner. Answer in the exact format asked.'],
                           input=prompt, capture_output=True, text=True, timeout=120,
                           cwd=os.environ.get('TMPDIR') or '/tmp',
                           env=model_env())
        d = json.loads(r.stdout)
        res = d.get('result') if isinstance(d, dict) and not d.get('is_error') and not r.returncode else None
    except Exception:
        res = None
    if not isinstance(res, str):
        return 'owed', '', 'model call failed, counted as owed'
    word, _, quote = res.strip().partition('|')
    verdict = {'OWED': 'owed', 'MAYBE': 'maybe', 'NONE': 'none'}.get(word.strip().strip('*').upper())
    if not verdict:
        return 'owed', '', 'model answer unreadable, counted as owed'
    return verdict, quote.strip().strip('"“”'), 'model'


# ---------------------------------------------------------------- per session
def transcript_path(uuid):
    return finder.transcript(uuid) or None


def hours(sec):
    if sec is None:
        return '—'
    m = int(sec // 60)
    return f'{m // 1440}d{m % 1440 // 60}h' if m >= 1440 else f'{m // 60}h{m % 60:02d}m' if m >= 60 else f'{m}m'


# (title regex, reason): sessions the user answers in their own tab, never served by the chief.
LEAVE_OFF = []


def leave_off_reason(r):
    """Why a judged row is never served, or None."""
    why = next((reason for rx, reason in LEAVE_OFF if rx.search(r['title'])), None)
    if not why and r.get('closed') and r['bucket'] in ('owed', 'maybe'):
        why = 'its prime directive entry is closed (done_when met), so its last ask is most likely stale'
    return why


def judge(row, now):
    path = transcript_path(row['uuid'])
    if not path:
        row.update(bucket='owed', how='no transcript found, counted as owed', ask='(transcript missing)')
        return row
    user, relay_after, replies = scan_transcript(path)
    row['user_last_text'] = clip(user['text'], 120) if user else ''
    row['user_ago'] = now - ts_epoch(user['ts']) if user and ts_epoch(user['ts']) else None
    if relay_after:                                # the session has replied to the user's relayed words
        judged = replies[-relay_after:]
        row['window'] = f'{len(judged)} replies since the chief relayed the user\'s words'
    else:
        judged = replies
        row['window'] = f'{len(judged)} replies since the user last typed here'
    latest = judged[-1] if judged else None
    row['latest_reply'] = latest['text'] if latest else ''
    row['latest_ago'] = now - ts_epoch(latest['ts']) if latest and ts_epoch(latest['ts']) else None

    found = [(r, l) for r in judged for l in ask_lines(r['text'])]
    if found and latest and NOTHING.search(latest['text']) and not ask_lines(latest['text']):
        found = []                                 # the latest reply says nothing is on the user: older asks are settled
    if found:
        newest = found[-1][0]
        row['asked_ago'] = now - (ts_epoch(found[0][0]['ts']) or now)
        mine = [l for r, l in found if r is newest]
        row['ask'] = clip(([l for l in mine if '?' in l] or mine)[-1], 300)
        row['earlier_asks'] = [clip(l, 200) for r, l in found if r is not newest][-3:]
        verdict, row['how'] = 'owed', 'explicit wording'
    elif latest and question_lines(latest['text']):
        verdict = 'unclear'
        row['ask'] = clip(question_lines(latest['text'])[-1], 300)
        row['asked_ago'] = row['latest_ago']
    elif latest and NOTHING.search(latest['text']):
        verdict, row['how'] = 'none', 'says nothing is on the user'
    else:
        verdict, row['how'] = 'none', 'no ask in the replies' if judged else 'no reply since the user last typed here'
    row['_verdict'] = verdict

    if row['user_ago'] is not None and row['user_ago'] < OWN_TAB_MIN * 60:
        row['bucket'] = 'live-in-its-own-tab'
    elif latest and replies and latest is replies[-1] and RESTART.search(latest['text'][-1200:]) \
            and row['status'] != 'working' and (row['latest_ago'] or 0) > 600:
        row['bucket'] = 'stuck-restart'
        row['how'] = 'it announced a restart and has said nothing since'
        row.setdefault('ask', clip(latest['text'][-200:], 200))
    else:
        row['bucket'] = verdict
    return row


def live_rows():
    agents = json.loads(subprocess.run(['herdr', 'agent', 'list'], capture_output=True, text=True, check=True).stdout)
    lineage, titles = finder.jload(LINEAGE), finder.jload(finder.TITLES)
    rows = []
    for ag in agents['result']['agents']:
        uuid = (ag.get('agent_session') or {}).get('value', '')
        if ag.get('agent') != 'claude' or not uuid:
            continue
        e = lineage.get(uuid) if isinstance(lineage.get(uuid), dict) else {}
        rows.append({'uuid': uuid, 'pane': ag.get('pane_id'), 'status': ag.get('agent_status'),
                     'title': ag.get('terminal_title_stripped') or ag.get('name') or '',
                     'is_chief': finder.is_chief(uuid, ag.get('terminal_title_stripped') or ag.get('name') or '', lineage, titles),
                     'closed': bool(e.get('closed'))})
    return rows


def scan(use_model=True):
    now = time.time()
    me = os.environ.get('CLAUDE_CODE_SESSION_ID', '')
    rows, left_off = [], []
    for r in live_rows():
        (left_off.append({**r, 'reason': 'the chief of staff itself'}) if r['is_chief'] else rows.append(r))
    with ThreadPoolExecutor(8) as ex:
        rows = list(ex.map(lambda r: judge(r, now), rows))
    unclear = [r for r in rows if r.get('_verdict') == 'unclear']
    if use_model and unclear:
        with ThreadPoolExecutor(6) as ex:
            results = list(ex.map(lambda r: ask_model(r['title'], r['latest_reply']), unclear))
    else:
        results = [('owed', '', 'unclear wording, model skipped (--no-model), counted as owed')] * len(unclear)
    for r, (v, q, how) in zip(unclear, results):
        r['how'] = how
        if q:
            r['ask'] = clip(q, 300)
        if r['bucket'] == 'unclear':
            r['bucket'] = v
    kept = []
    for r in rows:
        r.pop('_verdict', None)
        why = leave_off_reason(r)

        if why:
            left_off.append({**r, 'reason': why})
        elif r['uuid'] == me:
            left_off.append({**r, 'reason': 'the session running this scan'})
        else:
            kept.append(r)
    return kept, left_off, now


ORDER = ['owed', 'maybe', 'stuck-restart', 'live-in-its-own-tab', 'none']


def write_state(kept, left_off, now):
    counts = {b: sum(r['bucket'] == b for r in kept) for b in ORDER}
    os.makedirs(os.path.dirname(STAMP), exist_ok=True)
    tmp = STAMP + '.tmp'
    with open(tmp, 'w') as f:
        json.dump({'_README': 'Last run of claude_chief_of_staff_owed_scan.py: when, and how many sessions per bucket. '
                              'Read by the chief of staff\'s Stop hook (chief-of-staff-nothing-waiting-guard.py). '
                              'Safe to delete; the next scan rewrites it.',
                   'epoch': now, 'counts': counts, 'live': len(kept) + len(left_off)}, f)
    os.replace(tmp, STAMP)
    with open(SERVE_LOG, 'a') as f:
        f.write(json.dumps({'ts': datetime.fromtimestamp(now, timezone.utc).isoformat(timespec='seconds'),
                            'event': 'scan', 'counts': counts,
                            'owed': [r['uuid'][:8] for r in kept if r['bucket'] == 'owed'],
                            'left_off': [{'uuid': r['uuid'][:8], 'title': r['title'], 'reason': r['reason']}
                                         for r in left_off]}, ensure_ascii=False) + '\n')
    return counts


def line(r):
    if r['bucket'] == 'live-in-its-own-tab':
        out = f"- {r['title']} · {r['uuid'][:8]} · {r['pane']} · the user typed here {hours(r['user_ago'])} ago"
    else:
        age = r.get('asked_ago') if r.get('asked_ago') is not None else r.get('latest_ago')
        out = f"- {r['title']} · {r['uuid'][:8]} · {r['pane']} · asked {hours(age)} ago"
    out += f"\n    ask: “{r['ask']}”" if r.get('ask') else f"\n    ({r.get('how', '')})"
    if r['bucket'] in ('owed', 'maybe', 'stuck-restart') and r.get('ask') and r.get('how') != 'explicit wording':
        out += f"  [{r.get('how')}]"
    return out


def report(kept, left_off, counts):
    print('OWED-TO-USER SCAN · ' + datetime.now().strftime('%Y-%m-%d %H:%M') + ' · ' + str(len(kept) + len(left_off))
          + ' live sessions · ' + ' · '.join(f'{counts[b]} {b}' for b in ORDER))
    for b in ORDER:
        rs = sorted((r for r in kept if r['bucket'] == b), key=lambda r: -(r.get('asked_ago') or r.get('latest_ago') or 0))
        if not rs:
            continue
        print(f'\n## {b} ({len(rs)})')
        if b == 'none':
            print('  ' + ', '.join(f"{r['title']} ({r['uuid'][:8]})" for r in rs))
        else:
            for r in rs:
                print(line(r))
    print(f'\n## left off ({len(left_off)}), never served')
    for r in left_off:
        a = f" · open ask: “{r['ask']}”" if r.get('ask') and r.get('bucket') in ('owed', 'maybe') else ''
        print(f"- {r['title']} · {r['uuid'][:8]}: {r['reason']}{a}")


def log_cmd(argv):
    if len(argv) < 3 or argv[0] not in ('shown', 'answer', 'note'):
        sys.exit('usage: claude_chief_of_staff_owed_scan.py log shown|answer|note <uuid> "<text>"')
    with open(SERVE_LOG, 'a') as f:
        f.write(json.dumps({'ts': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'event': argv[0],
                            'uuid': argv[1], 'text': ' '.join(argv[2:])}, ensure_ascii=False) + '\n')


def main():
    if sys.argv[1:2] == ['log']:
        return log_cmd(sys.argv[2:])
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-model', action='store_true')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    kept, left_off, now = scan(not a.no_model)
    counts = {b: sum(r['bucket'] == b for r in kept) for b in ORDER} if a.dry else write_state(kept, left_off, now)
    if a.json:
        print(json.dumps({'counts': counts, 'rows': kept, 'left_off': left_off}, indent=1, ensure_ascii=False))
    else:
        report(kept, left_off, counts)


if __name__ == '__main__':
    main()
