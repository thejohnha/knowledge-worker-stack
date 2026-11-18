#!/usr/bin/env python3
"""One page on every live Claude session in herdr, for the chief of staff to read instead of
opening each transcript: where it sits, whether it is working or waiting, how long it has been
quiet, what it is for (prime directive / done_when), and the tail of its last reply.

  claude_fleet_digest.py            # text, longest-waiting first
  claude_fleet_digest.py --json     # same rows as JSON
  claude_fleet_digest.py --tail 600 # characters of the last reply to keep (default 400)

Read-only. The ASKS column is a cheap hint (the last reply's closing lines hold a '?'),
not a verdict — the reader judges whether the user is actually owed an answer.
"""
import argparse, json, os, subprocess, time
from datetime import datetime

LINEAGE = os.path.expanduser('~/.claude/state/state_claude_session_title_lineage.json')


def herdr(*args):
    return json.loads(subprocess.run(['herdr', *args], capture_output=True, text=True, check=True).stdout)


def transcript_path(uuid):
    r = subprocess.run(['claude_session_transcript.sh', uuid], capture_output=True, text=True)
    p = r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ''
    return p if p and os.path.isfile(p) else None


def is_local_command(rec):
    """A slash command run in the client, not a turn: claude_restart_sessions_after_update.py's /restart
    writes two of these, and counting them would reset 'quiet' on every session it restarts."""
    if rec.get('type') == 'system' and rec.get('subtype') == 'local_command':
        return True
    c = (rec.get('message') or {}).get('content') if rec.get('type') == 'user' else None
    return isinstance(c, str) and c.lstrip().startswith(('<command-name>', '<local-command-'))


def last_reply(path, chunk=400_000):
    """Text of the last assistant record that carries text, and the time of the last record."""
    with open(path, 'rb') as f:
        f.seek(0, 2)
        f.seek(max(0, f.tell() - chunk))
        lines = f.read().decode('utf-8', 'replace').splitlines()
    text, last_ts = '', None
    for line in reversed(lines):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if last_ts is None and rec.get('timestamp') and not is_local_command(rec):
            last_ts = rec['timestamp']
        if rec.get('type') == 'assistant':
            parts = rec.get('message', {}).get('content') or []
            t = ''.join(p.get('text', '') for p in parts if isinstance(p, dict) and p.get('type') == 'text')
            if t.strip():
                text = t
                break
    return text, last_ts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--tail', type=int, default=400)
    a = ap.parse_args()

    agents = herdr('agent', 'list')['result']['agents']
    ws = {w['workspace_id']: w.get('label', '') for w in herdr('api', 'snapshot')['result']['snapshot']['workspaces']}
    try:
        lineage = json.load(open(LINEAGE))
    except (OSError, ValueError):
        lineage = {}
    me = os.environ.get('CLAUDE_CODE_SESSION_ID', '')
    now = time.time()
    rows = []
    for ag in agents:
        if ag.get('agent') != 'claude':
            continue
        uuid = (ag.get('agent_session') or {}).get('value', '')
        entry = lineage.get(uuid) if isinstance(lineage.get(uuid), dict) else {}
        path = transcript_path(uuid) if uuid else None
        text, ts = last_reply(path) if path else ('', None)
        quiet = int((now - datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()) / 60) if ts else None
        tail = ' '.join(text.split())[-a.tail:]
        rows.append({
            'uuid': uuid, 'self': uuid == me,
            'pane': ag.get('pane_id'), 'workspace': ws.get(ag.get('workspace_id'), ''),
            'name': ag.get('name') or '', 'status': ag.get('agent_status'),
            'title': ag.get('terminal_title_stripped', ''),
            'quiet_min': quiet,
            'prime_directive': entry.get('prime_directive', ''), 'done_when': entry.get('done_when', ''),
            'asks': '?' in ' '.join(text.split())[-300:],
            'last_reply_tail': tail,
        })
    rows.sort(key=lambda r: (r['status'] == 'working', -(r['quiet_min'] or 0)))

    if a.json:
        print(json.dumps(rows, indent=1, ensure_ascii=False))
        return
    work = sum(r['status'] == 'working' for r in rows)
    print(f"{len(rows)} live sessions · {work} working · {len(rows) - work} waiting · "
          f"{sum(r['asks'] and r['status'] != 'working' for r in rows)} end on a question")
    for r in rows:
        q = '—' if r['quiet_min'] is None else (f"{r['quiet_min'] // 60}h{r['quiet_min'] % 60:02d}m")
        flag = ' ASKS' if r['asks'] and r['status'] != 'working' else ''
        me_ = ' (this session)' if r['self'] else ''
        print(f"\n## {r['title']}{me_}\n{r['status']}{flag} · quiet {q} · {r['workspace']} {r['pane']} · {r['uuid']}")
        if r['prime_directive']:
            print(f"PD: {r['prime_directive']} | done_when: {r['done_when']}")
        if r['last_reply_tail']:
            print(f"last: …{r['last_reply_tail']}")


if __name__ == '__main__':
    main()
