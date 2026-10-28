#!/usr/bin/env python3
# browse-drive-native-browser-prompts.py — read and press Chromium's NATIVE browser-chrome prompts (permission bubbles, the saved-
# password chooser, infobars, the download bubble) over the AT-SPI accessibility bus.
#
# Three kinds of thing get pressed here and they are kept apart on purpose. A BUTTON (--press) is a role
# `button` inside a permission bubble or a save-password bubble: pressing it answers a question. An ENTRY
# (--press-entry) is a role `list item` inside the saved-password chooser's `list box`: pressing it PICKS AN
# ACCOUNT and makes Chromium type that account's password into the page. A CARD ROW (--press-entry-card) is the
# SAME role in the SAME `list box` — Chromium paints saved passwords and saved payment cards through one
# widget, named 'Autofill' — but it is named by its LAST FOUR rather than by its label, for two measured
# reasons in TRAP (e) below. They are not interchangeable, which is why each is a separate flag with a separate
# caller (browse.js's native-browser-prompts-choose, which resolves a USERNAME or a LAST FOUR and refuses
# anything else) rather than one more thing --press can hit. The chooser's own "Manage passwords…" footer row
# is a `list item` too, and pressing it opens a page listing every saved username — so it is excluded from
# `entries` at the source and cannot be named by any of the flags; TRAP (d) below is how, and why doing it by
# label would not have held. The payment popup's footer, "Manage payment methods…", is excluded by that same
# rule and leads to the page listing every saved card.
#
# WHY IT EXISTS: those prompts are painted in BROWSER UI, not the page DOM. CDP has no event and no query for
# them (checked against this build's own /json/protocol), page JS cannot see them, and X11 window enumeration
# cannot either — Chromium paints its whole UI inside ONE opaque compositor window, so `xwininfo -tree -root`
# is byte-identical with a prompt up or down. A page blocked by one returns exit 0 with plausible JSON, so
# automation stalls SILENTLY, at a download prompt or at a saved-password
# chooser on a login page. AT-SPI is the only structured reader that exists. Measured on Chromium 148.
#
# browse.js (Node) shells out to this for the `native-browser-prompts-view` / `native-browser-prompts-dismiss`
# verbs — the Atspi bindings are Python-only. Runnable standalone for debugging:
#     DISPLAY=:99 python3 browse-drive-native-browser-prompts.py                     # list prompts in the browser on CDP 9222
#     DISPLAY=:99 python3 browse-drive-native-browser-prompts.py --press Allow       # press a named button in one of them
#     DISPLAY=:99 python3 browse-drive-native-browser-prompts.py --port 9337 --pid 1234 --press Block
#     DISPLAY=:99 python3 browse-drive-native-browser-prompts.py --press-entry 'Password for a@b.test'   # pick a chooser row
#     DISPLAY=:99 python3 browse-drive-native-browser-prompts.py --press-entry-card 4242   # accept a saved CARD
#
# Exit: 0 ok · 2 --press/--press-entry/--press-entry-card found no such button/entry (or a last four matched
#       more than one card) · 3 no accessibility tree for that browser · 4 usage/environment.
# Prerequisites: at-spi2-core + gir1.2-atspi-2.0, accessibility enabled on the browser's session bus,
# and Chromium launched with --force-renderer-accessibility=basic.
# Doc: README.md (Linux setup).

import json
import os
import re
import subprocess
import sys
import unicodedata


def die(msg, code):
    sys.stderr.write("browse-native-browser-prompts: " + msg + "\n")
    sys.exit(code)


# ---- args (no argparse: zero dependency surface, and every failure mode is visible right here) ----
argv = sys.argv[1:]
KNOWN = ("--press", "--press-entry", "--press-entry-card", "--port", "--pid")


def opt(name):
    if name not in argv:
        return None
    i = argv.index(name)
    if i + 1 >= len(argv):
        die(name + " needs a value", 4)
    return argv[i + 1]


press = opt("--press")
press_entry = opt("--press-entry")
press_card = opt("--press-entry-card")
port = opt("--port") or "9222"
pid_arg = opt("--pid")
if sum(x is not None for x in (press, press_entry, press_card)) > 1:
    die("--press, --press-entry and --press-entry-card are different targets (a button, a saved-password "
        "chooser row, a saved-card row) — pass one", 4)
if press_card is not None and not re.fullmatch(r"\d{4}", press_card.strip()):
    die("--press-entry-card takes exactly the LAST FOUR digits of the card, e.g. 4242 (got %r)" % press_card, 4)
if press_card is not None:
    press_card = press_card.strip()
for i, a in enumerate(argv):                       # fail loud on a typo'd flag, never silently ignore it
    if a.startswith("--") and a not in KNOWN and (i == 0 or argv[i - 1] not in KNOWN):
        die("unknown flag: " + a + " (valid: " + ", ".join(KNOWN) + ")", 4)

# The a11y bus is reached THROUGH the session bus. An ssh shell carries DBUS_SESSION_BUS_ADDRESS; a systemd or
# cron caller does not, and without it the tree comes back empty — indistinguishable from "accessibility off".
# Default it to this user's session bus when that socket exists: fail-soft, and it costs one stat.
if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
    sock = "/run/user/%d/bus" % os.getuid()
    if os.path.exists(sock):
        os.environ["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=" + sock


# TRAP (a) — THE AT-SPI TREE IS MACHINE-WIDE. Every accessibility-publishing Chromium on the box appears in
# it, including another agent's browser and the live logged-in one, so filtering is a SAFETY requirement and
# not a nicety: unfiltered, a press lands in whichever window happens to hold a matching button. The filter
# key is the browser process's pid, and the cleanest way to get it is to ask the kernel who owns the CDP
# LISTENING SOCKET — that process IS, by definition, the browser this call is talking to. A socket lookup
# beats matching command lines: `pgrep -f --remote-debugging-port=N` also matches the caller's own argv (the
# pkill self-match footgun) and returns the browser plus every renderer, while `ss` returns exactly one pid.
# Measured: socket owner pid == the pid AT-SPI reports for the [application] node.
def browser_pid(cdp_port):
    try:
        r = subprocess.run(["ss", "-H", "-ltnp", "sport = :" + cdp_port],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as e:
        die("cannot run ss to identify the browser on CDP port " + cdp_port + " (" + str(e) + ")", 4)
    m = re.search(r"pid=(\d+)", r.stdout)
    if not m:
        die("nothing is listening on CDP port " + cdp_port + " — is the browser up?", 4)
    return int(m.group(1))


try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except (ImportError, ValueError) as e:
    die("Atspi bindings unavailable (" + str(e) + ") — apt-get install at-spi2-core gir1.2-atspi-2.0", 4)

# `list box` earns its place here and it is the WHOLE of the widening — no extra depth, no second pass.
# Chromium's saved-password chooser is not an alert or a dialog: it is a `list box` named 'Autofill', hung off a
# SECOND top-level [frame] under [application], and its rows are `list item`s five levels below that. Once
# this tuple held only alert/dialog, so a chooser standing open ON SCREEN was reported as nothing but
# the Infobar — the probe was not looking for it, and "AT-SPI cannot drive the chooser" was inferred from that
# silence rather than measured. Measured properly (full pid-scoped dump, throwaway browser, two saved rows):
# the list box sits at depth 1, well inside the depth<=6 cap the walk already used, so the cap was never the
# problem and raising it would only buy the ~300-node full walk nobody should poll. One role name is the fix.
PROMPT_ROLES = ("alert", "dialog", "list box")

# A MODAL WINDOW, told apart from the browser window STRUCTURALLY rather than by label. Chromium's print
# preview — what `window.print()` raises — is not an alert, a dialog or a list box: it is a `frame` named
# 'Print' NESTED inside the browser's own `frame`, holding a `document web` whose buttons are Cancel and Save.
# Once the tuple above missed it completely and `native-browser-prompts-view` answered `[]` on a
# tab that was wedged solid — not even the Infobar, because the modal replaces the window's published subtree.
# The depth test is the whole rule and it is what keeps this safe: a `frame` that is a DIRECT child of
# [application] is a browser WINDOW and must never be reported as a prompt, while a `frame` nested inside
# another frame is a modal widget window by construction. Measured both directions on a throwaway headful
# browser: with nothing up, this walk and the earlier one return byte-identical output; with the preview
# up it returns the Print frame and its buttons. Deliberately NOT matched on the name 'Print' — labels are
# localized, and the basic-auth modal (a depth-0 `frame` named 'Sign in' whose `dialog` child is already
# collected) shows the same structure works without naming anything.
NESTED_PROMPT_ROLES = ("frame",)


def extents(node):
    try:
        e = node.get_extents(Atspi.CoordType.SCREEN)
        return (e.x, e.y, e.width, e.height)
    except Exception:
        return None


# Prompts come and go on their own (the download bubble auto-hides after a few seconds), so a node can die
# mid-walk and its accessor then raises. Skip the casualty instead of tracebacking over a race: a walk that
# blew up would surface to the caller as unparseable output rather than as the honest "it went away".
def child(node, i):
    try:
        return node.get_child_at_index(i)
    except Exception:
        return None


def buttons(node, depth=0, out=None):              # every named button anywhere under a prompt
    out = [] if out is None else out
    if depth > 8:
        return out
    for i in range(node.get_child_count()):
        c = child(node, i)
        if c is None:
            continue
        if c.get_role_name() == "button" and c.get_name():
            out.append(c)
        buttons(c, depth + 1, out)
    return out


# Every ACCOUNT row under a prompt — the saved credentials the chooser is offering, and nothing else.
# TRAP (c) — EACH ROW IS PUBLISHED TWICE, an OUTER wrapper and an inner child with the SAME name and the SAME
# extents, and ONLY THE OUTER ONE ACTIVATES. do_action on the inner returns True and is silently swallowed:
# the chooser stays up and no field fills (measured, both rows, repeatedly). That single detail is
# what the whole account-picking capability turns on, so the dedupe below keeps the SHALLOWEST node for a given
# name rather than the first one seen — depth is the only thing that tells the two apart.
# TRAP (d) — THE FOOTER ROW IS NOT AN ACCOUNT AND MUST NEVER BE COLLECTED. Chromium ends the chooser with
# 'Manage passwords…', a `list item` indistinguishable by role from an account row, and pressing it OPENS
# chrome://password-manager/passwords — which RENDERS EVERY SAVED USERNAME. Measured
# before this rule: `native-browser-prompts-choose --username 'Manage passwords…'` matched it
# exactly, pressed it, opened that tab, and only THEN failed with "nothing on the page changed" — an error
# after the exposure, which is no protection at all. The footer is told from the accounts STRUCTURALLY rather
# than by label (labels are localized): Chromium puts a `separator` between the account rows and the footer
# panel, so collection stops at the first separator seen among a node's children. If a future build ever moved
# the separator ABOVE the accounts this would collect nothing and the verb would refuse with "the chooser is
# not offering …" — loud and harmless, which is the right direction for this rule to fail in.
def entries(node, depth=0, out=None):
    out = {} if out is None else out
    if depth > 8:
        return out
    for i in range(node.get_child_count()):
        c = child(node, i)
        if c is None:
            continue
        role = c.get_role_name()
        if role == "separator":
            break                                  # everything past it is chooser FOOTER — see TRAP (d)
        name = c.get_name() if role == "list item" else None
        if name and (name not in out or depth < out[name][0]):
            out[name] = (depth, c)
        entries(c, depth + 1, out)
    return out


# TRAP (e) — A SAVED-CARD ROW CANNOT BE NAMED BY ITS LABEL, AND ITS LABEL MUST NOT BE PRINTED. Both halves
# were measured on Chromium 151 against a card the browser itself had saved.
#   (i) NOT NAMEABLE. The label renders as "Visa Visa  ‪•⁠ ⁠•⁠ ⁠4242‬ • 12/30", and the run between the network
#       and the digits is not what it looks like: it carries U+202A/U+202C bidi embedding marks, U+2060 word
#       joiners and U+2006 six-per-em spaces. Round-tripping that through a shell argument silently rewrites
#       U+2006 to a plain space, so the exact match --press-entry is built on then FAILS on a row that is
#       plainly on screen. Matching a card by label is therefore not an interface anyone can use — hence
#       --press-entry-card, which matches on the four digits and nothing else.
#  (ii) NOT PRINTABLE. That same label ends in the card's EXPIRY. This script's output is read by agents and
#       lands in transcripts, so a listing that echoes the raw label leaks it. Card rows are therefore
#       REWRITTEN in the listing to "card ••••<last four>" — last four is what identifies a card to a human,
#       and everything else about it (expiry, network duplication, any cardholder name a future build appends)
#       is dropped at the source. The RAW label is still what the press matches against internally; it simply
#       never leaves this process.
# Detection is STRUCTURAL rather than by label: a bullet run immediately followed by exactly four digits. A
# saved-password row ("Password for alice@example.test") has no bullet run, so the two cannot be confused, and
# the rule biases toward TREATING A ROW AS A CARD — the failure that direction is a password row that goes
# unnameable and errors loudly, against a card expiry that would leak silently.
CARD_ROW_DIGITS = re.compile(r"[•·∙●*]\s*(\d{4})(?!\d)")


def card_last_four(name):
    """The last four of a saved-card row's label, or None if this is not a card row."""
    if not name:
        return None
    plain = "".join(" " if unicodedata.category(c) == "Zs" else c
                    for c in name if unicodedata.category(c) != "Cf")
    m = CARD_ROW_DIGITS.search(plain)
    return m.group(1) if m else None


def safe_entry(name):
    """What a row is allowed to be PRINTED as. Card rows lose everything but their last four."""
    four = card_last_four(name)
    return ("card ••••" + four) if four else name


# TRAP (b) — EACH PROMPT IS EXPOSED AT TWO PATHS, once as a child of [application] and again as a child of
# [frame] (which is itself a child of [application]), so a naive walk reports every prompt and every button
# TWICE. Dedupe on role + accessible name + screen extents: the two paths are the SAME widget so all three
# agree, while two genuinely distinct prompts never do. The walk goes deeper than the application's direct
# children on purpose — infobars sit one level further down, under [panel] 'Infobar Container'.
def prompts(node, depth=0, found=None, seen=None):
    found = [] if found is None else found
    seen = set() if seen is None else seen
    if depth > 6:
        return found
    for i in range(node.get_child_count()):
        c = child(node, i)
        if c is None:
            continue
        role = c.get_role_name()
        if role in PROMPT_ROLES or (depth >= 1 and role in NESTED_PROMPT_ROLES):
            key = (role, c.get_name(), extents(c))
            if key not in seen:
                seen.add(key)
                found.append(c)
            continue                               # a prompt's subtree holds its buttons, not more prompts
        prompts(c, depth + 1, found, seen)
    return found


want = int(pid_arg) if pid_arg else browser_pid(port)
Atspi.init()
desktop = Atspi.get_desktop(0)
mine, seen_pids = None, []
for i in range(desktop.get_child_count()):
    app = child(desktop, i)
    if app is None:
        continue
    try:
        app_pid = app.get_process_id()
    except Exception:
        continue
    seen_pids.append(app_pid)
    if app_pid == want:
        mine = app
if mine is None:
    # Exit 3, never a traceback and never an empty list: "cannot see" must not be reportable as "nothing there".
    die("no accessibility tree for the browser on CDP port %s (pid %d); apps visible: %s. An EMPTY list means "
        "accessibility is off box-wide (enable it via dconf, see README.md); a non-empty list "
        "WITHOUT that pid means that process publishes nothing — it was started without "
        "--force-renderer-accessibility=basic, or it is not a browser at all."
        % (port, want, seen_pids or "none"), 3)

# Snapshot role/name/buttons ONCE, for the same reason `child` exists: the JSON, the press match and the
# error message must all read the SAME stable strings, not re-read nodes that may have vanished in between.
snap = []
for p in prompts(mine):
    try:
        snap.append((p.get_role_name(), p.get_name(), [(b, b.get_name()) for b in buttons(p)],
                     [(node, en) for en, (_d, node) in entries(p).items()]))
    except Exception:
        continue
# `entries` is emitted only where there are some, so the shape a caller has always seen does not change under
# them: a permission bubble still reports exactly {role, name, buttons}, and an empty list would just be noise
# on every prompt that is not a chooser.
listing = []
for r, n, bs, es in snap:
    item = {"role": r, "name": n, "buttons": [bn for _, bn in bs]}
    if es:
        item["entries"] = [safe_entry(en) for _, en in es]   # card rows are rewritten here — TRAP (e)(ii)
    listing.append(item)

if press is None and press_entry is None and press_card is None:
    print(json.dumps(listing))
    sys.exit(0)

# Press the saved-CARD row whose LAST FOUR match. Never by label — TRAP (e)(i). Exactly one row must match:
# zero is a plain "not offered", and two is a genuine ambiguity the caller has to resolve, because picking
# either would be a guess about which card to put into a payment form. Neither the label nor anything derived
# from it beyond the last four is echoed, on success or on failure.
if press_card is not None:
    hits = [(node, ename, role, name) for role, name, bs, es in snap
            for node, ename in es if card_last_four(ename) == press_card]
    if len(hits) > 1:
        die("last four %s matches %d saved-card rows in the browser on CDP port %s — picking either would be a "
            "guess about which card to pay with. Remove the ambiguity in chrome://settings/payments"
            % (press_card, len(hits), port), 2)
    if not hits:
        offered = sorted({f for p in listing for e in p.get("entries", [])
                          for f in [card_last_four(e)] if f})
        die("no saved-card row ending %s in any prompt of the browser on CDP port %s (cards offered: %s)"
            % (press_card, port, json.dumps(offered) if offered else "none — no card popup is showing"), 2)
    node, ename, role, name = hits[0]
    idx = next((k for k in range(node.get_n_actions())
                if node.get_action_name(k) in ("doDefault", "press")), 0)
    node.do_action(idx)  # true even when Chromium SWALLOWS it — the caller must verify by effect
    print(json.dumps({"pressedCard": press_card, "in": name, "role": role}))
    sys.exit(0)

# Press the OUTER chooser row whose accessible name matches EXACTLY. Exact, because the caller (browse.js) has
# already read this very listing and picked a name out of it — a fuzzy match here would be a second, weaker
# guess layered on a decision that was made with full information.
if press_entry is not None:
    for role, name, bs, es in snap:
        for node, ename in es:
            if card_last_four(ename) is not None:
                continue          # a saved CARD has its own door — TRAP (e)(i); its label cannot be retyped
            if ename == press_entry:
                idx = next((k for k in range(node.get_n_actions())
                            if node.get_action_name(k) in ("doDefault", "press")), 0)
                node.do_action(idx)  # true even when Chromium SWALLOWS it — the caller must verify by effect
                print(json.dumps({"pressedEntry": press_entry, "in": name, "role": role}))
                sys.exit(0)
    cards = sorted({f for p in listing for e in p.get("entries", []) for f in [card_last_four(e)] if f})
    die("no entry named %r in any prompt of the browser on CDP port %s (showing: %s)%s"
        % (press_entry, port,
           json.dumps([{"name": p["name"], "entries": p.get("entries", [])} for p in listing]),
           (" — the popup is offering SAVED CARDS, which are picked by last four instead: "
            "--press-entry-card %s" % cards[0]) if cards else ""), 2)

for role, name, bs, es in snap:
    for node, bname in bs:
        if bname == press:
            # Action 0 is 'press' on every Chromium button measured, but resolve it BY NAME and fall back to 0:
            # action 1 is 'showContextMenu', and pressing that would silently do nothing.
            idx = next((k for k in range(node.get_n_actions()) if node.get_action_name(k) == "press"), 0)
            node.do_action(idx)   # true even when Chromium SWALLOWS the press — the caller must verify by effect
            print(json.dumps({"pressed": press, "in": name, "role": role}))
            sys.exit(0)
die("no button named %r in any prompt of the browser on CDP port %s (showing: %s)"
    % (press, port, json.dumps([{"name": p["name"], "buttons": p["buttons"]} for p in listing])), 2)
