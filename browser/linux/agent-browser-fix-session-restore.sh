#!/usr/bin/env bash
# agent-browser-fix-session-restore.sh: ExecStartPre for agent-browser.service. Makes Chrome's OWN session
# restore reliable. Runs before Chrome starts, so Preferences is not being written underneath us.
#
# Four jobs, all in ONE read-modify-write of Preferences ending in ONE atomic write (tempfile + fsync +
# os.replace in the same directory), so a kill or power loss mid-write never leaves a half-written file that
# Chrome would discard along with every setting in it:
#  1. Leave Default/Sessions/ alone. That directory IS the window/tab list restore reads.
#  2. Repair the crash marker. Chrome writes profile.exit_type="Crashed" at startup and rewrites it on a clean
#     exit; if it still reads "Crashed" at launch, restore is skipped ENTIRELY, whatever --restore-last-session
#     or session.restore_on_startup say. Restart=always exists for crashes, so without this the one restart
#     nobody controls is the one that loses every tab.
#  3. Set session.restore_on_startup=1 ("Continue where you left off"), the same restore the flag asks for,
#     stored in the profile. Flag and preference together do not double-restore.
#  4. Pin the permission policy (below).
#
# LOOP GUARD. Chrome's crash-skip also stops a page that CRASHED the browser from being reopened and crashing
# it again. So the marker is repaired at most 3 times in 10 minutes; past that "Crashed" stays, restore is
# skipped, the poison tab is dropped, and systemd's own start limit turns a loop into a stopped unit. The guard
# gates ONLY the exit_type repair.
set -u

PREFS=${BROWSE_PREFS:-/home/browser/browser-profiles/main/Default/Preferences}
STATE=${BROWSE_CRASHFIX_STATE:-/run/agent-browser/crashfix}   # under /run: the window resets on reboot, which is correct
WINDOW=600                                 # seconds
LIMIT=3                                    # repairs allowed inside WINDOW

now=$(date +%s)
recent=0
[ -f "$STATE" ] && recent=$(awk -v cutoff=$((now - WINDOW)) '$1 > cutoff' "$STATE" | wc -l)

allow_repair=1
if [ "$recent" -ge "$LIMIT" ]; then
  echo "agent-browser: $recent crash-repairs in ${WINDOW}s — suspected crash loop, leaving exit_type alone (no restore this start)" >&2
  allow_repair=0
fi

[ -f "$PREFS" ] || exit 0                  # first boot / wiped profile: nothing to repair or seed

# Permission policy: resolve every content-setting category this box has an opinion on, so none is left at
# Chrome's stock "ask". A permission bubble is invisible to CDP, to page JS and to X11, and a page blocked by
# one reports success, so the only real fix is to never let the prompt appear. Block suppresses a prompt as
# well as allow does: grant only what is used, block the rest. Keys and values are Chrome's own, read back
# from what Chrome wrote after setting each in its UI. 1=allow, 2=block.
changed=$(python3 - "$PREFS" "$allow_repair" <<'PY'
import json, os, sys, tempfile

f, allow_repair = sys.argv[1], sys.argv[2] == "1"
try:
    p = json.load(open(f))
except Exception:
    sys.exit(0)                            # unreadable/partial: leave it, Chrome rebuilds it

prof = p.setdefault("profile", {})
changed = []

if allow_repair and prof.get("exit_type") == "Crashed":
    prof["exit_type"] = "Normal"
    changed.append("exit_type")

sess = p.setdefault("session", {})
if sess.get("restore_on_startup") != 1:
    sess["restore_on_startup"] = 1         # 1 = "Continue where you left off" (Chrome's own value)
    changed.append("restore_on_startup")

policy = {
    "automatic_downloads": 1,              # allow: pages that download several files at once
    "clipboard": 1,                        # allow: pages that read the clipboard never raise a bubble
    "notifications": 2,                    # block: never wanted on an automation box
    "geolocation": 2,                      # block
    "media_stream_camera": 2,              # block (the real key, not "camera")
    "media_stream_mic": 2,                 # block (the real key, not "microphone")
}
dcv = prof.setdefault("default_content_setting_values", {})
if not all(dcv.get(k) == v for k, v in policy.items()):
    dcv.update(policy)
    changed.append("policy")

if not changed:
    sys.exit(0)                            # nothing to do: no write, stays idempotent

tmp = None
try:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(f) or ".")
    with os.fdopen(fd, "w") as fh:
        json.dump(p, fh)
        fh.flush()
        os.fsync(fh.fileno())              # durable before the rename
    os.replace(tmp, f)                     # atomic: readers see old or new, never a half-file
except Exception as e:
    if tmp:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    print(f"write failed, left unpatched: {e}", file=sys.stderr)
    sys.exit(0)                            # never fail the unit over a Preferences write

print("\n".join(changed))
PY
)

case "$changed" in
  *exit_type*)
    echo "agent-browser: exit_type Crashed -> Normal, session will restore"
    echo "$now" >> "$STATE"
    awk -v cutoff=$((now - WINDOW)) '$1 > cutoff' "$STATE" > "$STATE.tmp" 2>/dev/null && mv "$STATE.tmp" "$STATE"
    ;;
esac
case "$changed" in
  *restore_on_startup*) echo "agent-browser: session.restore_on_startup set to 1 (Continue where you left off)" ;;
esac
case "$changed" in
  *policy*) echo "agent-browser: permission policy applied/refreshed in Preferences" ;;
esac
exit 0
