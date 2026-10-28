#!/usr/bin/env bash
# claude_memory_snapshot.sh — hourly local backup of Claude Code's auto-memory, with history.
#
# Copies every project's memory folder (<config dir>/projects/<project>/memory/, for ~/.claude and
# every account in ~/.config/knowledge-worker-stack/accounts.json) into a local git repository and commits only
# when something changed, so every earlier state of every memory file can be got back with git.
# Nothing leaves the Mac: the repository has no remote.
#
# Destination: $CLAUDE_MEMORY_BACKUP_DIR, default ~/knowledge-worker-stack-backups/claude-memory.
# Run log: ~/.claude/state/state_claude_memory_snapshot.log (last run only).
# Also watches the memory INDEX (MEMORY.md): Claude Code loads only its first 200 lines or 25,000
# characters, whichever comes first, and a file past that keeps everything while new sessions
# silently stop seeing the tail. A failed run, or an index near either ceiling (at most once a day),
# alerts you through mattermost_post.py (comms/) when it is on PATH, else a macOS notification.
set -u
PATH="$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DEST="${CLAUDE_MEMORY_BACKUP_DIR:-$HOME/knowledge-worker-stack-backups/claude-memory}"
STATE="$HOME/.claude/state"
LOG="$STATE/state_claude_memory_snapshot.log"
STAMP="$STATE/state_claude_memory_index_warned"
mkdir -p "$STATE"

config_dirs() {
  echo "$HOME/.claude"
  jq -r 'if type=="object" then .[] | strings else empty end' ~/.config/knowledge-worker-stack/accounts.json 2>/dev/null | sed "s|^~|$HOME|"
}

notify_user() {   # $1 subject, $2 body
  if command -v mattermost_post.py >/dev/null 2>&1; then
    printf '%s\n' "$2" | mattermost_post.py "$1" >/dev/null 2>&1 && return 0
  fi
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' \
            "$1" "${2:0:200}" >/dev/null 2>&1 || true
}

run() {
  mkdir -p "$DEST" && chmod 700 "$DEST" || { echo "cannot create $DEST"; return 1; }
  [ -d "$DEST/.git" ] || git -C "$DEST" init -q || { echo "git init failed in $DEST"; return 1; }
  local d proj found=0
  # One folder per config dir and project (<config dir>/<project>/memory). Real paths only, so a config
  # dir that links its projects/ to another one is copied once.
  for proj in $(config_dirs | while IFS= read -r d; do ls -d "$d"/projects/*/memory 2>/dev/null; done | xargs -n1 realpath 2>/dev/null | sort -u); do
    found=1
    name="$(basename "$(dirname "$(dirname "$(dirname "$proj")")")")/$(basename "$(dirname "$proj")")"   # <config dir>/<project>
    mkdir -p "$DEST/$name"
    rsync -a --delete "$proj/" "$DEST/$name/memory/" || { echo "rsync failed for $proj"; return 1; }
  done
  [ "$found" = 1 ] || { echo "no memory folders found — nothing to back up"; return 0; }
  git -C "$DEST" add -A || return 1
  if git -C "$DEST" diff --cached --quiet; then echo "no change — nothing to commit"; return 0; fi
  git -C "$DEST" -c user.name="claude memory snapshot" -c user.email="snapshot@localhost" \
      commit -q -m "snapshot: $(date +%F)" || return 1
  echo "committed: $(git -C "$DEST" rev-parse --short HEAD)"
}

# Index ceilings, logged every run; an alert at most once a day, never failing the snapshot over it.
# The 25,000 limit counts JavaScript string length (UTF-16 units), not bytes.
index_guard() {
  local idx units lines warned=""
  for idx in $(config_dirs | while IFS= read -r d; do ls "$d"/projects/*/memory/MEMORY.md 2>/dev/null; done | xargs -n1 realpath 2>/dev/null | sort -u); do
    units=$(python3 -c "import sys; t=open(sys.argv[1], encoding='utf-8').read().strip(); print(sum(2 if ord(c)>0xFFFF else 1 for c in t))" "$idx")
    lines=$(wc -l < "$idx" | tr -d ' ')
    echo "index $(basename "$(dirname "$(dirname "$(dirname "$(dirname "$idx")")")")")/$(basename "$(dirname "$(dirname "$idx")")"): ${units}/25000 units, ${lines}/200 lines"
    { [ "$units" -ge 24000 ] || [ "$lines" -ge 190 ]; } && warned="$warned
$idx: $units of 25000 units, $lines of 200 lines"
  done
  [ -n "$warned" ] || return 0
  [ "$(cat "$STAMP" 2>/dev/null)" = "$(date +%F)" ] && return 0
  notify_user "Claude memory index near its ceiling" "Past either ceiling, the entries at the end of MEMORY.md stop loading into new sessions. Retire finished entries.$warned" \
    && date +%F > "$STAMP"
  return 0
}

out=$({ echo "=== $(date) ==="; run; } 2>&1); rc=$?
guard_out=$(index_guard 2>&1)
printf '%s\n%s\n' "$out" "$guard_out" > "$LOG"

if [ $rc -ne 0 ]; then
  notify_user "Claude memory snapshot FAILED" "$(tail -5 <<<"$out")
Log: $LOG"
fi
exit $rc
