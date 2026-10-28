#!/usr/bin/env python3
"""Mechanical parts of a /successor first prompt: the parts that must not be anyone's judgment.

    claude_successor_first_prompt.py index      <transcript> <first-prompt>
        Append the index of the USER's own turns (record number, time, first 110 chars) and then
        the '## SWEEP FINDINGS' heading, which must end up the LAST '## ' heading in the file.
    claude_successor_first_prompt.py inherited  <transcript>
        Print the first prompt THIS session was born with (if it was itself a successor), so the
        sweep can carry each inherited item at one generation higher.
    claude_successor_first_prompt.py background <transcript> <first-prompt>
        Append the background work this session started. Retiring a session stops it, so the
        names listed here are the only record of what the successor may need to re-arm.
    claude_successor_first_prompt.py check      <first-prompt> <heading>
        Exit 1 unless <heading> appears exactly once and has non-blank text under it.

Record numbers come from here rather than from memory: recall gets them wrong while sounding sure.
"""
import difflib, json, re, sys
from datetime import datetime

CAP = 60   # rows kept; a longer session keeps row 1 (it set the direction) and the most recent tail
SWEEP = "## SWEEP FINDINGS — unverified, unfixed, and yours to fix"
# Harness wrappers: user-type records that are not the user typing.
SKIP = ("<system-reminder>", "<local-command", "<task-notification", "<cross-session-message",
        "Another Claude session sent a", "This session is being continued from a previous conversation",
        "[auto-successor]")
# Written by this skill, not by the user: a first prompt, and the closing report after it.
MINE = ("You are session ", "You are the successor to ", "CLOSING REPORT FROM YOUR PREDECESSOR")
PASTE = re.compile(r"</?pasted_content\b[^>]*>")   # a long prompt is recorded inside this element
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def flat(v):
    if isinstance(v, str): return v
    if isinstance(v, list): return "".join(b.get("text", "") for b in v if isinstance(b, dict))
    return ""


def records(path):
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            try: yield n, json.loads(line)
            except Exception: continue


def when(ts):
    try: return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().strftime("%m-%d %H:%M")
    except (ValueError, AttributeError): return ""


def resend(a, b):   # an interrupted-and-resubmitted prompt is an EDIT of one turn, not two turns
    if a == b or b.startswith(a) or a.startswith(b): return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.40


def headings(text):
    return [l for l in text.splitlines() if l.startswith("## ")]


def cmd_index(tx, fp):
    rows, replies, n, prevpar, prevrep, prevatt, queued = [], 0, 0, None, 0, False, set()
    for n, r in records(tx):
        t, org = None, None
        if r.get("type") == "assistant":
            c = r.get("message", {}).get("content") or []
            if any(isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip() for b in c):
                replies += 1
            continue
        if r.get("type") == "attachment" and (r.get("attachment") or {}).get("type") == "queued_command":
            t = flat(r["attachment"].get("prompt", ""))     # typed while a turn was running
            org = r["attachment"].get("origin")
            queued.add(" ".join(t.split()))
        elif r.get("type") == "user" and not r.get("isMeta"):
            c = r.get("message", {}).get("content")
            if isinstance(c, str) or (isinstance(c, list) and not any(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in c)):
                t = flat(c)
            org = r.get("origin")
        if not t or not t.strip(): continue
        t = PASTE.sub("", t)
        s = t.lstrip()
        if s.startswith(SKIP) or s.startswith(MINE): continue
        if (org or {}).get("kind") == "peer": continue        # another session's message
        if re.fullmatch(r"\s*(?:<command-(?:message|name|args)>.*?</command-(?:message|name|args)>\s*)+", t, re.S):
            m = re.search(r"<command-name>\s*/?([\w:-]+)\s*</command-name>", t)
            if m:                                              # a slash command reads as /name args
                a = re.search(r"<command-args>(.*?)</command-args>", t, re.S)
                t = "/" + m.group(1) + (" " + a.group(1) if a and a.group(1).strip() else "")
        t = ANSI.sub("", t)
        row = (n, when(r.get("timestamp", "")), " ".join(t.split())[:110])
        # A resubmitted prompt is stored twice off ONE parent with no reply between: keep the later.
        # A queued turn is stored twice too (attachment, then the record it became): keep one.
        par = r.get("parentUuid")
        samepar = bool(rows and par and par == prevpar and replies == prevrep) and resend(rows[-1][2], row[2])
        twin = bool(rows and prevatt and rows[-1][2] == row[2])
        if samepar and " ".join(t.split()) in queued and rows[-1][2] != row[2]: rows.append(row)
        elif samepar or twin: rows[-1] = row
        else: rows.append(row)
        prevpar, prevrep, prevatt = par, replies, r.get("type") == "attachment"

    out = ["", "## WHAT THE USER SAID IN THE PREDECESSOR, AND WHERE",
           f"Transcript: tx={tx}",
           "Read any row in full by its record number:",
           "  sed -n '<record>p' \"$tx\" | jq -r '(.message.content // .attachment.prompt) | if type==\"array\" then map(.text // \"\") | join(\"\") else . end'",
           f"{len(rows)} turns from the user, {replies} replies, {n} records. Skill-written prompts and other sessions' messages are excluded."]
    shown = rows
    if len(rows) > CAP:
        shown = rows[:1] + [None] + rows[-(CAP - 1):]
    for row in shown:
        if row is None:
            out.append(f"  {'':>6}  ..... {len(rows) - CAP} older turns not listed; re-run this index against $tx for all of them")
            continue
        out.append(f"  {row[0]:>6}  {row[1]}  {row[2]}")
    out += ["", SWEEP, ""]
    with open(fp, "a", encoding="utf-8") as f:
        f.write("\n".join(out))
    text = open(fp, encoding="utf-8").read()
    hs = headings(text)
    if sum(1 for h in hs if h.startswith("## SWEEP FINDINGS")) != 1 or not hs[-1].startswith("## SWEEP FINDINGS"):
        sys.exit("the first prompt must carry EXACTLY ONE '## SWEEP FINDINGS' heading and it must be the LAST — STOP")
    print("\n".join(out[:7]))
    print(f"  ... {len(shown)} rows appended; SWEEP FINDINGS heading is last")


def cmd_inherited(tx):
    for _, r in records(tx):
        if r.get("type") != "user" or r.get("isMeta"): continue
        if (r.get("origin") or {}).get("kind") == "peer": continue
        t = PASTE.sub("", flat(r.get("message", {}).get("content")))
        if t.lstrip().startswith(SKIP): continue
        if "## SWEEP FINDINGS" in t:
            print(t); return
    print("(this session received no first prompt with a findings section — every item is generation 1)")


def cmd_background(tx, fp):
    agents, bash, auto, notes = [], [], [], 0
    for _, r in records(tx):
        if r.get("type") == "assistant":
            for b in r.get("message", {}).get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use": continue
                i = b.get("input") or {}
                if b.get("name") in ("Agent", "Task"):
                    agents.append(i.get("description") or i.get("subagent_type") or "?")
                elif b.get("name") == "Bash" and i.get("run_in_background"):
                    bash.append(i.get("description") or i.get("command", "")[:80])
        elif r.get("type") == "user":
            c = r.get("message", {}).get("content")
            if flat(c).lstrip().startswith("<task-notification"): notes += 1
            for b in c if isinstance(c, list) else []:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    s = flat(b.get("content"))
                    m = re.match(r"Command did not complete .* moved to the background \(ID: ([A-Za-z0-9]+)\)", s)
                    if m: auto.append(m.group(1))
    none = lambda xs: [f"  {x}" for x in dict.fromkeys(xs)] or ["  (none)"]
    out = ["", "### BACKGROUND WORK THIS SESSION STARTED",
           "Read off the transcript, not recalled. Retiring the predecessor STOPS all of it; re-arm what",
           "still matters. To rebuild one, read its command out of the predecessor transcript:",
           "  jq -r 'select(.type==\"assistant\")|.message.content[]?|select(.type==\"tool_use\")|select((.name==\"Bash\" and .input.run_in_background==true) or .name==\"Agent\")|.input.description+\"\\n\"+(.input.command // .input.prompt)' \"$tx\"",
           "", "subagents:"] + none(agents) + [f"  task notifications received back: {notes}",
           "", "bash calls put in the background:"] + none(bash) + [
           "", "bash calls the harness backgrounded at its foreground timeout (by task id):"] + none(auto) + [""]
    with open(fp, "a", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("\n".join(out))


def cmd_check(fp, heading):
    lines = open(fp, encoding="utf-8").read().splitlines()
    idx = [i for i, l in enumerate(lines) if l == heading]
    if len(idx) != 1: sys.exit(f"'{heading}' appears {len(idx)} times, expected exactly 1 — STOP")
    for l in lines[idx[0] + 1:]:
        if l.startswith("#"): break
        if l.strip(): print(f"ok: '{heading}' has content"); return
    sys.exit(f"'{heading}' has nothing under it — an empty section reads as 'found nothing' when it means 'never ran', STOP")


def main(a):
    if len(a) >= 3 and a[1] == "index": return cmd_index(a[2], a[3]) if len(a) == 4 else sys.exit(__doc__)
    if len(a) == 3 and a[1] == "inherited": return cmd_inherited(a[2])
    if len(a) == 4 and a[1] == "background": return cmd_background(a[2], a[3])
    if len(a) == 4 and a[1] == "check": return cmd_check(a[2], a[3])
    sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
