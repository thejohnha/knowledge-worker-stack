# Claude Code add-ons

Small pieces that make long Claude Code days easier: a sign-in that stops the macOS password pop-ups, a status bar, dated session titles, a hand-off from a long session to a fresh one, a stated purpose for every session, safety hooks, backups, and a few commands for when a reply doesn't land. Take any subset; where one piece needs another, its section says so.

| Piece | What you get |
|:---|:---|
| [1. Token sign-in](#1-sign-in-with-a-long-lived-token) | No more Keychain password pop-ups when Claude Code starts. |
| [2. Status line](#2-status-line) | Model, context size, usage left, git state and cost under the input box. |
| [3. Dated titles](#3-dated-session-titles) | Every new session is titled `20261028 <topic>` on its own. |
| [4. `/retitle`](#4-retitle) | Rewrite a drifted title, keeping where the session started. |
| [5. `/successor`](#5-successor) | Hand a long session to a fresh one in a new tab, numbered `02`, `03`… |
| [6. `/loose-ends`](#6-loose-ends) | Sweep the session for unfinished business, then finish it. |
| [7. Model list sync](#7-model-list-sync) | Keeps the `/model` list current under the token sign-in; tells you when a new model ships. |
| [8. Clock](#8-the-time-on-every-message) | Claude knows the date and time on every message. |
| [9. Skip mode and account switch](#9-restart-in-skip-mode-or-on-another-account) | Type `skip` to restart the session without permission prompts; move a session to another account. |
| [10. Prime directive](#10-prime-directive) | Every session states what it is for and when it is done; Claude is reminded every turn. |
| [11. Pinned status line fix](#11-pinned-status-line-fix) | Brings back the status line and input box when they start scrolling away. |
| [12. Continue after a lost connection](#12-continue-after-a-lost-connection) | Types "continue" for you into sessions that stopped because the Mac went offline. |
| [13. `/bro` and `/wait-what`](#13-bro-and-wait-what) | Ask for the last reply again, plainer. |
| [14. Rundown reply style](#14-rundown-reply-style) | Replies as a status board: a one-line TL;DR, then a checklist. |
| [15. Memory backup](#15-memory-backup) | Hourly local backup of Claude's memory files, with history. |
| [16. Safety hooks](#16-safety-hooks) | Scoped git commits when several sessions share a repo; a reason for every silent deny rule. |
| [17. Folder notes (CONTEXT.md)](#17-folder-notes-contextmd) | A folder's own conventions reach Claude the first time it reads or writes there. |
| [18. Tool rules on first use](#18-tool-rules-on-first-use) | Rules for a tool stay out of CLAUDE.md and reach Claude the first time a session runs that tool. |
| [19. Keep old sessions, no idle compaction](#19-keep-old-sessions-no-idle-compaction) | Old sessions stay resumable instead of being deleted after 30 days; an idle session is not summarized behind your back. |
| [20. Verified clipboard copy](#20-verified-clipboard-copy) | When Claude says "it's on your clipboard", it checked. |

Run every block from this folder (`cd /path/to/knowledge-worker-stack/claude-code`). Scripts go to `~/bin`; if you have not set that up for another folder of this repo:
```bash
mkdir -p ~/bin
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```
When you are done installing, open a new terminal and restart Claude Code: the skills and hooks call the scripts in `~/bin` by name, and only a new shell has `~/bin` on its PATH.

## More than one Claude account (optional)
Most people have one and can skip this. If you run Claude Code under separate subscriptions, each in its own `CLAUDE_CONFIG_DIR`, list them once in `~/.config/knowledge-worker-stack/accounts.json`:
```json
{"default": "~/.claude", "project-b": "~/.claude-project-b"}
```
- No file means one account, `default`, at `~/.claude`.
- The status line shows the first letter of a non-default account; the model list sync works through every account listed.
- Each account's token (piece 1) lives in its own config dir as `.oauth_token`.
- Install the hook below so each session remembers its account: it records every session started under a non-default account in `~/.claude/state/state_claude_session_accounts.json` (session id → account name; no entry means default), which `cr` and `herdr_session_manage.sh` ([`../herdr/`](../herdr/)) read to resume a session on the account it belongs to. Needs `jq`.
```bash
mkdir -p ~/.claude/hooks && cp hooks/tag-session-account.sh ~/.claude/hooks/ && chmod 755 ~/.claude/hooks/tag-session-account.sh
```
Merge into `~/.claude/settings.json` (keep existing `SessionStart` entries; every account dir must use these settings):
```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "bash ~/.claude/hooks/tag-session-account.sh", "timeout": 5 }
] } ] } }
```
Remove: delete that entry, then `rm ~/.claude/hooks/tag-session-account.sh`.

## 1. Sign in with a long-lived token
On a Mac, Claude Code keeps its claude.ai login in the Keychain, and macOS asks for your password whenever a Claude Code update changes the program reading it. A long-lived token from `claude setup-token` replaces that login: it sits in a file only you can read, it is handed to the `claude` command alone as it starts, and the Keychain item is deleted so there is nothing left to prompt for.

**Before you start, know what you give up:**
- **Claude in Chrome stops working.** The Chrome extension pairs only with a claude.ai login. If you use it, skip this piece.
- **The `/model` list freezes.** A token cannot fetch the server's model list, so a newly released model never shows up in `/model` (`claude --model <id>` still works). Piece 7 fixes this.
- **A leaked token is hard to kill.** It lasts about a year. Revoking it at https://claude.ai/settings/claude-code can take days to take effect, there is no list of where it is being used, and minting a new token does NOT revoke the old one. Guard the file like a password.

### Install
1. In a Terminal window of your own (not inside Claude Code), run the command below and finish the sign-in in the browser it opens. It prints a token starting `sk-ant-oat`; copy it.
```bash
claude setup-token
```
2. Have Claude Code store it. A dialog asks you to paste it ([`ask_secret.sh`](../secret-dialog/)), so it never appears on screen or in a transcript:
```bash
mkdir -p ~/.claude
(umask 077; ~/bin/ask_secret.sh "Paste the Claude Code token (sk-ant-oat...)" | tr -d '[:space:]' > ~/.claude/.oauth_token)
chmod 600 ~/.claude/.oauth_token
grep -q '^sk-ant-oat' ~/.claude/.oauth_token && echo "token stored"
```
3. Give it to `claude` each time it starts, without ever printing it. This adds a small `claude` function to `~/.zshrc` that reads the token file of the account in use and sets it on that one command; it is never exported, so nothing else your terminal runs sees it:
```bash
grep -q 'Claude Code: sign in with the long-lived token' ~/.zshrc 2>/dev/null || cat >> ~/.zshrc <<'EOF'
# Claude Code: sign in with the long-lived token in <config dir>/.oauth_token instead of the Keychain
claude() { local t="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.oauth_token"; if [ -s "$t" ]; then CLAUDE_CODE_OAUTH_TOKEN="$(cat "$t")" command claude "$@"; else command claude "$@"; fi; }
EOF
```
4. Check the token works on its own:
```bash
CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.claude/.oauth_token)" claude -p "reply with exactly: ok"    # ok
```
5. Delete the Keychain login, which is what causes the pop-ups:
```bash
security delete-generic-password -l "Claude Code-credentials" >/dev/null && echo "Keychain item deleted"
```
6. Quit every Claude Code session and open a new terminal. `claude` starts with no password prompt.

- Why step 5 is not optional: Claude Code still reads the Keychain item at startup even when the token is set, and that read is the pop-up. Worse, if that stored login expires, it can beat the token in an interactive session and every message fails with "OAuth access token has expired". Deleting it removes both problems.
- Another account: sign in to claude.ai as that account, run `claude setup-token`, store the token as `<its config dir>/.oauth_token` the same way, and start it with `CLAUDE_CONFIG_DIR=<dir> claude`; the function picks that dir's token. Never use `/login` in a config dir that runs on a token.
- The running session still holds the token, as it must, so a command Claude runs could read it. To stop Claude's own Read tool opening the file, merge `{ "permissions": { "deny": ["Read(~/.claude/.oauth_token)"] } }` into `~/.claude/settings.json` (one entry per account dir). It does not stop a shell command such as `cat`.
- The status line (piece 2) warns `⚠tok330d` in yellow from day 330 and red from day 355, counted from when the token file was written. Re-mint before it runs out.

### Remove it
```bash
sed -i '' '/Claude Code: sign in with the long-lived token/d; /^claude() { .*oauth_token/d' ~/.zshrc
rm ~/.claude/.oauth_token
```
Then revoke the token at https://claude.ai/settings/claude-code, open a new terminal, start `claude` and type `/login`.

## 2. Status line
Two lines under the input box:
```text
mymac | Sonnet 5.5 high | Cx:162k | 📁 ~/project | 🌿 main ~2 ↑1
●●○○○ 1.9h | ●●○○○ 40% 4.6d ▲1.8× | 5MB abcd1234 | +12/-3 lines | $3⏱️1.1h
```
- Line 1: computer name, model and effort, the account letter (other accounts only), the context in use, the folder, and git branch with staged (`+`), modified (`~`), ahead (`↑`) and behind (`↓`) counts.
- `Cx:` is the tokens in the model's context window right now: green under 150k, yellow from 150k, red from 200k or when the window is nearly full. Past roughly 150k a model starts to lose track of early detail; that is the time to finish up or hand over (piece 5).
- Line 2: the bubbles are what is LEFT of your 5-hour and weekly usage. The 5-hour % appears only below 30%. The weekly `▲1.8×` appears only when you are using the week faster than it lasts (1.8 times the even pace); silence means fine. Then transcript size, session id, lines changed, cost and time.
- Usage shows `usage: —` for the first few seconds of a session, and on accounts that don't report usage (API keys).

### Install
```bash
cp statusline.py ~/.claude/statusline.py
```
Merge into `~/.claude/settings.json` (keep everything already in it):
```json
{ "statusLine": { "type": "command", "command": "python3 ~/.claude/statusline.py" } }
```
It shows on the next message in any session.

### Remove it
Delete the `statusLine` block from `~/.claude/settings.json`, then `rm ~/.claude/statusline.py`.

## 3. Dated session titles
A hook that titles every new session `YYYYMMDD <topic>`, using the topic Claude Code generates on its own, so `claude --resume` lists sessions by day. The date is fixed at the first message; the topic follows Claude Code's own title as it settles. Once you `/rename` a session yourself, the hook leaves it alone for good.

### The title convention
```text
20261028 project-b Refactor billing 03
└ date ┘ └ cat.  ┘ └ topic        ┘ └ lineage number ┘
```
- **Date**: the day the session (or, for a successor, the line of sessions) began.
- **Category** (optional): a word from your list, chosen by Claude's smallest model on the first message. See below.
- **Topic**: Claude Code's own auto-title, or your words via `/retitle` (piece 4).
- **Lineage number**: added by `/successor` (piece 5). A session that hands over to a fresh one becomes `01` and its successor `02`, and so on, so a long piece of work reads as one numbered series.

### Install
```bash
mkdir -p ~/.claude/hooks && cp hooks/date-prefix-title.sh ~/.claude/hooks/ && chmod 755 ~/.claude/hooks/date-prefix-title.sh
```
Merge into `~/.claude/settings.json`:
```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "bash ~/.claude/hooks/date-prefix-title.sh", "timeout": 10 }
] } ] } }
```
If `UserPromptSubmit` already has entries, add this one to its list rather than replacing them. New sessions get their title from the first message.

### Categories (optional)
Create `~/.config/knowledge-worker-stack/session-categories.txt`, one `WORD - what belongs there` per line; the last line is the fallback when nothing fits:
```text
project-a - client A: their reports, servers and email
reading - articles, books and notes
home - errands and repairs
other - anything else
```
- Each new session then costs one tiny call to Claude's smallest model (about 600 tokens), run in the background so you never wait. The answer shows from the second message.
- Words are letters, digits, `-` and `_`. No file means no category and no call.

### Remove it
Delete the hook entry from `~/.claude/settings.json`, then `rm ~/.claude/hooks/date-prefix-title.sh ~/.claude/state/state_claude_session_titles.json`, plus `rm ~/.config/knowledge-worker-stack/session-categories.txt` if you made one. Titles already written stay.

### Known limits
- Needs `python3`. Without it the hook does nothing and the message still goes through.
- A session that already existed before the hook was installed keeps its title if it had one, and is judged on its last 4 MB if it is very large.

## 4. /retitle
Type `/retitle` when a session's title no longer says what it is doing. Claude writes a new title that leads with the current topic and keeps a breadcrumb of where the session started:
```text
20261028 project-b train tickets, originally: spring trip plan, then: hotel shortlist 03
```
- The breadcrumb is stored as data in `~/.claude/state/state_claude_session_title_lineage.json`, so the starting topic is copied word for word every time, never re-summarized.
- It quotes the old title back to you before applying the new one.
- Needs piece 3 (it hands the title to that hook so it sticks) and `jq` (built into macOS 15 and later; otherwise `brew install jq`).

### Install
```bash
mkdir -p ~/.claude/skills/retitle && cp skills/retitle/SKILL.md ~/.claude/skills/retitle/
```

### Remove it
`rm -r ~/.claude/skills/retitle ~/.claude/state/state_claude_session_title_lineage.json`

## 5. /successor
When a session gets long, `/successor` retires it into a numbered successor: `Refactor billing 03` becomes `Refactor billing 04` in a new tab right beside it, with the same model, effort, permission mode (skip mode comes back as auto) and working directory. The successor starts from a composed first prompt that carries the work forward, plus a mechanical index of everything you typed. Then it quits the old session and closes its tab.

The retiring session never compacts, so its transcript keeps your original words, and the successor is told to read it whenever the first prompt and the record disagree.

Also included: `claude_auto_successor.sh`, a scheduled job that tells any idle session past 250,000 tokens of context to run `/successor` on its own.

### Requirements
- Claude Code running inside herdr, with `herdr_session_manage.sh` installed from [`../herdr/`](../herdr/).
- `jq` and `python3`.

### Install
```bash
mkdir -p ~/.claude/skills/successor && cp skills/successor/SKILL.md ~/.claude/skills/successor/
cp bin/claude_successor_read_state.sh bin/claude_successor_first_prompt.py bin/claude_successor_skill_handover.sh \
   bin/claude_successor_retire_predecessor.sh bin/claude_copy_task_list_to_successor.py bin/claude_auto_successor.sh ~/bin/
chmod 755 ~/bin/claude_successor_* ~/bin/claude_copy_task_list_to_successor.py ~/bin/claude_auto_successor.sh
```
Also install the task-list hook. Claude Code files a session's task list (ctrl+t) under its session id, but a RESUMED session opens a fresh, empty list under a new id, so items added after a resume would be missed when they are carried to the successor (and the panel comes back blank). The hook points the new list at the session's own.
```bash
mkdir -p ~/.claude/hooks && cp hooks/pin-task-list-to-session.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `SessionStart` entries):
```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "python3 ~/.claude/hooks/pin-task-list-to-session.py", "timeout": 10 }
] } ] } }
```

Recommended: allow the one command the successor runs as its very first action, so it is never held at a permission prompt. Merge into `~/.claude/settings.json`:
```json
{ "permissions": { "allow": ["Bash(claude_successor_retire_predecessor.sh:*)"] } }
```
Then type `/successor` in any Claude Code session running in herdr.

### What it does
| Step | What happens |
|---|---|
| 1 | `claude_successor_read_state.sh` reads the session's title, number, model, effort, mode, pane and tab |
| 2 | the session commits its own work |
| 3 | it writes the first prompt, then `claude_successor_first_prompt.py index` appends an index of your turns |
| 4 | it sweeps for loose ends (report-only) and appends them, with a ledger of inherited items and a list of background work |
| 5 | `claude_successor_skill_handover.sh` opens the tab, launches, verifies the launch flags, carries the task list, delivers the first prompt and proves it arrived |
| 6 | the session sends a closing report to the successor and stops; the successor quits it via `claude_successor_retire_predecessor.sh` |

### Configuration
| Variable | Used by | Default |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | all | `~/.claude` |
| `SUCCESSOR_CWD` | read_state | the predecessor's working directory |
| `SUCCESSOR_MODEL` | read_state | the last model deliberately chosen (launch flag or `/model`) |
| `SUCCESSOR_EFFORT` | read_state | the session's current effort |
| `HERDR_SOCKET_PATH` | handover (tab placement) | `~/.config/herdr/herdr.sock` |
| `RETIRE_POLL`, `RETIRE_POLLS` | retire_predecessor | 20 s, 90 polls |

### The auto-successor job
Every run, `claude_auto_successor.sh` looks at every Claude pane in herdr. It tells a session to run `/successor` when all of these hold:
- the session is idle
- its transcript has not changed for 30 minutes
- the last response's context (input + cache read + cache creation tokens) is over the threshold
- the input box holds no draft

Each session is told at most once, and at most one session per run. The log at `~/Library/Logs/knowledge-worker-stack/claude_auto_successor.log` doubles as its memory.

A LaunchAgent runs it every 10 minutes. launchd starts jobs with a bare PATH, so the plist names the folders holding `herdr`, `jq`, `python3` and the scripts. Unquoted `EOF` on purpose: the shell writes your real paths into the file now.
```bash
mkdir -p ~/Library/Logs/knowledge-worker-stack
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-auto-successor.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-auto-successor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_auto_successor.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/bin:$HOME/.local/bin:$(brew --prefix)/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_auto_successor_launchd.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-auto-successor.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-auto-successor.plist
```

| Variable | Default |
|---|---|
| `SUCCESSOR_THRESHOLD` | `250000` tokens — add it to the plist's `EnvironmentVariables` to change it |
| `SUCCESSOR_IDLE_MIN` | `30` minutes |
| `SUCCESSOR_EXCLUDE` | space-separated session-id prefixes to leave alone |
| `SUCCESSOR_LOG` | `~/Library/Logs/knowledge-worker-stack/claude_auto_successor.log` |
| `SUCCESSOR_DRY=1` | list every session that qualifies now, send nothing (a real run tells only the first one per run) |

Why 250k: a fresh successor starts at roughly 30-70k tokens, so it can never trip the threshold at birth.

### Remove it
Delete the permission rule and the task-list hook entry, then:
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.claude-auto-successor
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-auto-successor.plist
rm -r ~/.claude/skills/successor ~/.claude/hooks/pin-task-list-to-session.py
rm ~/bin/claude_successor_* ~/bin/claude_copy_task_list_to_successor.py ~/bin/claude_auto_successor.sh ~/Library/Logs/knowledge-worker-stack/claude_auto_successor*.log
```

### Known limits
- herdr only: without it, Step 1 stops before anything is created.
- The successor bills the same account as the old session, read from `~/.claude/state/state_claude_session_accounts.json` (the account hook above writes it; no entry = default).
- `claude_copy_task_list_to_successor.py` copies the open items of the task list (ctrl+t) to the successor; completed items stay behind on purpose.
- With piece 10 installed, the successor starts with the same prime directive and done_when, and the auto-successor job never hands over a session whose lineage was closed.
- `claude_session_lineage_latest.py <session id>` prints the newest session of that numbered series (`<id> <number> <title> <open|closed>`, tab-separated). Other tools use it to find where the work went, for example the comms manager in [`../comms/`](../comms/). Install it with `cp bin/claude_session_lineage_latest.py ~/bin/ && chmod 755 ~/bin/claude_session_lineage_latest.py`.

## 6. /loose-ends
Type `/loose-ends` (or "wrap up", "what did we miss") before closing a session. Claude sweeps the whole session for six kinds of unfinished business — side remarks never acted on, questions you skipped, promises not kept, decisions left open, changes never tested, and docs or background jobs left behind — then FINISHES everything that doesn't need you and lists only what does, each with its next step.

`/successor` uses the same sweep in a report-only mode: it records the findings for the successor instead of fixing them.

### Install
```bash
mkdir -p ~/.claude/skills/loose-ends && cp skills/loose-ends/SKILL.md ~/.claude/skills/loose-ends/
```

### Remove it
`rm -r ~/.claude/skills/loose-ends`

## 7. Model list sync
Under the token sign-in (piece 1) the `/model` list never refreshes, so a newly released model in any family beyond Opus, Sonnet and Haiku (Fable, for one) never appears. `claude_model_picker_sync.py` reads the model list out of the Claude Code program itself, which updates on its own, checks each candidate with a one-token request per account, and writes the ones your account can use into the `/model` list. Opus, Sonnet and Haiku need no help; Claude Code lists those itself.

It also tells you when a new model ships: the first run after a Claude Code update compares the program's model list with the last one it saw, and alerts on anything new.
- Alerts go through `mattermost_post.py` from [`../comms/`](../comms/) when it is installed in `~/bin`: a Mattermost message when that is set up there, else a macOS notification. Without it, a macOS notification.
- Accounts come from `~/.config/knowledge-worker-stack/accounts.json` (above); an account without a `.oauth_token` file is skipped.
- Between Claude Code updates a run does nothing and takes about 10 ms.

### Install
Only with the token sign-in, and after it: finish piece 1 first. Without a token there is nothing for this job to fix.
```bash
cp bin/claude_model_picker_sync.py ~/bin/ && chmod 755 ~/bin/claude_model_picker_sync.py
~/bin/claude_model_picker_sync.py --dry-run     # lists the models it would check; changes nothing
~/bin/claude_model_picker_sync.py               # first run: checks and writes; new sessions see the list
```
Run it every 3 hours. A LaunchAgent rather than cron, because the macOS notification needs your login session. Unquoted `EOF` on purpose: launchd cannot expand `$HOME`, so the shell writes your real path into the file now.
```bash
mkdir -p ~/.claude/state
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-model-picker-sync.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-model-picker-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$HOME/bin/claude_model_picker_sync.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>10800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.claude/state/state_claude_model_picker_sync.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.claude/state/state_claude_model_picker_sync.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-model-picker-sync.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-model-picker-sync.plist
```

### Use
- `claude_model_picker_sync.py --force` re-checks every model and rewrites the list, for example after your plan changes.
- Its record is `~/.claude/state/state_claude_model_picker_sync.json`; its output is in the `.log` beside it.

### Remove it
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.claude-model-picker-sync
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-model-picker-sync.plist ~/bin/claude_model_picker_sync.py
rm ~/.claude/state/state_claude_model_picker_sync.*
```
The `/model` list keeps what was last written; it is a list of names, harmless to leave.

### Known limits
- Finds Claude Code at `~/.local/bin/claude` (the native installer), else on PATH, else in `/opt/homebrew/bin` or `/usr/local/bin`.
- Without a `.oauth_token` file for any account it does nothing: the `/model` list only freezes under the token sign-in.
- It reads the model list out of the program's own text. If a Claude Code update changes that format, the script finds no models and writes an empty list; `--dry-run` shows `0 models in registry` when that happens.
- Each new model costs one tiny request per account, once.

## 8. The time on every message
The model has no clock. It knows the date only from what is in front of it, so in a long session it guesses at "today", "this morning" or "two hours ago", and gets deadlines wrong. One line, added to every message you send, fixes that:
```text
Now: 2026-10-28 14:00 EDT (Wed)
```

### Install
Merge into `~/.claude/settings.json` (keep existing `UserPromptSubmit` entries):
```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "date '+Now: %Y-%m-%d %H:%M %Z (%a)'", "timeout": 5 }
] } ] } }
```
- Costs about 20 tokens a message. Claude sees the line; you don't.

### Remove it
Delete that entry from `~/.claude/settings.json`.

## 9. Restart in skip mode, or on another account
Type `skip` (the bare word, nothing else) and the session restarts itself in **skip mode** in the same tab, with its whole conversation, then carries on by itself. The same script moves a session to another Claude account.

Only you turn skip mode on, by typing `skip`. No permission rule lets a session run the restart script unasked and no CLAUDE.md line tells Claude to; `herdr_session_manage.sh` never starts or resumes a session in skip mode and refuses to send another session the word `skip`; and a `/successor` of a skip-mode session starts in auto mode.

**What skip mode is, and its risk.** Skip mode is Claude Code's `--dangerously-skip-permissions` (`bypassPermissions`): Claude runs every command and edits every file without asking you and without the auto-mode safety check. It is fast and it removes the guard rail. A misunderstood instruction, a bad command, or instructions planted in a web page, email or file Claude reads can delete or overwrite data, send things out under your name, or run anything your user account can run — and nothing stops to ask first. Use it only for a session whose work you trust, on a machine with backups; never for a session that reads untrusted content (email, the web, shared documents).

- `skip`: the word never reaches Claude. A hook arms the restart and shows you a one-line notice; the session quits once idle and comes back in skip mode a few seconds later, then gets told to continue.
- Stays in skip mode: a session that was in skip mode and is resumed without it (after a reboot, or by a plain `claude --resume`) restarts itself back into skip mode, at most once per 15 minutes. It tells the model the restart is coming.
- Account switch: ask Claude to run `claude_restart_session.sh --account project-b` (`--account default` to go back); Claude Code asks you to approve it each time. It changes who is billed; the conversation stays. Accounts come from `accounts.json` (above); a non-default account needs its token (piece 1).
- Model and effort carry over; `--model`/`--effort` change them in the same restart.

### Requirements
- Claude Code running inside herdr, with `herdr_session_manage.sh`, `claude_session_transcript.sh` and `cr` installed from [`../herdr/`](../herdr/).
- `jq` and `python3`.

### Install
```bash
cp bin/claude_restart_session.sh ~/bin/ && chmod 755 ~/bin/claude_restart_session.sh
mkdir -p ~/.claude/hooks && cp hooks/restart-in-skip-mode-on-skip.sh hooks/keep-skip-mode-across-resume.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing entries in each list):
```json
{
  "hooks": {
    "UserPromptSubmit": [ { "hooks": [
      { "type": "command", "command": "bash ~/.claude/hooks/restart-in-skip-mode-on-skip.sh", "timeout": 20 }
    ] } ],
    "SessionStart": [ { "hooks": [
      { "type": "command", "command": "python3 ~/.claude/hooks/keep-skip-mode-across-resume.py", "timeout": 10 }
    ] } ]
  }
}
```
Also install the task-list hook from piece 5, so the task list survives the restart.

### Use
- Each restart prints a log path under `$TMPDIR`; one line per restart also goes to `~/.claude/state/state_claude_session_restarts.log`.
- If the resume half fails, the log names the one command to paste in that tab: `cr <session id> --dangerously-skip-permissions`.
- A session that is never idle within 10 minutes is left running, unchanged. An account switch is already recorded by then and applies at the next resume.
- The restart waits while you have unsent text in the input box.

### Remove it
Delete the two hook entries, then:
```bash
rm ~/bin/claude_restart_session.sh
rm ~/.claude/hooks/restart-in-skip-mode-on-skip.sh ~/.claude/hooks/keep-skip-mode-across-resume.py
rm -f ~/.claude/state/state_claude_session_keep_skip_mode.* ~/.claude/state/state_claude_session_restarts.log
```

### Known limits
- herdr only. Outside herdr the `skip` word is answered with "not armed", and a resume out of skip mode is left as it is.
- A tool that wakes sessions on outside events can keep a woken session in auto mode, on purpose, since nobody is watching it: it stamps the session in `~/.claude/state/state_claude_frontdesk_wakes.json` (session id → Unix time) just before resuming it, and a stamp under 15 minutes old wins. No file, no effect.

## 10. Prime directive
Every session carries two sentences: the **prime directive** (what the session is for) and **done_when** (the fact that will be true when it is finished). A hook puts both in front of Claude on every message, so a long session stays on its job. If they are not set after three messages, it asks you for them. `/prime-directive` shows, sets, changes or closes them.
- A good done_when is decided by a command, a file or a number ("the CSV imports with zero rejected rows"). `claude_session_prime_directive.sh check "<sentence>"` warns about the shapes that never finish: tied to a hand-off, waiting on you to say so, or an absence with no time window.
- `/prime-directive met` runs whatever decides it and answers MET or NOT MET. `/prime-directive close` marks the session finished: its reminder stops, and with piece 3 its title gets ☑️, along with the earlier numbered sessions of the same series.
- Use `never` as the done_when for a standing job, such as a watcher. Close refuses it.
- `claude_session_prime_directive.sh audit` screens every live done_when at once.
- The sentences live in `~/.claude/state/state_claude_session_title_lineage.json` (fields `prime_directive`, `done_when`, `closed`), beside `/retitle`'s data. The grid in [`../herdr/grid/`](../herdr/grid/) and the chief of staff in [`../comms/`](../comms/) read the same fields.
- Costs about 30 tokens a message once set.

### Install
```bash
cp bin/claude_session_prime_directive.sh ~/bin/ && chmod 755 ~/bin/claude_session_prime_directive.sh
mkdir -p ~/.claude/skills/prime-directive ~/.claude/hooks
cp skills/prime-directive/SKILL.md ~/.claude/skills/prime-directive/
cp hooks/session-prime-directive.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `UserPromptSubmit` entries):
```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [
  { "type": "command", "command": "python3 ~/.claude/hooks/session-prime-directive.py", "timeout": 5 }
] } ] } }
```
Needs `jq` and `python3`.

### Remove it
Delete the hook entry, then `rm -r ~/.claude/skills/prime-directive ~/.claude/hooks/session-prime-directive.py ~/bin/claude_session_prime_directive.sh`. The sentences stay in the lineage file, harmless.

## 11. Pinned status line fix
Claude Code keeps the status line and input box pinned by drawing on the terminal's alternate screen ("fullscreen"). After repeated failures to enter it, it turns fullscreen off for good, silently, and from then on the footer scrolls away with the conversation. A herdr restart, which relaunches every session at once, is the suspected cause. `claude_fix_status_line_lost_on_scroll.py` removes that setting (`fullscreenAutoDisabled` in each account's `.claude.json`), backing the file up first.
```bash
cp bin/claude_fix_status_line_lost_on_scroll.py ~/bin/ && chmod 755 ~/bin/claude_fix_status_line_lost_on_scroll.py
~/bin/claude_fix_status_line_lost_on_scroll.py --check    # is any account affected?
~/bin/claude_fix_status_line_lost_on_scroll.py            # fix every affected account
```
- It covers every account in `accounts.json`. Sessions already running keep what they started with; new ones get the pinned footer back.
- The restart-and-restore in [`../herdr/`](../herdr/) runs it after each restore when it is installed.
- `--help` prints its usage. Log: `~/Library/Logs/knowledge-worker-stack/claude_fix_status_line_lost_on_scroll.log`. Remove: `rm ~/bin/claude_fix_status_line_lost_on_scroll.py`.

## 12. Continue after a lost connection
When Claude Code loses the connection, it retries for a while, then stops and waits for you to type "continue". `claude_continue_after_connection_loss.sh` runs every minute and, once the Mac is back online, types "continue" into each herdr session that stopped that way.
- Only a network-type stop counts. Usage limits, sign-in errors and overloaded servers are left for you.
- Each stop is continued once. A session that stops again three times in an hour is held, and you get one alert.
- An error stop it does not recognize is left alone, with one alert per kind, so a change in Claude Code's format shows up.
- Alerts go through `mattermost_post.py` ([`../comms/`](../comms/)) when installed, else a macOS notification. When the comms manager is installed, its per-session lock keeps two tools from typing into one session at once.
- More retries before the stop: add `export CLAUDE_CODE_MAX_RETRIES=20` to `~/.zshrc` (about 2 minutes).

### Install
Needs herdr with `herdr_session_manage.sh` and `claude_session_transcript.sh` from [`../herdr/`](../herdr/), and `jq`.
```bash
cp bin/claude_continue_after_connection_loss.sh ~/bin/ && chmod 755 ~/bin/claude_continue_after_connection_loss.sh
CONT_DRY=1 ~/bin/claude_continue_after_connection_loss.sh     # shows what it would do; types nothing
mkdir -p ~/Library/Logs/knowledge-worker-stack
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-continue.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-continue</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_continue_after_connection_loss.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_continue_after_connection_loss_launchd.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-continue.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-continue.plist
```
- Its log, which is also its memory: `~/.claude/state/state_claude_continue_after_connection_loss.log`.

### Remove it
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.claude-continue
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-continue.plist ~/bin/claude_continue_after_connection_loss.sh
```

### Known limits
- It checks whether the network is back with one unauthenticated request to the Claude API's address; it costs nothing.
- herdr sessions only.

## 13. /bro and /wait-what
Two commands for when the last reply didn't land. Neither does new work; they only restate.
- `/bro`: the last reply again in plain language: shorter, no invented labels, the point first.
- `/wait-what`: re-pitch it with a little context, in Simplified Technical English, using the terms in the project's `GLOSSARY.md` (and `GLOSSARY-MAP.md`) if it has them; neither ships here, and the skill works without them. `agents/openai.yaml` lets the same skill show up in OpenAI's Codex.
```bash
mkdir -p ~/.claude/skills && cp -R skills/bro skills/wait-what ~/.claude/skills/
```
Remove: `rm -r ~/.claude/skills/bro ~/.claude/skills/wait-what`.

## 14. Rundown reply style
An output style that turns Claude's chat replies into a status board you can read at a glance, even switching in from another tab: a one-line TL;DR first, then the state of each item as a checklist, with risks flagged on their own line. Code, commits and documents are written normally.

### Install
```bash
mkdir -p ~/.claude/output-styles && cp output-styles/rundown.md ~/.claude/output-styles/rundown.md
```
Merge into `~/.claude/settings.json`, or pick it with `/output-style`:
```json
{ "outputStyle": "Rundown" }
```
It applies from the next session.

### Remove it
Delete `"outputStyle": "Rundown"` from `~/.claude/settings.json`, then `rm ~/.claude/output-styles/rundown.md`.

## 15. Memory backup
Claude Code's memory (the `memory/` folder of each project) has no history: an overwritten or deleted memory file is gone. `claude_memory_snapshot.sh` copies every project's memory folder, for every account, into a local git repository every hour and commits only what changed, so any earlier version can be recovered.
- Destination: `~/knowledge-worker-stack-backups/claude-memory` (or `$CLAUDE_MEMORY_BACKUP_DIR`), one folder per config dir and project. Nothing leaves the Mac.
- It also warns when a project's `MEMORY.md` index nears what Claude Code loads (the first 200 lines or 25,000 characters): past that, new sessions silently stop seeing the end of it. At most one alert a day.
- Alerts (that warning, or a failed run) go through `mattermost_post.py` ([`../comms/`](../comms/)) when installed, else a macOS notification. Log of the last run: `~/.claude/state/state_claude_memory_snapshot.log`.

### Install
```bash
cp bin/claude_memory_snapshot.sh ~/bin/ && chmod 755 ~/bin/claude_memory_snapshot.sh
~/bin/claude_memory_snapshot.sh; echo "exit $?"     # 0, and a first snapshot in ~/knowledge-worker-stack-backups/claude-memory
mkdir -p ~/Library/Logs/knowledge-worker-stack
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-memory-snapshot.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-memory-snapshot</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_memory_snapshot.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_memory_snapshot_launchd.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-memory-snapshot.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-memory-snapshot.plist
```

### Use
- See the history: `git -C ~/knowledge-worker-stack-backups/claude-memory log --stat`.
- Get a file back as it was: `git -C ~/knowledge-worker-stack-backups/claude-memory show <commit>:<path>`.

### Remove it
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.claude-memory-snapshot
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-memory-snapshot.plist ~/bin/claude_memory_snapshot.sh
```
The backups stay in `~/knowledge-worker-stack-backups/claude-memory` until you delete them.

## 16. Safety hooks
Two hooks that stop Claude before a Bash command, each with a reason it can act on.
- **`git-commit-pathspec-guard.py`**: when several sessions work in one repository, a plain `git commit` takes everything staged, including another session's half-done work. It refuses a commit that names no files (`git commit -m "…" -- file1 file2` is the shape it wants), an `--amend` while other files are staged, and a commit of a file that is only partly staged. Dry runs and commands that merely mention `git commit` pass.
- **`settings-silent-deny-explainer.py`**: a deny rule such as `Bash(rm -rf:*)` in your settings blocks a command without saying why, and Claude can spend a long time guessing. This hook reads your own deny rules (user settings, the session's config dir, and the project's `.claude/settings.json` and `.claude/settings.local.json`) and refuses first, naming the rule and a better way. It matches only where Claude Code does, at the start of the command or of a subcommand after `&&`, `||`, `;` or `|`, so `echo curl` or a commit message that mentions a blocked command passes.

### Install
```bash
mkdir -p ~/.claude/hooks && cp hooks/git-commit-pathspec-guard.py hooks/settings-silent-deny-explainer.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `PreToolUse` entries):
```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "python3 ~/.claude/hooks/git-commit-pathspec-guard.py", "timeout": 10 },
  { "type": "command", "command": "python3 ~/.claude/hooks/settings-silent-deny-explainer.py", "timeout": 5 }
] } ] } }
```
Remove: delete those entries, then `rm ~/.claude/hooks/git-commit-pathspec-guard.py ~/.claude/hooks/settings-silent-deny-explainer.py`.

### Known limits
- The explainer reads only `Bash(<prefix>:*)` and `Bash(<prefix> *)` rules, matched as whole words. Where it does not match, the rule still blocks, just without a reason.
- The commit guard judges commands Claude runs, not commits you make yourself.

## 17. Folder notes (CONTEXT.md)
Put a `CONTEXT.md` in any folder to tell Claude what it would otherwise get wrong there. The first time a session reads a file in that folder or below, a hook hands Claude every `CONTEXT.md` from that folder up to your home folder, broadest first; where two disagree, the nearer one wins. Before the first write into a folder it stops the write once with the notes as the reason, and Claude repeats the write having read them.
- Each file is delivered once per session (and once per subagent, which has its own memory). Later reads and writes in the same place cost nothing.
- Keep each file narrow: the parent's notes already arrive, so never repeat them. An optional `~/CONTEXT.md` reaches every folder under your home.
- **The notes arrive as instructions.** A `CONTEXT.md` that came with something you downloaded (a repository, a shared folder, an unzipped archive) is someone else's instructions to Claude, and the hook cannot tell it from yours. Check for one before Claude works in such a folder, and delete it if you did not write it.
- Only folders under your home are searched, and a `CONTEXT.md` you do not own is skipped. To use notes outside your home (an external drive), list each top folder, one absolute path per line, in `~/.config/knowledge-worker-stack/context-md-trusted-roots.txt`; the walk then stops at that folder.
- A line earns its place only if all three hold: it is **specific** to this folder, not to software in general; a reader would get something **wrong** without it, not merely have to look it up; and it **changes what the reader does**. No file lists, no history of who decided what.
- Example, `~/Sites/blog/CONTEXT.md`:
```markdown
# Blog
- "Publish" means `make deploy`; `npm run build` only builds and changes nothing live.
- Posts are named `YYYY-MM-DD-<slug>.md`; drafts stay in `drafts/` until published.
- Never edit `public/`; every build regenerates it.
```

### Install
```bash
mkdir -p ~/.claude/hooks && cp hooks/load-context-md-chain.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `PostToolUse` and `PreToolUse` entries):
```json
{ "hooks": {
  "PostToolUse": [ { "matcher": "Read", "hooks": [
    { "type": "command", "command": "python3 ~/.claude/hooks/load-context-md-chain.py", "timeout": 5 } ] } ],
  "PreToolUse": [ { "matcher": "Write|Edit|MultiEdit", "hooks": [
    { "type": "command", "command": "python3 ~/.claude/hooks/load-context-md-chain.py", "timeout": 5 } ] } ]
} }
```
- Costs nothing until a folder has a `CONTEXT.md`; then the file's length, once per session.
- Remembers what each session has had in `~/.claude/state/state_claude_cache_which_context_md_files_loaded.json`; safe to delete.

### Remove it
Delete both entries, then `rm ~/.claude/hooks/load-context-md-chain.py ~/.claude/state/state_claude_cache_which_context_md_files_loaded.json*`. Your `CONTEXT.md` files stay; without the hook Claude reads them only when it happens to open them.

### Known limits
- Only file tools trigger it. A folder reached only through shell commands (`ls`, `cat`) does not.
- A `CONTEXT.md` over 200,000 characters is refused and named instead of delivered: at that size it is a log or a generated file, not notes.

## 18. Tool rules on first use
Rules for a tool that most sessions never use (how to treat your mail, a client system, a deploy command) cost tokens in every session when they sit in CLAUDE.md. This hook keeps them in Markdown files under `~/.claude/command-context/` and hands them to Claude the first time a session runs a matching shell command.
- A file declares which commands its rules govern, with an invisible HTML comment. `match=` is a regular expression tried against the whole command, and must come last:
```text
<!-- claude-command-context: mode=guard; match=(^|[;&|(]\s*)mytool(\s|$) -->
- Never run `mytool delete` without showing me the list first.
<!-- end claude-command-context -->
```
- `mode=guard` stops the first matching command once, with the rules as the reason; Claude runs it again having read them. Use it for anything that sends, deletes or spends. `mode=notify` lets the command run and adds the rules beside its result, one step late; use it for plain reference.
- Each block is delivered once per session and once per subagent. Edits take effect on the next command.
- A worked example ships with [`../google/`](../google/): its mail and Drive rules load the first time a session runs `g` or `gws`.
- More folders to scan, such as a notes folder of your own: set `CLAUDE_COMMAND_CONTEXT_DIRS` (colon-separated) in the `env` section of `~/.claude/settings.json`. A block inside a ``` code fence is ignored, so notes can show the syntax without arming it.

### Install
```bash
mkdir -p ~/.claude/hooks ~/.claude/command-context && cp hooks/load-progressive-discovery-command-context.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `PreToolUse` entries):
```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "python3 ~/.claude/hooks/load-progressive-discovery-command-context.py", "timeout": 10 }
] } ] } }
```
- Costs nothing per message; a block's length once per session when it fires.
- State: `~/.claude/state/state_claude_cache_which_progressive_discovery_tool_rules_loaded.json` and `state_claude_cache_command_context_markdown_index.json`, both safe to delete.

### Remove it
Delete the entry, then `rm ~/.claude/hooks/load-progressive-discovery-command-context.py ~/.claude/state/state_claude_cache_which_progressive_discovery_tool_rules_loaded.json* ~/.claude/state/state_claude_cache_command_context_markdown_index.json`. Move any rules in `~/.claude/command-context/` you still want into CLAUDE.md.

### Known limits
- Only Bash commands trigger it, matched on their text. A tool reached some other way (an MCP server, a file edit) does not.
- A block over 12,000 characters is not delivered; Claude is told to read the file and to tell you it needs splitting.
- A block whose `match=` is missing or does not compile is reported to Claude once per session, so it can tell you.

## 19. Keep old sessions, no idle compaction
Two Claude Code settings:
- `cleanupPeriodDays: 36500`: Claude Code deletes session transcripts older than 30 days by default, after which `/resume` can't reach them. 36500 days keeps them for good. They are plain text in `~/.claude/projects/` and grow over time; pick a smaller number if disk space matters. Anything ever pasted or shown in a session, a password included, is kept as long as the transcripts are.
- `idleCompaction: false`: stops Claude Code from compacting (summarizing) a long conversation while the session sits idle, so a session you come back to still holds the full conversation, not a summary of it.

### Install
Merge into `~/.claude/settings.json`:
```json
{ "cleanupPeriodDays": 36500, "idleCompaction": false }
```
`install.sh` leaves either one alone if you already set it.

### Remove it
Delete both keys from `~/.claude/settings.json`.

## 20. Verified clipboard copy
"It's on your clipboard" is otherwise an unchecked claim. `agent_copy_to_clipboard` copies the text, reads the clipboard back and compares the two byte for byte; only on a match does it print a line of six clipboard glyphs (📋📋📋📋📋📋), the text, and a confirmation. A mismatch exits non-zero and says it did NOT copy.
- It warns, without failing, when the text holds non-ASCII characters (curly quotes, dashes, emoji), which some apps paste as garbage, and names the lines.
- `--secret` (`-s`) copies and checks the same way but never prints the text, for a password or token. It takes the text only piped in (`agent_get_credential 'Entry' | agent_copy_to_clipboard -s`), never as an argument, which would land in the transcript; it drops one trailing newline; and it marks the item concealed and local to this Mac, so clipboard-history apps that honor the marker skip it and Universal Clipboard does not send it to your other devices. If that marking fails it copies anyway and says so.
- Text from the arguments is copied with no trailing newline; text piped in is copied exactly, trailing newline included.
- The starter CLAUDE.md tells Claude to use it for any text you must paste.

### Install
```bash
cp bin/agent_copy_to_clipboard ~/bin/ && chmod 755 ~/bin/agent_copy_to_clipboard
~/bin/agent_copy_to_clipboard "hello"    # replaces your clipboard; prints the marker, hello, "copied to clipboard (5 chars, ascii-clean)"
```
With your own CLAUDE.md, add: ``- Text I must paste: put it on the clipboard with `agent_copy_to_clipboard` and show it in chat too.``

### Remove it
`rm ~/bin/agent_copy_to_clipboard`, and the CLAUDE.md line if you added it.

## Starter CLAUDE.md
[`CLAUDE.starter.md`](CLAUDE.starter.md) is a starting set of working rules for Claude Code: show both versions when asking you to approve text, do reversible work without asking and ask before anything that leaves the machine or cannot be undone, do the work rather than hand it to you, report every file it touches, keep credentials out of sight, and use this repo's tools (vault, secret dialog, `browse`, `tell`, `/successor`, `/loose-ends`). It already includes the credential rules listed in the [top README](../README.md#installing-by-hand).

### Install
Copy it only if you have no `~/.claude/CLAUDE.md` yet:
```bash
mkdir -p ~/.claude
[ -e ~/.claude/CLAUDE.md ] && echo "you already have one: merge by hand" || cp CLAUDE.starter.md ~/.claude/CLAUDE.md
```
- Already have one: copy the sections you want into it by hand, or ask Claude to merge them and show you the result before saving.
- It is yours to edit; new sessions read the current version.

### Remove it
Delete the rules you don't want, or `trash ~/.claude/CLAUDE.md` if it holds nothing else.

Tested on macOS 26: the status line with sample session data (one account, two accounts, empty data); the title hook and both `/retitle` blocks in a throwaway home folder, with a stand-in `claude` so no real request was made; the model list sync against a stand-in Claude Code program, including the hand-off to a stand-in `mattermost_post.py` and the notification fallback; the `/successor` first-prompt helper on a sample transcript; the account hook, both skip hooks and the restart script (skip, account switch, unknown account, missing token, never idle, the 15-minute loop guard, skip mode only on claude's own flag spelling) against a stand-in herdr; the `/successor` state step (skip mode comes back as auto, read from the transcript) and the predecessor retirement refusing a pane that runs another session; the prime-directive script (set, show, check, audit, close across a numbered series, the `never` refusal), its hook, and its carry-over in a stand-in hand-over; the lineage helper; the status line fix on two accounts; the clipboard copy against a stand-in clipboard (a match, a mismatch, `--secret`, non-ASCII, piped text with its newline); the connection-loss job against a stand-in herdr and network; the memory backup (first run, no change, change, index warning); both safety hooks; the folder-notes hook and the tool-rules hook with sample hook input (once per session, once per subagent, the write stopped once, a fenced example ignored, a broken pattern reported, nothing loaded outside your home, a note you do not own skipped, a trusted root). Not tested: the token sign-in (it mints and deletes real credentials; its `claude` function ran only against a stand-in), a live `/successor` hand-over, a live restart and the auto-successor job (they need a running herdr), the task-list hook, `/loose-ends`, `/bro`, `/wait-what` and the Rundown style (instructions only), and the LaunchAgents themselves.
