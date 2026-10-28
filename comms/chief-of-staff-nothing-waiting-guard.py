#!/usr/bin/env python3
"""chief-of-staff-nothing-waiting-guard.py — Stop hook: the chief of staff may not tell the user that
nothing is waiting on them unless a fresh scan says so.

The claim is the one reply the chief cannot take back: the user stops looking, and every session
still waiting on them waits longer. So a reply from the chief that says nothing is waiting
("Nothing new.", "nothing else is waiting on you", "the queue is empty") is blocked unless
claude_chief_of_staff_owed_scan.py ran under 10 minutes ago and counted 0 owed. The scan writes
that stamp to ~/.claude/state/state_claude_chief_of_staff_scan_stamp.json on every run.

Scoped to the chief alone, found the way every chief tool finds it (claude_chief_of_staff_find.py in
~/bin). Every other session pays one regex over its reply and nothing else; the finder runs only once
the claim has matched. Quoted text and a "with/if/until nothing waiting" condition are ignored, so the
chief can talk ABOUT the phrase. stop_hook_active passes, so it blocks at most once per turn;
subagents pass; any error exits 0.
"""
import json, os, re, sys, time

FRESH_SEC = 600
CLAIM = re.compile(
    r"\bnothing (else )?(is |left )?(waiting|owed|pending|queued)\b"
    r"|\bnothing else (needs|is on|for) you\b|\bnothing (else )?(needs|requires) (you|your)\b"
    r"|\b(queue|list) is (now )?empty\b"
    r"|\b(no|zero|0) (more |other )?(decisions?|items?|asks?|sessions?) (are |is )?(waiting|owed|pending|left)\b"
    r"|^\W*nothing new\W*$", re.I | re.M)
QUOTED = re.compile(r"\"[^\"\n]*\"|“[^”\n]*”|`[^`\n]*`")
# "nothing waiting" as a CONDITION, not a claim: "any session idle over 2 hours with nothing
# waiting on you gets this" describes a rule about sessions and says nothing about the queue.
CONDITION = re.compile(r"\b(with|where|when|whenever|if|once|until|while|unless|has|have|had|having)\s+nothing\b[^.\n]*", re.I)


def main():
    p = json.load(sys.stdin)
    if p.get("stop_hook_active") or p.get("agent_id"):
        return
    text = p.get("last_assistant_message") or ""
    if not isinstance(text, str) or not CLAIM.search(CONDITION.sub("", QUOTED.sub("", text))):
        return
    home = os.path.expanduser("~")
    sys.path.insert(0, os.path.join(home, "bin"))
    import claude_chief_of_staff_find as finder
    sid = p.get("session_id", "")
    if not (finder.is_chief(sid) or finder.find()[:2] == ("live", sid)):    # the live title, read from herdr
        return
    try:
        stamp = json.load(open(os.path.join(home, ".claude/state/state_claude_chief_of_staff_scan_stamp.json")))
        age, owed = time.time() - float(stamp["epoch"]), int(stamp["counts"]["owed"])
    except (OSError, ValueError, KeyError, TypeError):
        age, owed = None, None
    if age is not None and age < FRESH_SEC and owed == 0:
        return
    why = ("no scan stamp exists" if age is None else
           f"the last scan is {int(age // 60)} minutes old" if age >= FRESH_SEC else
           f"the last scan, {int(age // 60)} minutes ago, counted {owed} owed")
    print(json.dumps({
        "decision": "block",
        "reason": (f"You told the user nothing is waiting on them, but {why}. Run "
                   "claude_chief_of_staff_owed_scan.py now and report what it lists: the owed count, "
                   "then serve the top item. Say nothing is waiting only if that scan shows 0 owed."),
        "systemMessage": "🧱 chief-of-staff-nothing-waiting-guard: a 'nothing waiting' claim was sent back for a fresh scan",
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
