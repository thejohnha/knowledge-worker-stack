#!/usr/bin/env bash
# <uuid> -> the full path of that session's transcript, whichever project folder holds it.
#   claude_session_transcript.sh <uuid>          prints the .jsonl path
#   claude_session_transcript.sh <uuid> --cwd    prints the directory the session was launched in
# Claude Code files a transcript under <config dir>/projects/<launch dir with / and . turned into ->,
# so a session started anywhere but one folder is invisible to any path that names that folder.
# Every config dir is searched: ~/.claude, $CLAUDE_CONFIG_DIR, and each account in
# ~/.config/knowledge-worker-stack/accounts.json. Folders reached twice through a symlink count once; dot
# folders (a sync tool's version store) are skipped.
# rc 1 = no transcript anywhere, rc 2 = the same uuid in several folders (refused, never guessed).
# ONE resolver, so cr, hr and herdr_session_manage.sh cannot drift apart.
u=${1:-}; want=${2:-}
[[ "$u" =~ ^[0-9a-f-]{36}$ ]] || { echo "need a full session uuid" >&2; exit 1; }
exec python3 - "$u" "$want" <<'PY'
import glob, json, os, sys
u, want = sys.argv[1], sys.argv[2]
home = os.path.expanduser("~")
dirs = [os.path.join(home, ".claude")]
if os.environ.get("CLAUDE_CONFIG_DIR"): dirs.append(os.environ["CLAUDE_CONFIG_DIR"])
try: acc = json.load(open(os.path.join(home, ".config/knowledge-worker-stack/accounts.json")))
except Exception: acc = {}
if isinstance(acc, dict): dirs += [os.path.expanduser(v) for v in acc.values() if isinstance(v, str)]
hits, seen = [], set()
for d in dirs:
    for f in sorted(glob.glob(os.path.join(d, "projects", "*", u + ".jsonl"))):   # glob skips dot folders
        r = os.path.realpath(f)
        if r in seen: continue
        seen.add(r); hits.append(f)
if not hits:
    sys.exit(print(f"no transcript for {u} under any Claude Code projects folder", file=sys.stderr) or 1)
if len(hits) > 1:
    sys.exit(print(f"uuid {u} in {len(hits)} project folders: {' '.join(hits)}", file=sys.stderr) or 2)
j = hits[0]
if want != "--cwd":
    print(j); sys.exit(0)
# The transcript's own records carry the launch cwd verbatim; the folder name is a lossy encoding.
with open(j, encoding="utf-8", errors="replace") as fh:
    for n, line in enumerate(fh):
        if n > 200: break
        try: c = json.loads(line).get("cwd")
        except Exception: continue
        if c: print(c); sys.exit(0)
sys.exit(print(f"no cwd recorded in {j}", file=sys.stderr) or 1)
PY
