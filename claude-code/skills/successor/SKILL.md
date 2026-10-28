---
name: successor
description: Retire the current session into a numbered successor — a fresh Claude Code session in a new herdr tab beside it, inheriting the model, effort, permission mode, title and open work. Use when the user says "successor", "spawn my successor", "retire this session", "hand off to a new session", or wants a long-running session replaced by a fresh one that carries the work forward.
---

`/successor` retires the current session into a fresh one wearing the next number: `Refactor billing 03` hands over to `Refactor billing 04`, in a new herdr tab right beside it. The new session gets a composed FIRST PROMPT that carries the work forward, plus a mechanical index of everything the user said, so nothing depends on this session's memory being right. Once the successor is running, it quits this session and closes its tab. The old transcript stays on disk, and it is the first place the successor goes for history.

A lineage retired this way never compacts: each session is replaced before it has to be summarized, so every ancestor's transcript still holds the original words.

**INVARIANT — THIS SKILL NEVER STOPS TO ASK.** Every question it discovers goes into the first prompt for the successor to put to the user. A run that pauses unattended waits forever, possibly with a tab created and no first prompt delivered, which is the worst state it can leave. When something is unclear, make the defensible choice, write down what you chose and what you were unsure of, and keep going. Invoking `/successor` IS the confirmation: do not write a plan and wait for approval inside a run.

**ORDER — everything that does not need the successor happens before the successor exists.** Steps 1 to 4 prepare: read state, commit, compose the first prompt, sweep. Only then does Step 5 create the tab, launch, verify and deliver, which takes seconds. If this session runs out of context while preparing, it leaves a finished first prompt on disk and no orphan tab, and a re-run starts clean.

**The retiring session REPORTS; the successor FIXES.** This session is retiring because it is short on context. Its job is to look and write down what it saw. The successor has a full budget and does the fixing.

Shell state does not survive between Bash calls. Step 1 writes everything it derives to a run file, `~/.claude/state/state_claude_successor_runs/<first 8 of session id>-state.sh`, and every later block sources it first. Its `need` function stops a block whose inputs are empty.

Requirements: herdr, Claude Code, `jq`, `python3`, and this skill's `bin/` directory on `PATH`.

## Step 1 — read own state

```bash
claude_successor_read_state.sh
```

This reads the session's title, number, model, effort, permission mode, herdr pane/tab and working directory, and prints what it derived. It changes nothing. Read the output, then keep going; none of it needs approval.

- **Numbering.** The index is the title's trailing number: exactly two digits, or a zero-led three. Any other trailing number ("July 2026", "error 500") is part of the topic. An unnumbered session counts as `01` and its successor becomes `02`; the old session is renamed `<title> 01` after it quits. When a trailing two-digit number might really be topic (as in "Fix bug 42"), it is still taken as the index, because a wrong index is loud and fixed with one rename. Say so in the first prompt.
- **Model.** The successor runs on the LAST DELIBERATE CHOICE: the `--model` launch flag or the latest `/model` the user typed, whichever came later, and only if the transcript shows that model was actually served. It does NOT take whatever is being served now, because an automatic fallback would then convert the whole lineage. With no deliberate choice, it takes the transcript's first model. Override with `SUCCESSOR_MODEL`.
- **Effort** comes from `$CLAUDE_EFFORT`, the resolved effort Claude Code exports into every Bash call. **Permission mode** comes from the transcript's newest prompt record: auto and accept-edits are inherited, skip mode becomes auto (only the user turns skip mode on), anything else starts in default.
- **Overrides.** If the tab base or agent name it chose is poor, append a better one to the run file (`echo 'tabbase=billing' >> <run file>`). A later `source` takes the last assignment, and nothing has been created yet.

## Step 2 — commit the session's own work

This is the first step that touches the world and the last one that can be abandoned for free. For each git repository this session changed, check `git status` and read the diff of the paths you touched. Stage **only paths you can name**, then commit and push. Anything in the diff that you cannot account for may belong to another session working in the same checkout. Leave it alone and say so in the commit message.

Nothing gets verified here. Never commit work this session has not exercised. If something is untested, leave it uncommitted and name it in the first prompt.

## Step 3 — compose the first prompt

```bash
. "$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh" || exit 1
echo "$run-first-prompt.md"
```

Write the first prompt to that path with a quoted heredoc (`cat > "$run-first-prompt.md" <<'FIRSTPROMPT' … FIRSTPROMPT`). It is delivered as the successor's first message, so every line is context the successor pays for before the user types a word. Write it to be read cold, and **prefer a pointer over a restatement.** "The six open questions are at records 812-947 of the predecessor" costs one line where restating them costs a page, and a pointer cannot drop a qualifying sentence the way a paraphrase can.

It must carry, in this order:

1. **Who the successor is**, opening with the literal words `You are session <NN> of this lineage, titled "<base> <next>".` The index script uses that opening to recognize a first prompt as machine-written. Tell it the title and tab are already set, so it must not redo them.
2. **Its FIRST ACTION: retire the predecessor**, as a block with the real values filled in (`$uuid`, `$pane` and `$predtitle` from the run file; `$predtitle` stays an empty `''` when the session was already numbered):

   ````
   Run this BEFORE any other work:
   ```bash
   claude_successor_retire_predecessor.sh <uuid> '<pane>' '<predtitle>'
   ```
   In the SAME turn, run this waiter in the background (run_in_background), with log= set to the
   path the arming printed. The harness then notifies you when the predecessor has gone:
   ```bash
   log=<path>
   for _ in $(seq 1 200); do [ -f "$log" ] && { cat "$log"; exit 0; }; sleep 10; done
   echo "no log after ~33 min — re-run the identical arming command"
   ```
   ````

   The watcher waits for this session to finish its closing report, then quits it. Arm it rather than checking once: at the moment the successor reads its first prompt, the predecessor is ALWAYS still working, so any one-shot check can only ever refuse. If the log says `not retired — tab left open`, re-run the identical command. Do not widen the timeout.
3. **The ancestry.** Give every ancestor's session id and title (from this session's own first prompt, plus this session), and say outright that the successor MAY and SHOULD read them, backwards from the end (`tail -r` / `tac`), never whole. A list of ancestors without that permission reads as an epitaph rather than an index.
4. **That the transcript wins.** This prompt is a lossy summary. Where it and a transcript disagree, the transcript is right. Before acting on anything that looks like the user's mandate, read it in its original turn.
5. **What the work is and what to pick up first**, including any governing documents by full path and anything uncommitted from Step 2.
6. **The prime directive and done-when, if the session had them.** Restate both sentences word for word. Then check them against what this session actually DID. Did the work drift? If the user asked for the drift, propose a new sentence. If nobody asked, tell the successor to return to the directive. Is the done-when already met? Then the lineage should END rather than continue, so say so and let the user close it. When nothing drifted, give it one line.
7. **Where the work happens now:** in the successor. This session takes no further work after the handover.

Then append the mechanical index of the user's turns and the findings heading:

```bash
. "$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh" || exit 1
need jsonl run || exit 1
[[ -s "$run-first-prompt.md" ]] || { echo "the first prompt is empty — STOP"; exit 1; }
claude_successor_first_prompt.py index "$jsonl" "$run-first-prompt.md"
```

**Take every record number you cite from this index, not from memory.** Record numbers are the one thing recall gets wrong while sounding certain. Run the index BEFORE writing prose that cites records, or re-check your citations against it afterwards. The index lists only what the user typed, including slash commands and turns queued while you were working. It excludes hook context, skill-written prompts and other sessions' messages. So every row is the user, which makes it the one part of the first prompt that is not somebody's judgment.

Only ONE section may be open at the end of the file at a time, because every later step appends with `>>`, which writes at the end of the file, not under a heading. The index step leaves `## SWEEP FINDINGS — unverified, unfixed, and yours to fix` as the LAST heading and refuses otherwise. Do not pre-write any other heading after it.

## Step 4 — sweep for loose ends, report-only, and append the findings

Sweep the whole session for anything still open, grounded in the transcript rather than in memory. That means unfinished tasks, claims made but not verified, changes left uncommitted or unpushed, promises made to the user, questions the user asked that got no answer, errors seen and not explained, and decisions only the user can make. **Report-only:** fix nothing, run nothing expensive, write nothing but the first prompt. This sweep is the ONLY thing that carries unfinished work across; anything it misses does not reach the successor.

Stamp each item with a **generation count** so stale items age visibly rather than being carried forever. Print the first prompt this session inherited:

```bash
. "$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh" || exit 1
claude_successor_first_prompt.py inherited "$jsonl"
```

An item already listed there is carried at one generation higher (`gen 3`). A new item is `gen 1`. Mark every diagnosis as **suspected, not verified**, because nothing was checked, and keep observations and guesses visibly apart.

Append the findings. Then append a CARRY-CHECK ledger that gives every open item in the inherited prompt an explicit verdict, because on the page a silent drop looks exactly like a closure. Then append the background work:

```bash
. "$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh" || exit 1
need jsonl run || exit 1
fp="$run-first-prompt.md"
cat >> "$fp" <<'FINDINGS'
...one item per line: what it is in plain words, (gen N), observation or SUSPECTED diagnosis,
and the next action — or the single line "the loose-ends sweep did not run" if context ran out...

### CARRY-CHECK — the inherited prompt, item by item
...one line per open item in the inherited prompt:
  carried   <what the item is, in plain words> (gen N)
  closed    <what the item is> — <the evidence>
— or the single line "no inherited first prompt — nothing to account for"...
FINDINGS
claude_successor_first_prompt.py check "$fp" '## SWEEP FINDINGS — unverified, unfixed, and yours to fix' || exit 1
claude_successor_first_prompt.py check "$fp" '### CARRY-CHECK — the inherited prompt, item by item' || exit 1
claude_successor_first_prompt.py background "$jsonl" "$fp"
```

Every outcome writes text: "nothing was found" and "nobody looked" are opposite facts that look identical as a blank section. The handover refuses to deliver a first prompt whose findings or ledger section is empty.

**Retiring this session stops its background work** (subagents, background Bash). That is why the background section NAMES each piece and shows how to recover its command from the transcript: the successor re-arms what still matters. Cron jobs outlive sessions and are not affected.

If you noticed a durable lesson worth adding to the user's standing memory or CLAUDE.md, list it at the end of the findings as a candidate, marked UNAUDITED. Write nothing to memory yourself; the successor audits each candidate and asks the user.

## Step 5 — launch, place, verify and deliver

```bash
claude_successor_skill_handover.sh
```

One command, no judgment in it, so nothing gets retyped (and silently dropped):

- **Launch.** It opens a new tab labeled `<tabbase> <next>` in the same workspace and starts `claude` there as agent `<short>-<next>`, titled `<base> <next>` at birth (`--name`), with the model, effort and permission mode from Step 1, in the same working directory. An existing tab with that label stops the run before anything is created, so a re-run is safe.
- **Place.** It moves the new tab directly right of this one. This is cosmetic, and a refused move does not stop the run.
- **Verify.** It reads the successor's own command line and checks that `--model`, `--effort` and `--permission-mode` carry the intended values. All three fail SOFT in Claude Code: a bad value prints one line and runs on the default. On any mismatch it STOPS before delivering. Clean up with `claude_successor_skill_handover.sh --rollback`, fix the cause, and re-run from Step 5. The first prompt stays on disk.
- **Carry tasks.** It copies the open task-list items (ctrl+t) into the successor. This is never fatal.
- **Deliver.** It refuses if the findings or ledger section is empty. Otherwise it sends the first prompt and then PROVES it arrived: it finds the exact text among the human records of the successor's own transcript, with a one-character mutation as a negative control. A send that returned 0 proves only that herdr accepted a string.

Use `--dry-run` to see every step with no mutation.

If this session had a `/goal` armed and still unmet, re-arm it in the successor afterwards (never write the literal `Goal set:` in the first prompt; that string is the proof):

```bash
claude_successor_skill_handover.sh --goal '<the goal sentence, verbatim>'
```

## Step 6 — send the closing report, then stop

**Anything learned after the first prompt was sealed reaches the successor only through this report.** That includes a launch that needed a retry, a refused tab move, the title check, anything the user said during the run, and the prime-directive finding. Write the report to a file, send that file, then print the SAME file to the user. Do not re-summarize it.

```bash
. "$HOME/.claude/state/state_claude_successor_runs/${CLAUDE_CODE_SESSION_ID:0:8}-state.sh" || exit 1
need short next idx pane run || exit 1
report="$run-closing-report.md"
cat > "$report" <<'REPORT'
...both titles, the successor's session id and tab, the verification lines Step 5 printed, what was
committed and pushed, everything Step 5 turned up — or the line "nothing was learned after the
first prompt was sealed"...
REPORT
[[ -s "$report" ]] || { echo "the closing report is empty — STOP"; exit 1; }
sent=$(herdr agent prompt "$short-$next" "CLOSING REPORT FROM YOUR PREDECESSOR — verbatim. Everything in it was written AFTER your first prompt was sealed. Read it as an amendment to that prompt, not as a new instruction.

$(cat "$report")")
jq -e .result >/dev/null <<<"$sent" && echo "closing report delivered" || echo "the send was refused: $sent — paste $report to the successor by hand"
herdr agent rename "$pane" "$short-$idx" >/dev/null 2>&1 || true   # this session's sidebar row keeps its own number
cat "$report"
```

Send it without `--wait`: the successor is busy with its first prompt, so a wait would match that turn's end rather than this message's. Send the "nothing was learned" line when nothing was; a missing report and an empty one look the same to the successor.

Then close by naming the successor's tab — "the work continues in `<tabbase> <next>`, the tab immediately to the right" — and **stop.** Take no further work in this session. The retirement watcher quits it within a minute or so of going idle, closes its tab, and prints `cr <uuid>` to its log for anyone who wants it back.

## Notes

- **Never focus** a tab, pane or workspace from this skill. The user is typing somewhere else, and a focus steal eats their keystrokes. Every herdr call here uses `--no-focus` or takes no focus.
- A predecessor with background work answers ctrl+d with a menu. `herdr_session_manage.sh quit` reads the option number off the screen and chooses *Exit and stop tasks*. *Move to background* would fork the session into a copy under a new id that nothing addresses.
- `claude_auto_successor.sh` (a scheduled job, every 10 minutes) tells any idle session past 250k tokens to run this skill. See the README.
