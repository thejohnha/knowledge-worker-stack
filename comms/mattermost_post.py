#!/usr/bin/env python3
"""mattermost_post.py — tell the user something: a Mattermost post when Mattermost is set up,
else a macOS notification. Never fails hard: an alert that cannot be posted still shows on screen.

  mattermost_post.py "Subject" <<'MSG'        # body on stdin (may be empty)
  ...
  MSG
  mattermost_post.py --check                  # prove the config and the bot token; posts nothing

Config: ~/.config/knowledge-worker-stack/mattermost.env (KEY=value lines; comms/README.md):
  MM_URL      default http://localhost:8065
  MM_TEAM     the team name in the URL (needed only for MM_CHANNEL)
  MM_USER     your username: alerts go to your DM with the bot
  MM_CHANNEL  optional: a channel name in MM_TEAM to post alerts in instead of the DM
  MM_BOT      the bot's username, default chief
The bot token is never in that file: it is read from the agent vault entry "Mattermost bot"
(agent_get_credential) straight into memory, never printed.
Other scripts import this file for config(), token() and notify().
"""
import json, os, shutil, subprocess, sys, urllib.request

CONF = os.path.expanduser("~/.config/knowledge-worker-stack/mattermost.env")
VAULT_ENTRY = "Mattermost bot"
# By path when ~/bin is not on PATH yet (a fresh install, launchd): the vault tool lives beside these scripts.
GET_CREDENTIAL = shutil.which("agent_get_credential") or os.path.expanduser("~/bin/agent_get_credential")


def config():
    c = {"MM_URL": "http://localhost:8065", "MM_TEAM": "", "MM_USER": "", "MM_CHANNEL": "", "MM_BOT": "chief"}
    try:
        for line in open(CONF):
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                c[k.strip()] = v.strip().strip("'\"")
    except OSError:
        c["missing"] = True
    c["MM_URL"] = c["MM_URL"].rstrip("/")
    return c


def token():
    """The bot token from the agent vault, or None. Held in memory only."""
    try:
        p = subprocess.run([GET_CREDENTIAL, VAULT_ENTRY], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


def api(c, tok, method, path, body=None):
    req = urllib.request.Request(c["MM_URL"] + "/api/v4" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"null")


def target(c, tok):
    """The channel id alerts go to: MM_CHANNEL in MM_TEAM, else the DM between the bot and MM_USER."""
    if c["MM_CHANNEL"]:
        return api(c, tok, "GET", "/teams/name/%s/channels/name/%s" % (c["MM_TEAM"], c["MM_CHANNEL"]))["id"]
    me = api(c, tok, "GET", "/users/me")["id"]
    user = api(c, tok, "GET", "/users/username/" + c["MM_USER"])["id"]
    return api(c, tok, "POST", "/channels/direct", [me, user])["id"]


def post(subject, body=""):
    """Post to Mattermost. Returns None on success, else the reason it could not."""
    c = config()
    if c.get("missing") or not (c["MM_USER"] or c["MM_CHANNEL"]):
        return "Mattermost is not configured (%s)" % CONF
    tok = token()
    if not tok:
        return "no token in the agent vault entry '%s'" % VAULT_ENTRY
    text = "**%s**" % subject.strip() + ("\n\n" + body.strip() if body.strip() else "")
    try:
        api(c, tok, "POST", "/posts", {"channel_id": target(c, tok), "message": text[:15000]})
    except Exception as e:                                     # unreachable, asleep, a bad name: fall back
        return "%s: %s" % (type(e).__name__, e)
    return None


def banner(subject, body=""):
    """A macOS notification; the text goes in as arguments, so quotes in it cannot break the script."""
    subprocess.run(["/usr/bin/osascript", "-e", "on run argv", "-e",
                    "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
                    subject[:120], " ".join(body.split())[:240] or subject[:120]], capture_output=True)


def notify(subject, body=""):
    """Mattermost if it works, else a notification on this Mac. Returns where it went."""
    why = post(subject, body)
    if why is None:
        return "mattermost"
    banner(subject, body)
    return "notification (%s)" % why


def main():
    if sys.argv[1:] == ["--check"]:
        c = config()
        if c.get("missing"):
            sys.exit("no %s; see comms/README.md" % CONF)
        tok = token() or sys.exit("no token in the agent vault entry '%s'" % VAULT_ENTRY)
        try:
            me = api(c, tok, "GET", "/users/me")
            print("token ok: bot @%s at %s; alerts go to channel %s" % (me["username"], c["MM_URL"], target(c, tok)))
        except Exception as e:
            sys.exit("check failed at %s: %s: %s" % (c["MM_URL"], type(e).__name__, e))
        return
    if len(sys.argv) != 2 or sys.argv[1].startswith("-"):
        sys.exit(__doc__)
    body = "" if sys.stdin.isatty() else sys.stdin.read()
    print(notify(sys.argv[1], body))


if __name__ == "__main__":
    main()
