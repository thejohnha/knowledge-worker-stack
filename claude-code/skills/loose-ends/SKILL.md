---
name: loose-ends
description: Review the current session for unfinished business before wrapping up, then RESOLVE everything that doesn't need the operator. Use when the user says "loose ends", "wrap up", "what did we miss", "review the session", "did I skip anything", "final sweep", or otherwise signals they want to close out cleanly.
---

Sweep the entire session deeply. Surface anything that should be addressed before declaring the work done. Look for SIX categories:

1. **User hints turned into tasks** — moments where the user dropped a related concern, observation, or "by the way" that wasn't acted on (e.g., "btw the X is also broken", "I noticed Y", "remind me about Z"). These are usually the most valuable finds.
2. **Questions the assistant asked that the user pivoted away from** — multi-question prompts where only some were answered, or where the user redirected to a new topic mid-thread.
3. **Promises the assistant made but didn't fulfill** — "I'll check X next", "I'll update doc Y", "let me verify Z" that never happened.
4. **Decisions deferred without resolution** — branches discussed but not closed (e.g., "A or B?" with no chosen answer).
5. **Skipped verification** — code/config changed but never tested, deployed but never confirmed working on every target host or platform.
6. **Doc / state hygiene gaps** — per project conventions (e.g., docs the change made stale, a CLAUDE.md or memory rule the session learned, a promised doc update); also straggler agents — any subagent still registered (TaskList), each idle one read then stopped, since an idle agent is often finished work whose report never arrived. A leftover row at the bottom of the session window for an agent that already finished or died is display state, not a straggler: nothing is running behind it, no tool call can see or clear it, and it goes when the session restarts. Don't chase it, and never report a clean TaskList as though it contradicted what the user can see on screen. Also WORK STILL RUNNING that this session is about to walk away from, which has three carriers:
   - **Subagents and `run_in_background` Bash calls** are both recorded in the transcript, so READ them out of the session's own jsonl rather than recalling them — the `tool_use` records named `Agent`, and the `Bash` records carrying `run_in_background` — and set each against the `<task-notification>` records that reported back: an equal count means nothing is outstanding, a short count says how many to go looking for. If the `successor` skill is installed, `claude_successor_first_prompt.py background <transcript> <out-file>` lists them mechanically.
   - **A program the command detached itself** (`nohup … &` fired from an ordinary FOREGROUND call) appears in neither, because the transcript holds only a foreground call that returned. Its one carrier is the process table: search it with `pgrep -fl` for the script names, paths or scratch-file names the session used. Drop any hit whose command line matches this shell's own, and every fork of it: `pgrep -f` matches the process running the check, and command substitution and pipelines make bash fork carrying the parent's argv, so an unfiltered scan reports the check itself as a straggler.
   - REPORT what is running; do not kill it. An agent that has gone idle is finished work whose report never arrived, but a detached program is usually still doing the thing it was started for, and the session that started it is the one with the least context left to judge. All three carriers are cheap — two reads of a file already on disk and one `pgrep` — so even a caller sweeping on a thin context budget can afford all three.

## Then ACT — never hand the list back

A swept list is not a deliverable. Default to RESOLVING each find in the same turn you found it.

- **Anything free or reversible → do it NOW, without asking.** Read-only checks, greps, log and artifact reads, test runs, dry runs, local/scratch files, uncommitted edits, email drafts, doc updates. Don't ask, don't queue it, don't offer — the answer was always going to be yes, and asking costs a round trip. Skipped verification (category 5) is nearly always this.
- **Only four things may end the turn unresolved**: a secret only the user holds, a physical action, an irreversible or outward-facing mutation, or a genuine judgment call not inferable from the repo, memory, or their past decisions. Everything outside those four is yours to finish. Say which one it is in plain English inside the sentence — "it needs your dashboard login, which I don't have" — never a bracketed tag or shorthand; that vocabulary is for your own reasoning, not for the user to read.
- **Every remaining item carries a next action, not a description.** If you can't finish it this turn, name the specific next step and take it as far as it goes unattended — draft written, command staged, subagent launched, check scheduled. "We should look at X" is not a finding, it's a shrug.
- If you wrote a recommendation, you already made the decision — go execute it.

Run independent items in parallel.

## REPORT-ONLY MODE — the single documented exception to "never hand the list back"

**This mode applies ONLY when the caller asks for it by name — for example `successor`, when its sweep step (after writing the successor's first prompt, before creating the successor's tab) runs this skill.** Name a caller by what it is DOING, never by a step number: a description of the moment survives a reorder and a number does not. Everything above remains the DEFAULT and is what you do in every other case — a sweep the user asked for by typing "loose ends" acts and resolves exactly as written. Report-only is never inferred from a busy session, a long transcript, or your own sense that the findings look expensive; if nothing in the invoking instruction named this mode, you are in the default mode and you act.

**Why the exception exists.** `successor` retires a long-running session into a fresh numbered one, and the session that invokes this sweep is retiring precisely because it is short on context. It sweeps so that the first prompt it hands the next session carries a real, swept list rather than only what the assistant happens to still remember. Acting on the findings would spend context that session does not have — and it does not need to, because its successor is already launched and has spent nothing. So the findings are appended verbatim to the first prompt and the successor does the fixing: look now, fix where the budget is.

**The sweep itself is UNCHANGED and runs at full depth and full quality.** All six categories, swept as thoroughly as they ever are. This is not a lighter, faster or cheaper sweep, and reading it as one would be a serious misreading of why the mode exists. What report-only changes is the ACTING, and only the acting.

**So: resolve nothing, fix nothing, verify nothing, launch no subagents, and write no files.** Not even the free and reversible items that the default mode tells you to do immediately without asking. Every find is recorded and handed back deliberately. The caller appends what you return to an artifact it has ALREADY written to disk — the `## SWEEP FINDINGS` section of the first prompt `successor` is composing for the session it is about to create — which is why dying part way through this sweep never means dying with nothing behind you.

**YOUR REPORT IS NOT THE END OF THE RUN — HAND THE FINDINGS BACK AND LET THE CALLER CARRY ON, IN THE SAME TURN.** In this mode you are not a sweep the user asked for; you are one step inside another skill's run, and that run has steps after you that nobody else will perform. Print the findings, and then CONTINUE with the caller's next step immediately rather than ending the turn on the report. A sweep that ends its caller's turn has broken the caller, however good the findings are.

**Distinguish an OBSERVATION from a DIAGNOSIS, and mark every diagnosis as suspected and unverified.** "This file was changed and never run" is an observation: it is a fact about what happened in the session, and it is safe to record exactly as written. "The hook is broken" is a diagnosis, and in report-only mode nothing was checked, so it must carry an explicit marker in the text itself — *suspected, not verified; nothing was run to confirm it*. That marking is load-bearing rather than decorative. Findings written into a handoff are read cold by the next session as established fact, and an unmarked guess silently becomes its starting premise, which is the most expensive kind of wrong.

**Report in the same three-part shape as below, with the first part necessarily empty**, and say plainly that it is empty because the sweep was report-only rather than because the session was clean. Every open item still carries a concrete next action rather than a description, because the next session executes from that one line and has nothing else to work from.

## Report

- **Resolved this sweep** — what you did, with the proof (output, diff, file).
- **Still open** — each with the plain-English reason it genuinely has to be the user, and the exact next action.
- **Questions you didn't directly answer** (or "none found" if clean).

If everything landed in the first section, say so plainly and end with a clean plate. Never close a sweep with a menu of things you could have done yourself.
