#!/usr/bin/env python3
"""claude_chief_of_staff_phone_bridge.py — text the chief of staff from your phone over Mattermost.

You DM the bot (MM_BOT) on your Mattermost; this daemon types the text into the chief of staff
session with `herdr_session_manage.sh tell`, waits for the chief's turn to end, and posts the chief's
reply back into the same DM. The chief is found by claude_chief_of_staff_find.py.

Only posts by your own Mattermost user (MM_USER) reach the chief; anything else in the DM is ignored.
While you have texted within FORWARD_WINDOW, the chief's final reply from every OTHER finished turn
(a session reporting back, a background task ending) is posted to you too, so a result the chief
promised reaches the phone without you asking again. The hourly wake's reply never is: it mostly
repeats the same reminders, and real news from a pass is pushed with --post. A turn counts as finished
when Claude Code writes its turn_duration record, or the next prompt begins. A message another session
sends the chief is written as a meta record, like a Stop-hook nudge; it starts a new turn when it lands
after the chief's turn ended, and joins the running turn when it lands mid-turn.
While you are working at this Mac (keyboard or mouse used within AWAY, and more recently than your last
text), neither those forwards nor --post reach the phone: you are reading the chief at the desk. Held
forwards are not replayed later. The chief's answer to your own text always posts: you asked from the
phone. If the idle time can't be read, everything posts.
A post that fails on the network or a 5xx is retried for about 9 minutes (RETRY), checking first that
the last try didn't land, so a blip never loses an answer and never doubles one. One that still fails
goes into the outbox and is posted, oldest first and marked delayed with the time it was written, as
soon as Mattermost answers again — unless the bot already posted the same text since, so nothing
doubles. --post tries for a few seconds only, then queues.
Messages that arrive while the chief is busy are batched into one delivery, and held (across restarts)
until it is free. A stopped chief is resumed: unlike the hourly wake, a text is a request to talk to it.

Topic threads (THREADS): each topic is one thread in the DM. The chief opens its final text with a tag
line, `[topic: trip-dates | Trip dates]` (title only needed the first time); the bridge strips
the line — always, even with threads off — and posts into that topic's thread, opening it with a
"**Trip dates**" root post if new (no title, or one that is just the key: the answer's bold
opener, else its first words). Your text from inside a thread reaches the chief with its topic; a
top-level text arrives marked as one, and the chief may file it under an existing topic: the answer
then goes to that thread with a link to it where you asked. An untagged answer goes where you asked; an
untagged forward or push goes top-level. If anything about a thread post fails, the text posts
top-level instead, exactly as with threads off.

Verbs:
  (none)      run the poll loop — what the launchd agent runs
  --setup     create the bot in the local Mattermost (mmctl in the container), mint its token straight
              into the agent vault (never printed)
  --check     prove the token, the DM channel and the chief lookup, then post one test line
  --post      post stdin to your DM as the bot and return — a push from inside a turn, before it
              ends (no tell, no wait, safe inside the chief's own turn):
                claude_chief_of_staff_phone_bridge.py --post <<'MSG'
                **Trip dates:** the second option is in.
                MSG
              --post --topic KEY (or "KEY | Title") posts into that topic's thread; same as a tag line.
              While you are active at this Mac it posts nothing, prints a line starting "held:" and
              exits 0, so the chief puts the message in its chat reply instead.
              A turn's final reply is not posted when it repeats, word for word, something the
              bot already posted since that turn began.
  --topics    list the topic threads: key, title, link
  --rename KEY 'Title'  retitle a topic: the topics file, and the thread's first post if the bot wrote it
  --threads   show, or set with `on` / `off`, whether topic threads are used — one command, no restart

Config: ~/.config/knowledge-worker-stack/mattermost.env (MM_URL, MM_TEAM, MM_USER, MM_BOT; comms/README.md); the
token from the agent vault entry "Mattermost bot".
State: ~/.claude/state/state_claude_chief_of_staff_phone_bridge.json (last post seen, and how far into the
chief's transcript replies were forwarded, so a restart never replays). Topics: ..._topics.json beside
it (key -> root post and title; locked, since --post writes it too); _threads (on/off, else THREADS);
_outbox.json (posts waiting for Mattermost to come back; locked).
Log: ~/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_phone_bridge.log (launchd sends stderr there; --post writes it too).
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime

sys.path.append(os.path.dirname(os.path.realpath(__file__)))   # after the standard library: ~/bin cannot shadow it
import claude_chief_of_staff_find as finder
import mattermost_post

CONF = mattermost_post.config()
BASE = CONF["MM_URL"]
BOT = CONF["MM_BOT"]
USER = CONF["MM_USER"]            # your Mattermost username: the other side of the DM
TEAM = CONF["MM_TEAM"]
ENTRY = mattermost_post.VAULT_ENTRY
COMPOSE = os.path.expanduser(os.environ.get("MM_COMPOSE_DIR", "~/mattermost"))
STATE_DIR = os.path.expanduser("~/.claude/state")
os.makedirs(STATE_DIR, exist_ok=True)
STATE = os.path.join(STATE_DIR, "state_claude_chief_of_staff_phone_bridge.json")
LOG = os.path.expanduser("~/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_phone_bridge.log")
os.makedirs(os.path.dirname(LOG), exist_ok=True)
TOPICS = os.path.join(STATE_DIR, "state_claude_chief_of_staff_phone_bridge_topics.json")
THREADS = True                    # default when --threads was never set; False posts everything top-level
SWITCH = os.path.join(STATE_DIR, "state_claude_chief_of_staff_phone_bridge_threads")
OUTBOX = os.path.join(STATE_DIR, "state_claude_chief_of_staff_phone_bridge_outbox.json")
QUICK = (2, 5)                    # --post's retries before it queues: never hangs the chief's turn
TAG = re.compile(r"\A\s*\[topic:\s*([A-Za-z0-9][\w.-]{0,40})\s*(?:\|\s*([^\]\n]{1,80}?))?\s*\][ \t]*(?:\n|\Z)")
POLL = 5                          # seconds between Mattermost polls
STILL_WORKING = 20 * 60           # tell the user once the chief has been at it this long
GIVE_UP = 3 * 3600                # stop waiting for a reply after this
FORWARD_WINDOW = 2 * 3600         # forward the chief's other replies while the user texted this recently
AWAY = 10 * 60                    # keyboard/mouse idle this long: the user is away from this Mac
PREFIX = "From the user via Mattermost (their phone; your reply is posted back to them there, so keep it short): "
RETRY = (5, 15, 30, 60, 120, 300)  # seconds between tries of a failed post: rides out a ~9 min outage
WAKE = "Scheduled wake (claude_chief_of_staff_wake.sh"   # its reply is never forwarded: it repeats reminders
AUTOMATED = ("from_webhook", "from_bot", "from_plugin", "override_username")


def log(msg):
    print(f"{datetime.now():%F %T} {msg}", file=sys.stderr, flush=True)   # launchd routes stderr to LOG


# --- Mattermost --------------------------------------------------------------------------------
class Unreachable(Exception):
    """Mattermost could not be reached for a post through every retry."""


class MM:
    def __init__(self, token):
        self._t = token                             # held in memory only; never logged
        self._me = None
        self.retry = RETRY                          # waits between tries of one post

    def api(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(BASE + "/api/v4" + path, data=data, method=method, headers={
            "Authorization": "Bearer " + self._t, "Content-Type": "application/json",
            "User-Agent": "claude-chief-phone-bridge/1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"null")

    def post(self, channel, text, root=""):
        first = None
        for i in range(0, max(len(text), 1), 15000):  # Mattermost caps a post at 16,383 chars
            body = {"channel_id": channel, "message": text[i:i + 15000]}
            if root:
                body["root_id"] = root                # a reply inside that thread
            first = first or self.create(body)
        return first

    def create(self, body):
        """POST one post, retried through a network failure or a 5xx. Before each retry it looks for the
        post first: a timeout can come after Mattermost saved it, and pending_post_id dedupes for 30 s only.
        A 4xx (a refusal, such as a dead thread) raises at once."""
        body["pending_post_id"] = uuid.uuid4().hex
        t0 = int(time.time() * 1000) - 2000
        for wait in tuple(self.retry) + (None,):
            try:
                return self.api("POST", "/posts", body)["id"]
            except urllib.error.HTTPError as e:
                if e.code < 500:
                    raise
                err = e
            except (OSError, ValueError) as e:      # URLError and TimeoutError are OSErrors
                err = e
            if wait is None:
                raise Unreachable(repr(err))
            log(f"post failed ({err!r}); retrying in {wait} s")
            time.sleep(wait)
            landed = self.landed(body, t0)
            if landed:
                return landed
        raise Unreachable(repr(err))

    def landed(self, body, t0):
        """The id of a post matching `body` saved since t0 by this bot, or None (also if it can't look)."""
        try:
            self._me = self._me or self.api("GET", "/users/me")["id"]
            r = self.api("GET", f"/channels/{body['channel_id']}/posts?since={t0}")
            return next((i for i, p in r["posts"].items() if p["user_id"] == self._me and p["message"] == body["message"]
                         and (p.get("root_id") or "") == body.get("root_id", "")), None)
        except Exception:
            return None


def token():
    p = subprocess.run([mattermost_post.GET_CREDENTIAL, ENTRY], capture_output=True, text=True)
    if p.returncode or not p.stdout.strip():
        sys.exit(f"no token in the agent vault entry '{ENTRY}' — run --setup first")
    return p.stdout.strip()


def connect():
    if not USER:
        sys.exit(f"MM_USER is not set in {mattermost_post.CONF}")
    mm = MM(token())
    me = mm.api("GET", "/users/me")
    user = mm.api("GET", f"/users/username/{USER}")
    dm = mm.api("POST", "/channels/direct", [me["id"], user["id"]])
    return mm, me["id"], user["id"], dm["id"]


# --- the chief ---------------------------------------------------------------------------------
def chief():
    """(uuid, pane, status) of the live chief; (uuid, None, 'stopped') for a stopped one; else None."""
    c = finder.find()
    if c[0] == "live":
        return c[1], c[2], c[4]
    if c[0] == "stopped":
        return c[1], None, "stopped"               # tell resolves any member to the lineage's latest
    return None


def status_of(uuid):
    c = chief()
    return c[2] if c and c[0] == uuid else "gone"


def transcript(uuid):
    return finder.transcript(uuid)


def is_prompt(r, after_end=False):
    """A record that starts a turn: typed, told, a task notification or the wake — not a tool result
    or a compaction summary. A meta record (a Stop-hook nudge, a skill body, another session's message)
    starts one only after_end, when the turn before it is over; mid-turn it belongs to that turn."""
    if r.get("type") != "user" or r.get("isSidechain") or r.get("isCompactSummary"):
        return False
    if r.get("isMeta") and not after_end:
        return False
    c = (r.get("message") or {}).get("content")
    return isinstance(c, str) or (isinstance(c, list) and not any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in c))


def turn_starts(recs):
    """Indexes of the records in `recs` that start a turn; recs[0] is taken to be inside a turn."""
    ended = False
    for i, r in enumerate(recs):
        if is_prompt(r, ended):
            yield i
            ended = False
        elif r.get("type") == "system" and r.get("subtype") == "turn_duration":
            ended = True


def records(path):
    out = []
    for raw in open(path, encoding="utf-8", errors="replace").read().splitlines():
        try:
            out.append(json.loads(raw))
        except ValueError:
            out.append({})                           # keep indexes aligned with transcript lines
    return out


def reply_after(path, record):
    """The chief's answer to the prompt at line `record` (1-based, so records after it start there)."""
    try:
        return reply_in(records(path)[record:])
    except OSError:
        return "", None


def reply_in(recs):
    """The reply in the records after a prompt: the text written after the turn's LAST tool call (the
    narration before tool calls is progress chatter, not the answer), stopping at the next prompt.
    Returns (text, question) — question is a pending AskUserQuestion's text when the turn stopped on one."""
    texts, question = [], None
    for r in recs[:next(turn_starts(recs), len(recs))]:
        if r.get("isSidechain") or r.get("type") != "assistant":
            continue
        for b in r.get("message", {}).get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text" and b.get("text", "").strip():
                texts.append(b["text"].strip())
            elif b.get("type") == "tool_use":
                texts = []                           # anything before a tool call was not the answer
                if b.get("name") == "AskUserQuestion":
                    qs = (b.get("input") or {}).get("questions") or []
                    question = "\n\n".join(
                        q.get("question", "") + "\n" + "\n".join(f"- {o.get('label')}: {o.get('description', '')}"
                                                         for o in q.get("options") or []) for q in qs)
                else:
                    question = None
    return "\n\n".join(texts), question


def norm(s):
    return " ".join(s.split())


def already_pushed(answer, pushed):
    """True when `answer` repeats what the bot already posted this exchange (the chief pushed it with
    --post), so the bridge does not post it twice. Long pushes arrive in 15,000-char pieces."""
    a = norm(split_tag(answer)[2])
    return bool(a) and (a in {norm(p) for p in pushed} or a == norm("".join(pushed)))


def prompt_text(r):
    c = (r.get("message") or {}).get("content")
    return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict))


def to_forward(recs, start):
    """([(reply, prompt_timestamp)], new_start): replies of the turns from `start` on that have finished
    and were not started by the user's text (exchange() answers those). An unfinished turn stops the scan."""
    idx = [i for i in turn_starts(recs) if i >= start]
    out, new = [], start
    for a, b in zip(idx, idx[1:] + [None]):
        body = recs[a + 1:b]
        if b is None and not any(r.get("type") == "system" and r.get("subtype") == "turn_duration" for r in body):
            break
        reply, pt = reply_in(body)[0], prompt_text(recs[a])
        if reply and not pt.startswith(PREFIX) and WAKE not in pt[:300]:
            out.append((reply, recs[a].get("timestamp", "")))
        new = b if b is not None else len(recs)
    return out, new


def in_window(user_at_ms, now):
    return now * 1000 - user_at_ms < FORWARD_WINDOW * 1000


def hid_idle():
    """Seconds since the last keyboard or mouse input on this Mac (IOHIDSystem HIDIdleTime), or None."""
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=10).stdout
        return int(next(ln for ln in out.splitlines() if '"HIDIdleTime"' in ln).split("=")[-1]) / 1e9
    except (OSError, subprocess.SubprocessError, StopIteration, ValueError):
        return None


def at_mac(user_at_ms, now=None):
    """True while the user is working at this Mac: input within AWAY and after their last phone text (a text
    means they left the desk, even a minute after their last keystroke). Unreadable idle time: False, so posts go out."""
    idle = hid_idle()
    if idle is None:
        return False
    now = time.time() if now is None else now
    return idle < AWAY and (now - idle) * 1000 > user_at_ms


def user_last(mm, dm, uid):
    """When the user last posted in the DM, in ms (0 if not among the last 100 posts)."""
    r = mm.api("GET", f"/channels/{dm}/posts?per_page=100")
    return max((p["create_at"] for p in r["posts"].values() if p["user_id"] == uid), default=0)


def split_tag(text):
    """(key, title, body): the chief's leading `[topic: key | Title]` line, taken off the text."""
    m = TAG.match(text)
    if not m:
        return None, None, text.strip()
    return m.group(1).lower(), (m.group(2) or "").strip() or None, text[m.end():].strip()


def threads():
    """Whether topic threads are on: what --threads last set, else THREADS."""
    try:
        return {"on": True, "off": False}.get(open(SWITCH).read().strip(), THREADS)
    except OSError:
        return THREADS


def set_threads(value):
    with tempfile.NamedTemporaryFile("w", dir=os.path.dirname(SWITCH), delete=False) as f:
        f.write(value + "\n")
    os.replace(f.name, SWITCH)


def link(post_id):
    return f"{BASE}/{TEAM}/pl/{post_id}"


def topics(path=None):
    try:
        return json.load(open(path or TOPICS))
    except (OSError, ValueError):
        return {}


def readable_title(key, title, body):
    """A new topic's title: the one given, unless it is missing or just a numbered key ("t30" means nothing
    on a phone; "Garden" for garden is fine); then the answer's bold opener ("**Trip dates:** ..."), else its first words."""
    if title and not (title.lower() == key and re.search(r"\d", key)):
        return title
    m = re.match(r"\*\*([^*\n]{2,80}?):?\*\*", body)
    if m:
        return m.group(1).strip()
    words = re.sub(r"[*_`#>\[\]]", "", body).split()
    short = " ".join(words[:7])
    return (short + "…" if len(words) > 7 else short) or title or key


def rename(mm, bot_id, key, title, path=None):
    """--rename: retitle topic `key` in the topics file and, when the bot wrote the thread's root post,
    in that post too. True if the root post was edited (the user's own root text is never touched)."""
    path = path or TOPICS
    with open(path + ".lock", "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        t = topics(path)
        if key not in t:
            sys.exit(f"--rename: no topic '{key}'; --topics lists them")
        root = mm.api("GET", f"/posts/{t[key]['root']}")
        edited = root["user_id"] == bot_id
        if edited:
            mm.api("PUT", f"/posts/{root['id']}/patch", {"message": f"**{title}**"})
        t[key]["title"] = title
        with tempfile.NamedTemporaryFile("w", dir=os.path.dirname(path), delete=False) as f:
            json.dump(t, f, indent=1)
        os.replace(f.name, path)
        return edited


def topic_root(mm, dm, key, title, ask_root, path=None):
    """(root, title, opened) of topic `key`. A new key adopts the thread the user asked in, else opens a
    thread with a "**Title**" root post. Locked, so the daemon and a --post never open it twice."""
    path = path or TOPICS
    with open(path + ".lock", "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        t = topics(path)
        if key in t:
            return t[key]["root"], t[key]["title"], False
        title = title or key
        root = ask_root or mm.post(dm, f"**{title}**")
        t[key] = {"root": root, "title": title}
        with tempfile.NamedTemporaryFile("w", dir=os.path.dirname(path), delete=False) as f:
            json.dump(t, f, indent=1)
        os.replace(f.name, path)
        return root, title, not ask_root


def deliver(mm, dm, text, ask_root=None, path=None):
    """Post the chief's text. ask_root: where the user asked — the thread's root, "" for top level, None for
    a forward or push. With THREADS off only the tag line is taken off: everything posts top-level."""
    key, title, body = split_tag(text)
    if not threads():
        return mm.post(dm, body)
    try:
        if not key:
            return mm.post(dm, body, root=ask_root or "")
        root, title, opened = topic_root(mm, dm, key, readable_title(key, title, body), ask_root, path)
        pid = mm.post(dm, body, root=root)
    except Unreachable:
        raise                                        # Mattermost is down: top-level would fail the same way
    except Exception as e:                           # any threading failure: top-level, exactly as before
        log(f"thread post failed, posted top-level instead: {e!r}")
        return mm.post(dm, body)
    if ask_root is not None and root != ask_root and not opened:
        try:
            mm.post(dm, f"**{title}:** answered in its thread: {link(pid)}", root=ask_root)
        except Exception as e:                       # the answer is already out; never post it twice
            log(f"thread link failed: {e!r}")
    return pid


def locked_json(path, change):
    """Read the JSON list at `path`, apply change(list) under a lock, write it back; returns change's result."""
    with open(path + ".lock", "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        try:
            data = json.load(open(path))
        except (OSError, ValueError):
            data = []
        out = change(data)
        with tempfile.NamedTemporaryFile("w", dir=os.path.dirname(path), delete=False) as f:
            json.dump(data, f, indent=1)
        os.replace(f.name, path)
        return out


def send(mm, dm, text, ask_root=None):
    """deliver(), or the outbox when Mattermost can't be reached through every retry. True if posted."""
    try:
        deliver(mm, dm, text, ask_root)
        return True
    except Unreachable as e:
        locked_json(OUTBOX, lambda q: q.append({"text": text, "ask_root": ask_root, "at": int(time.time() * 1000)}))
        log(f"outbox: queued {len(text)} chars, Mattermost unreachable ({e})")
        return False


def delayed(text, at_ms):
    """The text with a delay note under its tag line, so the tag still routes it."""
    t, m = datetime.fromtimestamp(at_ms / 1000), TAG.match(text)
    when = f"{t:%-I:%M %p}" + ("" if t.date() == datetime.now().date() else f", {t:%a %b %-d}")
    head = text[:m.end()].rstrip("\n") + "\n" if m else ""
    return f"{head}_Delayed: written {when}, while Mattermost was unreachable._\n\n{text[len(head):].strip()}"


def flush(mm, dm, bot_id):
    """Post the outbox, oldest first, one try each; stop at the first failure so the order holds. A text
    the bot already posted since it was queued is dropped instead."""
    q = locked_json(OUTBOX, lambda q: list(q))
    if not q:
        return
    old = getattr(mm, "retry", RETRY)
    mm.retry = ()
    try:
        for item in q:
            if already_pushed(item["text"], bot_posts_since(mm, dm, bot_id, item["at"] - 2000)):
                log("outbox: already posted since, dropped")
            else:
                try:
                    deliver(mm, dm, delayed(item["text"], item["at"]), item.get("ask_root"))
                except Unreachable:
                    return                           # still down: the rest wait, in order
                log(f"outbox: delivered {len(item['text'])} chars, delayed")
            locked_json(OUTBOX, lambda cur: cur.remove(item) if item in cur else None)
    finally:
        mm.retry = old


def topic_note(mm, root, path=None):
    """What the chief is told about where the user's text came from (THREADS on)."""
    if not root:
        return "[top-level text: tag your answer with an existing topic (--topics) or a new one] "
    for k, v in topics(path).items():
        if v["root"] == root:
            return f'[in the thread "{v["title"]}", topic {k}] '
    try:
        head = mm.api("GET", f"/posts/{root}").get("message", "")[:80]
    except Exception:
        head = ""
    return f'[in a thread with no topic yet, which starts: "{head}"] '


def bot_posts_since(mm, dm, bot_id, t0ms):
    """The bot's posts since t0ms; [] if they can't be read, since a duplicate beats a lost answer."""
    try:
        r = mm.api("GET", f"/channels/{dm}/posts?since={t0ms}")
    except Exception as e:
        log(f"couldn't read the bot's recent posts ({e!r}); posting anyway")
        return []
    return [r["posts"][i]["message"] for i in reversed(r.get("order", []))
            if r["posts"][i]["user_id"] == bot_id and r["posts"][i]["create_at"] > t0ms]


def iso_ms(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return int(time.time() * 1000) - 3600 * 1000  # unknown start: compare with the last hour


def forward(mm, dm, bot_id, state, sizes, post=True, user_at=0):
    """Post the chief's replies from finished turns the user did not start, then remember how far it got.
    post=False (outside the user's window) only moves the mark, so their next text never replays a backlog;
    so does the user being at this Mac, where they read the replies on screen."""
    c = chief()
    if not c:
        return
    uuid, path = c[0], sizes.setdefault("path:" + c[0], transcript(c[0]))
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    seen = state["seen"].get(uuid)
    if seen is not None and sizes.get(uuid) == size:
        return                                       # nothing written since the last look
    sizes[uuid] = size
    recs = records(path)
    if seen is None or seen > len(recs):             # a new chief: start from now, never replay
        state["seen"][uuid] = len(recs)
        save(state)
        return
    replies, new = to_forward(recs, seen)
    if replies and post and at_mac(user_at):
        post = False
        log(f"forward: held {len(replies)} from {uuid[:8]} (the user is active at this Mac)")
    for reply, ts in replies if post else []:
        if already_pushed(reply, bot_posts_since(mm, dm, bot_id, iso_ms(ts))):
            log("forward: already posted, skipped")
        else:
            if send(mm, dm, reply):
                log(f"forward: {len(reply)} chars from {uuid[:8]}")
    if new != seen:
        state["seen"][uuid] = new
        save(state)


def save(state):
    with tempfile.NamedTemporaryFile("w", dir=os.path.dirname(STATE), delete=False) as f:
        json.dump(state, f)
    os.replace(f.name, STATE)


def batch(posts, uid, bot_id):
    """([(root, text)], newest): the user's new posts, oldest first, one message per thread they were
    written in (all as one top-level message with THREADS off); everything else is dropped. A post a webhook,
    bot or plugin made under the user's name carries one of AUTOMATED in its props: it is not the user typing."""
    mine = sorted((p for p in posts if p.get("user_id") == uid and not p.get("type")
                   and not any(k in (p.get("props") or {}) for k in AUTOMATED)
                   and p.get("message", "").strip()), key=lambda p: p["create_at"])
    groups = {}
    on = threads()
    for p in mine:
        groups.setdefault((p.get("root_id") or "") if on else "", []).append(p["message"].strip())
    return [(r, "\n\n".join(m)) for r, m in groups.items()], max((p["create_at"] for p in posts), default=0)


# --- one exchange ------------------------------------------------------------------------------
def exchange(mm, dm, bot_id, text, root=""):
    t0ms = int(time.time() * 1000)
    say = lambda t: send(mm, dm, t, ask_root=root)  # bridge notices go where the user asked
    c = chief()
    if not c:
        say("No chief of staff session found (none open, or more than one live). Nothing was sent.")
        return
    uuid = c[0]
    try:
        note = topic_note(mm, root) if threads() else ""
    except Exception:                                # no note: the chief still gets the text
        note = ""
    p = subprocess.run(["herdr_session_manage.sh", "tell", uuid, PREFIX + note + text, "--timeout", "600000"],
                       capture_output=True, text=True, env=dict(os.environ, TELL_VERIFY_SECONDS="300"))
    out = (p.stdout + p.stderr).strip()
    rec = next((w.split("=", 1)[1] for w in out.split() if w.startswith("record=")), None)
    uuid = next((w.split("=", 1)[1] for w in out.split() if w.startswith("uuid=")), uuid)
    log(f"tell {uuid[:8]} rc={p.returncode} record={rec}")
    if p.returncode == 1 and ("rather than idle" in out or "is BLOCKED" in out):
        return "busy"                                # refused before sending: run() holds the text and retries
    if p.returncode == 1:
        say("Couldn't reach the chief — nothing was sent. Reason: " + out.splitlines()[-1][:300])
        return
    if p.returncode == 3 or not rec:
        say("Sent, but delivery wasn't confirmed. Check the chief on the Mac before resending.")
        return
    path, t0, nudged = transcript(uuid), time.time(), False
    time.sleep(3)
    while time.time() - t0 < GIVE_UP:
        st = status_of(uuid)
        if st in ("idle", "done", "blocked", "gone"):
            answer, question = reply_after(path, int(rec))
            if st == "blocked" and question:
                say((split_tag(answer)[2] + "\n\n" if answer else "") + "The chief is waiting on this question at the Mac "
                        "(answer by text and I'll pass it on):\n\n" + question)
                return
            if answer:
                if already_pushed(answer, bot_posts_since(mm, dm, bot_id, t0ms)):
                    log("reply already pushed by the chief; not posted again")
                else:
                    send(mm, dm, answer, ask_root=root)
                return
            if st in ("blocked", "gone"):
                say(f"The chief stopped ({st}) without a written reply.")
                return
        if not nudged and time.time() - t0 > STILL_WORKING:
            say("Still working on it — the reply comes when it finishes.")
            nudged = True
        time.sleep(POLL)
    say("No reply after 3 hours; stopped waiting. It may still answer on the Mac.")


def tell_all(mm, dm, bot_id, state, groups):
    """One exchange per thread: texts still held from a pass the chief was too busy for go first, with
    any new ones from the same thread joined on. A text the chief is still too busy for stays held in
    STATE, so a restart keeps it, and the user hears once that it is waiting; dropping it would lose a
    text whenever the chief works through tell's whole 10-minute wait."""
    held = {r: t for r, t in state.get("pending", [])}
    todo = dict(held)
    for root, text in groups:
        todo[root] = todo[root] + "\n\n" + text if root in todo else text
    still = []
    for root, text in todo.items():
        try:
            if exchange(mm, dm, bot_id, text, root) == "busy":
                still.append([root, text])
                log(f"held {len(text)} chars: the chief stayed busy; retrying next pass")
                if root not in held:
                    send(mm, dm, "The chief is busy right now. Your text is held here and goes in as soon "
                                 "as it is free.", ask_root=root)
        except Exception as e:                       # one bad exchange must not kill the daemon
            log(f"exchange failed: {e!r}")
            try:
                mm.post(dm, f"Bridge error: {type(e).__name__}. Check {LOG} on the Mac.")
            except Exception:
                pass
    state["pending"] = still
    save(state)


# --- verbs -------------------------------------------------------------------------------------
def run():
    mm, bot_id, uid, dm = connect()
    try:
        state = json.load(open(STATE))
        state["since"]
    except (OSError, ValueError, KeyError):
        state = {"since": int(time.time() * 1000)}  # first start: never replay old history
    state.setdefault("seen", {})
    since, sizes = state["since"], {}
    user_at = user_last(mm, dm, uid)
    log(f"up: DM {dm}, since {since}, the user last texted {datetime.fromtimestamp(user_at / 1000):%F %T}, "
        f"threads {'on' if threads() else 'off'}")
    while True:
        try:
            r = mm.api("GET", f"/channels/{dm}/posts?since={since}")
            posts = [r["posts"][i] for i in r.get("order", []) if r["posts"][i]["create_at"] > since]
        except (urllib.error.URLError, OSError, ValueError) as e:
            log(f"poll failed: {e}")
            time.sleep(30)
            continue
        groups, newest = batch(posts, uid, bot_id)
        if newest:
            since = state["since"] = newest
            save(state)
        if groups or state.get("pending"):
            user_at = int(time.time() * 1000)
            tell_all(mm, dm, bot_id, state, groups)
        try:
            flush(mm, dm, bot_id)
        except Exception as e:
            log(f"outbox flush failed: {e!r}")
        try:
            forward(mm, dm, bot_id, state, sizes, post=in_window(user_at, time.time()), user_at=user_at)
        except Exception as e:                       # forwarding must not kill the daemon either
            log(f"forward failed: {e!r}")
        time.sleep(POLL)


def setup():
    """Create the bot in the local Mattermost and put its token in the agent vault, never on screen."""
    if not (USER and TEAM):
        sys.exit(f"set MM_USER and MM_TEAM in {mattermost_post.CONF} first")
    docker = shutil.which("docker") or os.path.expanduser("~/.orbstack/bin/docker")
    os.environ.setdefault("DOCKER_HOST", "unix://" + os.path.expanduser("~/.orbstack/run/docker.sock"))
    dexec = [docker, "compose", "-f", os.path.join(COMPOSE, "docker-compose.yml"), "exec", "-T"]
    mmctl = dexec + ["mattermost", "mmctl", "--local"]
    # `bot create` refuses local mode, so make a plain user and convert it; its random password is
    # never kept, because a bot cannot log in with one. It travels in the environment (`-e MM_BOT_PW`
    # takes it from ours), so no command line on this Mac carries it.
    pw = subprocess.run(["openssl", "rand", "-base64", "30"], capture_output=True, text=True).stdout.strip()
    create = dexec + ["-e", "MM_BOT_PW", "mattermost", "sh", "-c", 'exec mmctl --local user create --username "$1" '
                      '--email "$1@localhost" --password "$MM_BOT_PW"', "sh", BOT]
    for step, argv in (("user create", create), ("user convert", mmctl + ["user", "convert", BOT, "--bot"]),
                       ("bot assign", mmctl + ["bot", "assign", BOT, USER]),
                       ("team users", mmctl + ["team", "users", "add", TEAM, BOT])):
        p = subprocess.run(argv, capture_output=True, text=True, env=dict(os.environ, MM_BOT_PW=pw) if argv is create else None)
        print(f"{step}: rc={p.returncode} {(p.stdout + p.stderr).strip()[:200]}")
    p = subprocess.run(mmctl + ["token", "generate", BOT, "phone bridge", "--json"], capture_output=True, text=True)
    try:
        j = json.loads(p.stdout)
        tok = (j[0] if isinstance(j, list) else j)["token"]   # mmctl --json prints a one-item list
    except (ValueError, KeyError, TypeError, IndexError):
        sys.exit("token generate failed: " + p.stderr.strip()[:300])
    db = os.path.expanduser(os.environ.get("CRED_DB", "~/agent-vault/agent-vault.kdbx"))
    kf = os.path.expanduser(os.environ.get("CRED_KEYFILE", "~/.config/agent-vault/agent-vault.keyx"))
    fd, backup = tempfile.mkstemp(prefix="agent-vault-backup-", suffix=".kdbx")   # mode 600
    os.close(fd)
    subprocess.run(["cp", db, backup], check=True)
    kp = shutil.which("keepassxc-cli") or "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli"
    p = subprocess.run([kp, "add", "-q", "--no-password", "-k", kf, "-u", BOT, "--url", BASE, "-p", db, ENTRY],
                       input=tok + "\n", capture_output=True, text=True)
    print(f"vault add: rc={p.returncode} {p.stderr.strip()[:200]}")
    h = subprocess.run([mattermost_post.GET_CREDENTIAL, "hash", ENTRY], capture_output=True, text=True).stdout.strip()
    ok = h == hashlib.sha256(tok.encode()).hexdigest()[:8]
    print("vault read-back matches:", ok)
    if ok:
        os.remove(backup)
    else:
        print(f"the vault as it was before is kept at {backup}; delete it once the vault is right")


def check():
    mm, bot_id, uid, dm = connect()
    print(f"token ok (bot {bot_id}); user {uid}; DM channel {dm}")
    print("chief:", chief())
    mm.post(dm, "Phone bridge check: text me here and it goes to the chief of staff.")
    print("posted a test line to the DM")


def push(text, conn=connect, logpath=LOG, topic=None):
    """--post: one message to the user's DM as the bot, unless they are at this Mac. Never tells or waits on the chief."""
    text = text.strip()
    if not text:
        sys.exit("--post: nothing on stdin; nothing posted")
    mm, _, uid, dm = conn()
    if at_mac(user_last(mm, dm, uid)):
        with open(logpath, "a") as f:
            f.write(f"{datetime.now():%F %T} push: held {len(text)} chars (the user is active at this Mac)\n")
        print("held: the user is active at this Mac, nothing posted. Put this in your chat reply instead.")
        return
    mm.retry = QUICK
    posted = send(mm, dm, f"[topic: {topic}]\n{text}" if topic else text)
    with open(logpath, "a") as f:
        f.write(f"{datetime.now():%F %T} push: {len(text)} chars{' to ' + topic if topic else ''}"
                f"{'' if posted else ' QUEUED (Mattermost unreachable)'}\n")
    if not posted:
        print("queued: Mattermost is unreachable; it posts, marked delayed, as soon as it is back.")
        return
    print(f"posted {len(text)} chars to the user's DM")


if __name__ == "__main__":
    a = sys.argv[1:]
    if a == ["--setup"]:
        sys.exit(setup())
    if a == ["--check"]:
        sys.exit(check())
    if a == ["--post"]:
        sys.exit(push(sys.stdin.read()))
    if len(a) == 3 and a[:2] == ["--post", "--topic"]:
        sys.exit(push(sys.stdin.read(), topic=a[2]))
    if a == ["--threads"]:
        sys.exit(print("on" if threads() else "off"))
    if len(a) == 2 and a[0] == "--threads" and a[1] in ("on", "off"):
        set_threads(a[1])
        sys.exit(print(f"topic threads {a[1]}: takes effect on the next post, no restart"))
    if len(a) == 3 and a[0] == "--rename":
        key, title = a[1].lower(), a[2].strip()
        if not title or title.lower() == key:
            sys.exit("--rename: give a title a person can read, not the key")
        mm, bot_id, _, _ = connect()
        root = rename(mm, bot_id, key, title)
        sys.exit(print(f"{key} is now \"{title}\"" + ("; its thread's first post edited to match" if root
                       else "; its thread starts with your own text, left as is")))
    if a == ["--topics"]:
        for k, v in topics().items():
            print(f"{k}\t{v['title']}\t{link(v['root'])}")
        sys.exit(0)
    if a:
        sys.exit(__doc__)
    run()
