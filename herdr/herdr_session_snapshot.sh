#!/usr/bin/env bash
# Hourly LOCAL backup of five independent herdr families:
#   layout    ~/.config/herdr/session.json — workspaces, tabs, tab names, pane layout and cwd
#   agents    `herdr api snapshot` — which Claude Code session runs in which pane, with status and title
#   config    ~/.config/herdr/config.toml — your keybindings and settings (optional: skipped if absent)
#   tabstore  ~/.claude/state/state_claude_session_herdr_tabs.json — which session each tab last held,
#             what `hr` reads; nothing else backs it up (optional until the first session records)
#   grid      ~/.claude/state/state_claude_session_grid.json — the grid's parked cells and bookmarks
#             (optional: only if the grid is installed)
# Each family copies when its own content changed OR when the backup folder no longer holds a copy,
# and one failing never stops the others. Old copies are pruned, but the NEWEST of each family is
# never deleted, whatever its age.
#
# Destination: $HERDR_BACKUP_DIR, default ~/knowledge-worker-stack-backups/herdr. Its own state (checksums, the
# families-seen list): $HERDR_SNAPSHOT_STATE, default ~/.local/state/herdr-snapshot. Run log:
# ~/Library/Logs/knowledge-worker-stack/herdr_session_snapshot.log.
# A failed run (exit 1) or a repaired one (exit 2) alerts you: through mattermost_post.py (comms/)
# when installed, which posts to Mattermost if set up; else a macOS notification.
# Runs hourly from the LaunchAgent local.herdr.snapshot (herdr/README.md).
set -u
case "${1:-}" in
  "") ;;
  -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
  *) echo "herdr_session_snapshot.sh takes no arguments (--help for what it does)" >&2; exit 2 ;;
esac
# A scheduled job gets a bare PATH; add where herdr, python3, md5 and the agent tools live.
export PATH="${PATH:+$PATH:}/opt/homebrew/bin:/usr/local/bin:$HOME/bin:/usr/bin:/bin:/usr/sbin:/sbin"

DEST="${HERDR_BACKUP_DIR:-$HOME/knowledge-worker-stack-backups/herdr}"
STATE_DIR="${HERDR_SNAPSHOT_STATE:-$HOME/.local/state/herdr-snapshot}"
HERDR_HOME="${HERDR_HOME:-$HOME/.config/herdr}"
SRC="$HERDR_HOME/session.json"
SRC_CONFIG="$HERDR_HOME/config.toml"
SRC_TABSTORE="${HERDR_TAB_STORE:-$HOME/.claude/state/state_claude_session_herdr_tabs.json}"
SRC_GRID="$HOME/.claude/state/state_claude_session_grid.json"
SEEN="$STATE_DIR/families.seen"          # families that have ever existed at the destination
LOG="${HERDR_SNAPSHOT_LOG:-$HOME/Library/Logs/knowledge-worker-stack/herdr_session_snapshot.log}"
KEEP_DAYS=365
GRID_KEEP_DAYS=3653                      # the grid keeps ten years: parked cells and bookmarks are hand-built
LOG_KEEP_LINES=2000
mkdir -p "$DEST" "$STATE_DIR" "$(dirname "$LOG")" || { echo "cannot create $DEST or $STATE_DIR" >&2; exit 1; }
chmod 700 "$DEST" 2>/dev/null           # session ids, cwd paths and titles: yours only
TMPD=$(mktemp -d "${TMPDIR:-/tmp}/herdr-snapshot.XXXXXX") || exit 1
trap 'rm -rf "$TMPD"' EXIT

md5of() { if command -v md5 >/dev/null; then md5 -q "$@"; else cat "$@" | md5sum | cut -d' ' -f1; fi; }

# Which herdr session the snapshot came from: the session whose own directory holds session.json.
SESSION=$(herdr session list --json 2>/dev/null | python3 -c 'import json, os, sys
d = os.path.dirname(sys.argv[1])
print(next(s["name"] for s in json.load(sys.stdin)["sessions"] if s.get("session_dir") == d))' "$SRC" 2>/dev/null)
[ -n "$SESSION" ] || SESSION="default"

# The five families, each by the filename pattern that identifies it at the destination.
FAMILIES=("layout:herdr-*tabs-session.json" "agents:herdr-*agents.json" "config:herdr-*-global-config.toml" "tabstore:herdr-*tabstore.json" "grid:herdr-*grid.json")
pattern_of() { local f; for f in "${FAMILIES[@]}"; do [ "${f%%:*}" = "$1" ] && { echo "${f#*:}"; return; }; done; }
count_at_dest() { find "$DEST" -maxdepth 1 -type f -name "$(pattern_of "$1")" | wc -l | tr -d ' '; }
seen_has() { grep -qx "$1" "$SEEN" 2>/dev/null; }
seen_add() { seen_has "$1" || printf '%s\n' "$1" >> "$SEEN"; }

# A checksum gate compares against LOCAL state, which is not evidence of what the destination holds:
# delete a file there and the checksum still matches, so the gate says "no change" forever. So a
# family with zero files at the destination is always re-sent. If it had been there before (the
# families-seen list), that is a LOSS: the copy is repaired and the run exits 2 so you hear about it.
# A family never seen is a fresh destination, which is not a loss.
# copy_family <family> <file to copy> <name at destination> <checksum>
copy_family() {
  local fam="$1" file="$2" name="$3" sum="$4" n forced=0
  n=$(count_at_dest "$fam")
  if [ "$sum" = "$(cat "$STATE_DIR/$fam.md5" 2>/dev/null)" ] && [ "$n" -gt 0 ]; then
    echo "no change"; return 0
  fi
  [ "$n" -eq 0 ] && seen_has "$fam" && forced=1
  cp "$file" "$DEST/.$name.part" && mv "$DEST/.$name.part" "$DEST/$name" || { rm -f "$DEST/.$name.part"; echo "copy to $DEST failed"; return 1; }
  chmod 600 "$DEST/$name"
  printf '%s' "$sum" > "$STATE_DIR/$fam.md5"
  seen_add "$fam"
  [ $forced -eq 1 ] && { echo "LOUD: REPAIRED, the $fam family had 0 files in $DEST, re-sent as $name"; return 2; }
  echo "sent $name"
}

# Copy a source that may be mid-write, parse the copy as JSON, retry once on a torn read.
# json_copy <src> <tmp> <python expression over d, printed as the count>
json_copy() {
  local attempt out
  for attempt in 1 2; do
    cp "$1" "$2" 2>/dev/null || { echo "copy failed: $1"; return 1; }
    out=$(python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
print(eval(sys.argv[2]))' "$2" "$3" 2>/dev/null) && { echo "$out"; return 0; }
    [ "$attempt" = 2 ] && { echo "invalid JSON after retry: $1"; return 1; }
    sleep 2
  done
}

stamp=$(date +%Y%m%d_%H%M)

run_layout() {
  [ -r "$SRC" ] || { echo "source missing: $SRC (has the herdr server ever run?)"; return 1; }
  local counts
  # "spaces" is herdr's own word for workspaces; the counts show a layout's size without opening it.
  counts=$(json_copy "$SRC" "$TMPD/layout" '"%dspaces-%dtabs" % (len(d.get("workspaces", [])), sum(len(x.get("tabs", [])) for x in d.get("workspaces", [])))') || { echo "$counts"; return 1; }
  copy_family layout "$TMPD/layout" "herdr-$stamp-$SESSION-$counts-session.json" "$(md5of "$TMPD/layout")"
}

# The pane-to-session mapping. Gated on the MAPPING alone: agent status, focus and revision churn
# constantly, so a checksum of the whole document would copy every hour forever.
run_agents() {
  local attempt keyed
  for attempt in 1 2; do
    herdr api snapshot > "$TMPD/agents" 2>"$TMPD/agents.err" &&
    keyed=$(python3 - "$TMPD/agents" 2>/dev/null <<'PY'
import hashlib, json, sys
a = json.load(open(sys.argv[1]))["result"]["snapshot"]["agents"]
key = sorted([x["workspace_id"], x["tab_id"], x["pane_id"], x.get("agent"),
              (x.get("agent_session") or {}).get("value")] for x in a)
print(len(a), hashlib.md5(json.dumps(key).encode()).hexdigest())
PY
    ) && break
    [ "$attempt" = 2 ] && { echo "herdr api snapshot failed or returned invalid JSON: $(tr '\n' ' ' < "$TMPD/agents.err" | tail -c 200)"; return 1; }
    sleep 2
  done
  copy_family agents "$TMPD/agents" "herdr-$stamp-$SESSION-${keyed%% *}agents.json" "${keyed##* }"
}

# config.toml is machine-global, not per herdr session, so it takes the scope word "global".
run_config() {
  [ -f "$SRC_CONFIG" ] || { echo "no config.toml — nothing to back up"; return 0; }
  cp "$SRC_CONFIG" "$TMPD/config" || { echo "copy failed: $SRC_CONFIG"; return 1; }
  copy_family config "$TMPD/config" "herdr-$stamp-global-config.toml" "$(md5of "$TMPD/config")"
}

run_tabstore() {
  [ -f "$SRC_TABSTORE" ] || { seen_has tabstore && { echo "source missing: $SRC_TABSTORE"; return 1; }; echo "no tab store yet — nothing to back up"; return 0; }
  local count
  count=$(json_copy "$SRC_TABSTORE" "$TMPD/tabstore" 'len(d.get("tabs", {}))') || { echo "$count"; return 1; }
  copy_family tabstore "$TMPD/tabstore" "herdr-$stamp-$SESSION-${count}tabstore.json" "$(md5of "$TMPD/tabstore")"
}

run_grid() {
  [ -f "$SRC_GRID" ] || { seen_has grid && { echo "source missing: $SRC_GRID"; return 1; }; echo "no grid file — nothing to back up"; return 0; }
  local count
  count=$(json_copy "$SRC_GRID" "$TMPD/grid" 'sum(1 for e in d["workspaces"].values() for c in e["cells"] if c.get("uuid"))') || { echo "$count"; return 1; }
  copy_family grid "$TMPD/grid" "herdr-$stamp-$SESSION-${count}cells-grid.json" "$(md5of "$TMPD/grid")"
}

# Prune once per run, AFTER every copy, so "newest" is decided on the folder's final contents. The
# newest of a family is never deleted: every family is change-gated, so a file that never changes is
# never re-copied, and an age-only prune would delete the most STABLE file first with nothing to
# replace it. Newest is decided by NAME (the YYYYMMDD_HHMM stamp), which survives a copy or a touch.
# Afterwards, any family that had files before the prune and none after fails the run.
prune() {
  local f g fam pat days before newest doomed after deleted=0 kept="" rc=0
  for f in "${FAMILIES[@]}"; do
    fam=${f%%:*}; pat=${f#*:}; days=$KEEP_DAYS; [ "$fam" = grid ] && days=$GRID_KEEP_DAYS
    before=$(find "$DEST" -maxdepth 1 -type f -name "$pat")
    [ -n "$before" ] || continue
    kept="$kept $fam"
    newest=$(printf '%s\n' "$before" | LC_ALL=C sort | tail -n 1)
    doomed=$(find "$DEST" -maxdepth 1 -type f -name "$pat" -mtime "+$days")
    while IFS= read -r g; do
      [ -n "$g" ] && [ "$g" != "$newest" ] && [ -f "$g" ] || continue
      rm -f -- "$g" && deleted=$((deleted+1))
    done <<<"$doomed"
    after=$(find "$DEST" -maxdepth 1 -type f -name "$pat")
    [ -n "$after" ] || { echo "LOUD: SAFETY FAILURE, family $fam had files before this prune and none after"; rc=1; }
  done
  echo "kept newest of families ($kept ), deleted $deleted over-age"
  return $rc
}

out_layout=$(run_layout 2>&1);     rc_layout=$?
out_agents=$(run_agents 2>&1);     rc_agents=$?
out_config=$(run_config 2>&1);     rc_config=$?
out_tabstore=$(run_tabstore 2>&1); rc_tabstore=$?
out_grid=$(run_grid 2>&1);         rc_grid=$?
out_prune=$(prune 2>&1);           rc_prune=$?
rc=0; repaired=0                   # a real failure (1) always outranks a repair (2)
for r in $rc_layout $rc_agents $rc_config $rc_tabstore $rc_grid $rc_prune; do
  case $r in 0) ;; 2) repaired=1 ;; *) rc=1 ;; esac
done
[ $rc -eq 0 ] && [ $repaired -eq 1 ] && rc=2
out=$(printf 'layout: %s\n'   "$out_layout"
      printf 'agents: %s\n'   "$out_agents"
      printf 'config: %s\n'   "$out_config"
      printf 'tabstore: %s\n' "$out_tabstore"
      printf 'grid: %s\n'     "$out_grid"
      printf 'prune: %s\n'    "$out_prune")

# Append, never overwrite, so an earlier failure is not erased by a later success; capped.
printf '%s\n' "$out" | sed "s|^|$(date +%Y-%m-%dT%H:%M:%S) $SESSION |" >> "$LOG"
tail -n $LOG_KEEP_LINES "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG" || rm -f "$LOG.tmp"

# Alert through comms/'s mattermost_post.py when it is installed: it posts to Mattermost when that is
# set up and falls back to a macOS notification itself. Without it, a notification. Never a hard failure.
notify_user() {
  if command -v mattermost_post.py >/dev/null; then
    printf '%s\n' "$2" | mattermost_post.py "$1" >/dev/null 2>&1 && return 0
  fi
  osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' \
            "$1" "$2" >/dev/null 2>&1 || true
}
if [ $rc -eq 2 ]; then
  notify_user "herdr backup REPAIRED a missing copy" "$(grep 'LOUD' <<<"$out" | head -3)
Log: $LOG"
elif [ $rc -ne 0 ]; then
  notify_user "herdr backup FAILED" "$(grep -v -e ': no change$' -e 'nothing to back up$' -e '^prune: kept' <<<"$out" | head -6)
Log: $LOG"
fi
exit $rc
