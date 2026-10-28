#!/usr/bin/env python3
"""Keep the server-driven rows (Fable, or any model family beyond Opus/Sonnet/Haiku) in Claude Code's /model picker current.

WHY THIS EXISTS
A session signed in with a long-lived token (`claude setup-token`, exported as
CLAUDE_CODE_OAUTH_TOKEN) carries the `user:inference` scope only, but
GET /api/claude_cli/bootstrap requires `user:profile` -- so every launch logs

    [Bootstrap] Skipped: 403 for OAuth token without profile scope

and `additionalModelOptionsCache` in .claude.json is never refreshed.  On a
first-party account the Fable row in /model comes ONLY from that server list,
so the picker stays frozen at whatever was cached before the switch to the token.

THE FIX
The CLI binary ships the whole model registry and auto-updates itself, so it is
a fresher source than the API we cannot call.  Read the registry out of the
binary, probe each candidate with a one-token call, and write the survivors into
additionalModelOptionsCache.  Probing is not optional: the registry lists models
the account has no access to.  The same bootstrap 403 that broke the list is
what makes a hand-written value stable -- nothing server-side overwrites it.

Runs as a no-op until the CLI version changes, so a frequent schedule costs
~10ms on every run except the first after an upgrade.

ACCOUNTS
~/.config/knowledge-worker-stack/accounts.json, optional:
    {"default": "~/.claude", "<name>": "<CLAUDE_CONFIG_DIR path>"}
Absent = one account, "default", at ~/.claude.  Each account's token is read
from <config dir>/.oauth_token; an account without one is skipped.

NEW-MODEL ALERT
The same registry is the earliest local signal that a model shipped.  Every run
that sees a new CLI version diffs the registry against the ids recorded in the
state file and alerts on any addition, whatever its family -- the picker builds
opus/sonnet/haiku rows itself, so those never show up in the row diff above.
A state file without a recorded registry is seeded silently.  The alert goes
through mattermost_post.py (comms/) when it is on PATH -- Mattermost when that
is set up -- else it is a macOS notification.

  claude_model_picker_sync.py              # sync if the CLI version changed
  claude_model_picker_sync.py --force      # re-probe and rewrite regardless
  claude_model_picker_sync.py --dry-run    # print what would change, write nothing
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

def find_claude():
    """Claude Code's program: the native installer's ~/.local/bin/claude, else whatever `claude` is
    on PATH, else the usual Homebrew and npm locations.  None if there is none."""
    for c in (os.path.expanduser("~/.local/bin/claude"), shutil.which("claude"),
              "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if c and os.path.exists(c):
            return c
    return None


def version_of(path):
    """The installed version, for the run-only-after-an-upgrade check.  The native installer names
    the real file after its version; other installs do not, so their size and time stand in."""
    real = os.path.realpath(path)
    name = os.path.basename(real)
    if re.fullmatch(r"\d+\.\d+[\w.-]*", name):
        return name
    st = os.stat(real)
    return f"{name}-{st.st_size}-{int(st.st_mtime)}"


CLAUDE_BIN = None   # set in main()
STATE = os.path.expanduser("~/.claude/state/state_claude_model_picker_sync.json")
ACCOUNTS = os.path.expanduser("~/.config/knowledge-worker-stack/accounts.json")


def config_dirs():
    """Account -> config dir.  Each account has its own token and its own
    entitlements, so each is probed and written separately."""
    try:
        with open(ACCOUNTS) as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict):
        d = {}
    dirs = {k: os.path.expanduser(v) for k, v in d.items() if isinstance(v, str)}
    dirs.setdefault("default", os.path.expanduser("~/.claude"))
    return dirs


# Families the first-party picker builds itself: opus/sonnet/haiku rows need no help. Any other
# model family exists in /model only if the server sends it, which is the thing that is broken here.
BUILT_IN_FAMILIES = {"opus", "sonnet", "haiku"}

# The literal the picker interpolates into the Fable row description (`NPe` in
# the binary).  Re-check it if the row ever renders differently from the others.
FABLE_BLURB = "Most capable for your hardest and longest-running tasks"

REGISTRY_RE = re.compile(
    r'\{id:"(claude-[a-z0-9-]+)",family:"([a-z0-9-]+)",display_name:"([^"]+)"'
)


def read_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_json_atomic(path, obj):
    """Write via temp file + rename.  A `>` redirect truncates before the writer
    runs, which is how a failed extraction silently blanks a live config."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f, indent=2)
    json.load(open(tmp))  # refuse to install anything that will not parse back
    if os.path.exists(path):
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


def config_json_for(config_dir):
    """The ~/.claude account's config lives at ~/.claude.json, beside the dir
    rather than inside it; any other config dir keeps its own inside."""
    if os.path.realpath(config_dir) == os.path.realpath(os.path.expanduser("~/.claude")):
        return os.path.expanduser("~/.claude.json")
    return os.path.join(config_dir, ".claude.json")


def read_registry(binary):
    """Pull {id: (family, display_name)} out of the CLI binary."""
    with open(binary, "rb") as f:
        blob = f.read().decode("utf-8", errors="replace")
    return {m.group(1): (m.group(2), m.group(3)) for m in REGISTRY_RE.finditer(blob)}


def token_for(config_dir):
    try:
        with open(os.path.join(config_dir, ".oauth_token")) as f:
            return f.read().strip()
    except OSError:
        return None


def probe(model, config_dir, token):
    """One-token call to find out whether this account may actually use `model`.
    Costs one tiny request per NEW model per account, and never repeats: the
    answer is cached in the state file."""
    env = dict(os.environ, CLAUDE_CODE_OAUTH_TOKEN=token, CLAUDE_CONFIG_DIR=config_dir)
    try:
        r = subprocess.run(
            [CLAUDE_BIN, "-p", "reply with exactly: ok", "--model", model,
             "--no-session-persistence"],
            env=env, capture_output=True, text=True, timeout=180,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return False
    return r.returncode == 0 and "issue with the selected model" not in r.stdout


def newest_first(registry):
    """Sort claude-fable-5-1 above claude-fable-5: family, then version numbers
    descending, so the picker lists the newest model of each family first."""
    def key(item):
        model_id, (family, _) = item
        nums = [int(n) for n in re.findall(r"\d+", model_id.replace(family, ""))]
        # Pad so 5.1 outranks bare 5: [-5, -1] sorts before [-5, 0], whereas an
        # unpadded [-5] would sort before [-5, -1] and put the older one first.
        nums = (nums + [0, 0, 0])[:3]
        return (family, [-n for n in nums])
    return sorted(registry.items(), key=key)


def build_entries(registry, config_dir, token, probed, dry_run):
    """The option rows this account can actually use, newest first."""
    entries = []
    for model_id, (family, display_name) in newest_first(registry):
        if family in BUILT_IN_FAMILIES:
            continue
        cache_key = f"{os.path.basename(config_dir)}::{model_id}"
        if cache_key not in probed:
            if dry_run:
                print(f"    would probe {model_id}")
                continue
            # Prefer the 1M-context variant where the account has it -- that is
            # what the server itself used to send for the Fable row.
            if probe(f"{model_id}[1m]", config_dir, token):
                probed[cache_key] = f"{model_id}[1m]"
            elif probe(model_id, config_dir, token):
                probed[cache_key] = model_id
            else:
                probed[cache_key] = None
            print(f"    probed {model_id}: {probed[cache_key] or 'NO ACCESS'}")
        value = probed.get(cache_key)
        if value:
            description = (f"{display_name} · {FABLE_BLURB}"
                           if family == "fable" else display_name)
            entries.append({"value": value, "label": display_name,
                            "description": description})
    return entries


def notify(subject, body):
    """mattermost_post.py (from comms/) when it is on PATH: it posts to Mattermost when that is set
    up, else shows a macOS notification itself.  Without it, the macOS notification.  Never fatal."""
    mm = shutil.which("mattermost_post.py")
    if mm:
        try:
            r = subprocess.run([mm, subject], input=body, capture_output=True, text=True, timeout=60)
            if r.returncode == 0:
                print(f"{subject}\n{body}")
                return
        except (subprocess.SubprocessError, OSError):
            pass
    try:
        subprocess.run(["osascript", "-e", "on run argv",
                        "-e", "display notification (item 2 of argv) with title (item 1 of argv)",
                        "-e", "end run", subject, body[:200]],
                       check=True, capture_output=True, timeout=30)
    except (subprocess.SubprocessError, OSError) as exc:
        print(f"notification failed: {exc}", file=sys.stderr)
    print(f"{subject}\n{body}")


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true",
                    help="re-probe and rewrite even if the CLI version is unchanged")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would change, write nothing")
    args = ap.parse_args()

    global CLAUDE_BIN
    CLAUDE_BIN = find_claude()
    if not CLAUDE_BIN:
        print("no claude found (~/.local/bin/claude, PATH, /opt/homebrew/bin, /usr/local/bin)", file=sys.stderr)
        return 1

    # Only a token sign-in freezes the list; without any token file there is nothing to do.
    if not any(token_for(d) for d in config_dirs().values()):
        print("no account has a .oauth_token — the /model list only needs this under the token sign-in; nothing to do")
        return 0

    version = version_of(CLAUDE_BIN)
    state = read_state()
    if state.get("version") == version and not (args.force or args.dry_run):
        return 0  # fast path: nothing new shipped

    print(f"CLI {version} (last synced: {state.get('version', 'never')})")
    registry = read_registry(os.path.realpath(CLAUDE_BIN))
    print(f"{len(registry)} models in registry")
    known = state.get("registry")
    new_models = [] if known is None else [m for m in registry if m not in known]
    for m in new_models:
        print(f"  NEW model in registry: {m} ({registry[m][1]})")

    probed = {} if args.force else dict(state.get("probed", {}))
    changes = []

    for account, config_dir in config_dirs().items():
        config_json = config_json_for(config_dir)
        if not os.path.isfile(config_json):
            continue
        token = token_for(config_dir)
        if not token:
            print(f"  {account}: no setup token, skipped")
            continue

        print(f"  {account}:")
        entries = build_entries(registry, config_dir, token, probed, args.dry_run)
        if args.dry_run:
            print(f"    would write {[e['value'] for e in entries]}")
            continue

        with open(config_json) as f:
            config = json.load(f)
        if config.get("additionalModelOptionsCache") == entries:
            print(f"    unchanged: {[e['value'] for e in entries]}")
            continue
        before = [e.get("value") for e in config.get("additionalModelOptionsCache") or []]
        config["additionalModelOptionsCache"] = entries
        write_json_atomic(config_json, config)
        after = [e["value"] for e in entries]
        print(f"    updated: {before} -> {after}")
        changes.append(f"{account}: {before} -> {after}")

    if args.dry_run:
        return 0

    state["version"] = version
    state["probed"] = probed
    state["registry"] = sorted(registry)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    write_json_atomic(STATE, state)

    if new_models:
        names = ", ".join(registry[m][1] for m in new_models)
        notify(f"Claude Code {version}: new model {names}",
               f"Claude Code {version} ships models not in the previous registry:\n\n"
               + "\n".join(f"{m}  ({registry[m][1]})" for m in new_models)
               + ("\n\n/model options changed:\n" + "\n".join(changes) if changes else ""))
    elif changes:
        notify(f"Claude Code /model options changed ({version})",
               f"Claude Code {version} changed the /model options:\n\n" + "\n".join(changes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
