---
name: prime-directive
description: Show, set, change or close the current session's prime directive and done_when. Use when the user says "/prime-directive", asks whether this session has a prime directive or a done_when, wants to set or reword either, or says this session's work is finished and should be closed out.
---

Every session carries two sentences: **prime directive** (what the session is for) and **done_when** (the condition that ends it). A hook re-injects both every turn, but only to the ASSISTANT — the user cannot see them any other way, which is what this skill is for.

## Step 1 — read this session's entry

```bash
uuid="${CLAUDE_CODE_SESSION_ID:?run this inside the Claude Code session}"
lin="$HOME/.claude/state/state_claude_session_title_lineage.json"
echo "uuid: $uuid"
jq -r --arg s "$uuid" '.[$s] // {} | "prime_directive: \(.prime_directive // "(UNSET)")\ndone_when:       \(.done_when // "(UNSET)")\nclosed:          \(.closed // false)"' "$lin" 2>/dev/null \
  || printf 'prime_directive: (UNSET)\ndone_when:       (UNSET)\nclosed:          false\n'
```

## Step 2 — branch

**Both set, no argument.** Print them back verbatim, two lines, stop. The user asked what they are, not for a change.

**Either UNSET.** Propose both in ONE line and wait. Write nothing before the user answers. A `done_when` must be OBSERVABLE (a command, file or number decides it), POSITIVE (an event, not an absence), SELF-SATISFIABLE (crossed without the user speaking) and NOT THE LIFECYCLE (a handover, spawn or context threshold does not satisfy it). Test it first — this refuses nothing and always exits 0:

```bash
claude_session_prime_directive.sh check "<the done_when you are about to propose>"
```

An OPERATOR-GATED warning usually means quiescence is the right shape: `<artifact> goes <N days> with no <change signal>`. The digit makes it observable, and unlike `never` it closes itself. Keep the literal `never` for a standing role such as a watcher. A session that OWNS a running thing takes the sibling shape instead — `<N> days with no unplanned fix to <the owned surface>`, default 30 — because an owner is finished when the thing stops BREAKING, not when everyone stops touching it. A fix repairs unintended behavior; planned feature and doc work is not a fix and must not reset the clock.

**The strongest shape adds a VOLUME FLOOR to the clock and NAMES what counts it.** A bare quiet clock cannot tell FIXED from UNUSED — nobody touching a thing satisfies it exactly as well as the thing working. A floor closes that gap: the window only counts if the artifact was exercised across it. For example:

> the import job goes 14 days, across at least 200 runs, with zero rejected rows — counted by `grep -c REJECTED import.log`

It beats a plain clock three ways: a second digit that quiet alone cannot fake, a target measuring the OUTCOME the user sees rather than the commits an author made, and a named counter, so `met` runs a command instead of forming an opinion. Two cautions. It is phrased as an ABSENCE, which the POSITIVE rule normally refuses — the two digits are what rescue it. And it is only as true as its counter: a detector with a blind spot reports zero for "clean" and for "cannot see it" alike. Before settling for a plain clock, ASK whether the work throws off a stream to count — logs, requests, runs, handovers. Where one exists the floor is owed; where none does, the plain clock is the honest shape.

**If no draft you can write passes `check`,** say so in one line beside your best draft: the session cannot yet say what finished looks like, and a short conversation about what "done" means comes first. A passing `check` is a floor, not a verdict: it catches VAGUENESS, not misunderstanding.

Then, quoting every argument because an unquoted one is refused:

```bash
claude_session_prime_directive.sh set "$uuid" "<prime directive>" "<done_when>"
```

**Argument `met`.** Answer one question: is the `done_when` true YET? Do not close anything and do not change anything.

Work out what decides it and RUN that, rather than reasoning about it — quiescence is `git log -1 --format=%ct -- <the scoped paths>`, a count is the count, an artifact is `test -f`. Print what you ran and what it returned, then answer MET or NOT MET in one line, with the number that decides it. If nothing in the sentence can be run, say so plainly: that is a badly written `done_when` and the repair is `set`, not a judgment call.

Where the condition counts UNPLANNED FIXES rather than any change, no command settles it alone: run `git log --since` over the owned paths and show the commits with your verdict on each, so the user can disagree with the classification.

If it is MET, say so and stop. Offer `/prime-directive close` and wait — closing is a separate instruction, because a met condition is a fact and closing is a decision.

**Argument `close`.** Run the `met` branch first and only continue if it said MET. Name the fact that makes it met; if you cannot, stop — an unmet `done_when` calls for `/successor` (if installed), never a close.

```bash
claude_session_prime_directive.sh close "$uuid"
```

It closes every earlier generation of a numbered series too: each gets the `closed` flag, which silences its per-turn reminder, and an unmarked one also gets ☑️ in its title. Report both counts it prints. The ☑️ takes the marker slot and leaves the rest of the title unchanged.

A `done_when` of `never` is refused here, correctly: closing would silence the per-turn reminder. If a standing role truly ended, that is a CHANGE of the `done_when`, so `set` a real one saying why it ends, then close.

**Argument `set`, or a reword.** As the UNSET branch: propose, show the exact text, wait, write. `set` clears `closed`, so re-settling is the reopen.

**Argument `audit`.** `claude_session_prime_directive.sh audit` screens every live `done_when` on disk with the same test as `check`; report what it prints.

## Step 3 — report

Give the user the two sentences as they now stand, verbatim, and nothing else.
