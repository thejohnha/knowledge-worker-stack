# herdr

[herdr](https://herdr.dev) is a terminal workspace manager for AI coding agents: workspaces, tabs and panes, like tmux, plus it knows which pane holds which agent, whether that agent is working or idle, and which Claude Code session it is. This folder is a setup for running Claude Code inside it on a Mac, and the tools that make sessions survive restarts:

- **The server at login**, so herdr is already running when you open a terminal.
- **`h`**: opens herdr and cleans up the terminal after you detach.
- **`cr`**: resumes one session safely. **`hr`**: resumes the session that belongs to the tab you are in.
- **Tab recording**: a Claude Code hook plus a once-a-minute recorder, so a tab still knows its session after the session exits and after herdr restarts.
- **The herdr session manager** (`herdr_session_manage.sh`): one command for an agent to start, resume, quit, move or message a Claude Code session in another pane, each step verified.
- **Restore and restart**: put back every session that was running, or restart herdr and do that in one step.
- **Hourly backups** of the layout, the session mapping and your herdr config, kept locally.
- **`claude_exit_session.sh`**: a session exits itself and closes its tab.
- **Restart after an update** (optional): `/restart` typed into idle sessions once Claude Code has updated itself.

The grid (`grid/`) builds on this folder; set this one up first.

## What each file does and where it goes
| File | Installed to | Purpose |
|:---|:---|:---|
| `h`, `cr`, `hr` | `~/bin` | the three shortcuts above; scripts, so they work the same from zsh or bash |
| `claude_session_transcript.sh` | `~/bin` | finds a session's transcript in any project folder of any account; `cr`, `hr` and the herdr session manager share it |
| `herdr_session_manage.sh` | `~/bin` | the herdr session manager |
| `record-herdr-tab.sh` | `~/.claude/hooks` | SessionStart hook: writes down which tab each session started in |
| `skip-if-nested-claude.sh` | `~/.claude/hooks` | runs a SessionStart hook unless a claude started this claude, so a nested `claude -p` cannot claim the pane (step 5) |
| `prompt-suggestion-misread-guard.py` | `~/.claude/hooks` | Bash hook: stops a session misreading or typing over another session's input box (step 8) |
| `herdr_session_record_live.sh` | `~/bin` | every minute: which sessions are running, and fixes the tab record when a tab moves |
| `herdr_session_resolve_tab.py` | `~/bin` | tab id -> session; reads files only, so it works while herdr's command line is refusing |
| `herdr_session_restore.py` | `~/bin` | resumes the recorded set, each back into its own tab |
| `herdr_session_restart_and_restore.py` | `~/bin` | restarts herdr and restores, from outside the panes it kills |
| `herdr_session_snapshot.sh` | `~/bin` | the hourly local backup |
| `claude_exit_session.sh` | `~/bin` | exit this session and close its tab |
| `claude_restart_sessions_after_update.py` | `~/bin` | optional, step 9: restart idle sessions onto a new Claude Code build |

State the tools keep, all in `~/.claude/state/`: `state_claude_session_herdr_tabs.json` (tab -> session), `state_claude_herdr_live_sessions.json` (the running set), `state_claude_session_last_herdr_pane.json` (session -> pane). Backups: `~/knowledge-worker-stack-backups/herdr`.

## Prerequisites
- macOS with [Homebrew](https://brew.sh) and Claude Code installed and signed in.
- `python3` and `jq`: macOS 15 and later ship `jq`; `python3` comes with the Xcode command line tools (`xcode-select --install`).
- `claude_exit_session.sh` also needs the successor tools from [`../claude-code/`](../claude-code/).

## Install

### 1. Know where you are
```bash
cd /path/to/knowledge-worker-stack/herdr    # this repo's herdr/ folder; every step below runs from here
```

### 2. herdr and its Claude Code integration
```bash
brew install herdr
herdr integration install claude    # herdr's own SessionStart hook: reports each pane's session id to herdr
herdr integration status
```
- The integration is what lets herdr know which session runs in which pane. Without it nothing below can find a session.

### 3. The scripts
```bash
mkdir -p ~/bin ~/.claude/hooks
install -m 755 h cr hr claude_session_transcript.sh herdr_session_manage.sh herdr_session_record_live.sh \
  herdr_session_resolve_tab.py herdr_session_restore.py herdr_session_restart_and_restore.py \
  herdr_session_snapshot.sh claude_exit_session.sh ~/bin/
install -m 755 record-herdr-tab.sh skip-if-nested-claude.sh ~/.claude/hooks/
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc    # then open a new terminal
```
- Quit and reopen the terminal and Claude Code once install is done, so both see `~/bin` on PATH. Until then, call a script as `~/bin/<name>`.
- If `type h` in a new terminal reports an alias or function (some zsh setups alias `h` to `history`), remove that alias or rename the script.

### 4. Start the server at login
Homebrew's herdr has no background service, so a LaunchAgent starts it. Unquoted `EOF` on purpose: launchd cannot expand `$HOME`, so the shell writes your real paths into the file now.
```bash
mkdir -p ~/Library/Logs/knowledge-worker-stack    # launchd does not create a log's folder
cat > ~/Library/LaunchAgents/local.herdr.server.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.herdr.server</string>
  <key>ProgramArguments</key>
  <array><string>$(brew --prefix)/bin/herdr</string><string>server</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:$HOME/bin:$(brew --prefix)/bin:$(brew --prefix)/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_server.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.herdr.server.plist
launchctl print gui/$(id -u)/local.herdr.server | grep -E 'state|last exit'
```
- PATH is in the plist because launchd gives its jobs a bare PATH and never runs your shell profile. Every pane herdr opens inherits the server's PATH, and herdr's settings panel looks for agent CLIs there (`claude` lives in `~/.local/bin`). Without it, panes still work but the panel finds no agents.
- No KeepAlive, on purpose: `herdr server stop` must stay stopped, or launchd would race every planned restart.
- Safe beside a running server: a second `herdr server` prints `herdr server is already running` and exits, leaving the first untouched. If your terminal's `h` starts a server first at login, the job's run is a harmless refusal.
- Start it by hand: `launchctl kickstart gui/$(id -u)/local.herdr.server`.

### 5. Record which tab each session lives in
Merge this into `~/.claude/settings.json` (keep everything already there, including the entry `herdr integration install` added):
```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "bash ~/.claude/hooks/skip-if-nested-claude.sh ~/.claude/hooks/record-herdr-tab.sh" } ] }
    ]
  }
}
```
In the same file, put `bash ~/.claude/hooks/skip-if-nested-claude.sh ` in front of the command of herdr's own entry (the one running `herdr-agent-state.sh`).
- Why: a `claude -p` that a session runs from its Bash tool inherits the pane's `HERDR_PANE_ID` and `HERDR_TAB_ID`, and its SessionStart hooks would report it as the pane's session, so herdr, the tab record and the grid would name a throwaway run. The wrapper skips the hook when two or more `claude` processes are above it.
- Every `herdr integration install claude` (a herdr upgrade too) adds its entry again, unwrapped, beside the wrapped one: delete the new one. `./install.sh` does both edits, and redoes them on each run.
Then the once-a-minute recorder and the hourly backup, as two LaunchAgents (launchd rather than cron so the backup's failure notification can reach your screen):
```bash
for job in record-live:herdr_session_record_live.sh:60 snapshot:herdr_session_snapshot.sh:3600; do
  IFS=: read -r name script every <<<"$job"
  cat > ~/Library/LaunchAgents/local.herdr.$name.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.herdr.$name</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/$script</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/bin:$(brew --prefix)/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>$every</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_$name.log</string>
</dict>
</plist>
EOF
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.herdr.$name.plist
done
```
```bash
~/bin/herdr_session_snapshot.sh; echo "exit $?"    # first backup now: 0, and files in ~/knowledge-worker-stack-backups/herdr
```
- The recorder is silent and writes nothing while herdr is down; that is what keeps the last running set intact for a restore. Its log only ever holds a real bug.
- Backups land in `~/knowledge-worker-stack-backups/herdr`. To move them, set `HERDR_BACKUP_DIR` in the snapshot plist's EnvironmentVariables AND export the same value in `~/.zshrc`, or `hr --list` and `hr --from` keep looking in the default folder. A failed or repaired backup alerts you through `mattermost_post.py` from [`../comms/`](../comms/) when it is installed (a Mattermost post if that is set up), else a macOS notification. Run log: `~/Library/Logs/knowledge-worker-stack/herdr_session_snapshot.log`.
- They are local only: they protect against herdr losing its layout or a store being damaged, not against losing the Mac. Point `HERDR_BACKUP_DIR` at a synced or backed-up folder if you want that too.

### 6. Let your agent use it (optional)
Merge into `~/.claude/settings.json` (add to any `permissions.allow` list already there), so an agent can stop a session without a prompt each time:
```json
{
  "permissions": {
    "allow": ["Bash(claude_exit_session.sh:*)"]
  }
}
```
- An agent must call it by name as the first word (`claude_exit_session.sh ...`), never through `bash ...`, or the rule does not match.
- `herdr_session_manage.sh` gets no such rule on purpose: it can start, message and quit any session, so each call goes through Claude Code's normal permission check (auto mode's safety check, or a prompt for you). It never starts or resumes a session in skip mode, has no switch that passes other options through to `claude`, and refuses to `tell` a session the bare word `skip`.
- `herdr --skill` prints herdr's own agent skill, for an agent that should drive panes directly.

### 7. Several Claude Code accounts (optional)
One account needs nothing here. For more, list each config dir in `~/.config/knowledge-worker-stack/accounts.json` (shared with the other knowledge-worker-stack folders):
```json
{ "default": "~/.claude", "project-b": "~/.claude-project-b" }
```
- A session's account is its row in `~/.claude/state/state_claude_session_accounts.json` (session id -> account name), written at session start by the account hook in [`../claude-code/`](../claude-code/); no row means `default`. `cr` resumes each session on its own account.
- If an account's config dir holds a `.oauth_token` file, `cr` and the herdr session manager use it, set on the `claude` command alone and never exported into the pane's shell; otherwise that dir's own sign-in.
- Each extra config dir needs the step 5 hook and herdr's integration hook in its own `settings.json` (or a symlink to the main one).

### 8. Guard other sessions' input boxes
Two mistakes an agent makes when it handles another session's pane, stopped before the command runs:
- **Reading:** an empty input box shows Claude Code's gray prompt suggestion, and `herdr pane read` in plain text drops the gray, so the suggestion reads as text you typed. A plain-text `herdr pane read` or `herdr agent read` is refused with the right tool for the job (`herdr_session_manage.sh draft` to see a draft, `--format ansi` for any other read).
- **Sending:** `herdr agent prompt` into a box holding your unsent text submits your text with it. The hook checks the box first (with `herdr_session_manage.sh draft`) and refuses only when there is a draft or the target is waiting on a question, pointing to `tell`.
- A command ending in `# not-a-draft-check` runs as-is. When herdr does not answer, the command runs, with a warning.

This lives here, not in `../claude-code/`, because it only guards herdr commands and calls the herdr session manager.
```bash
cp prompt-suggestion-misread-guard.py ~/.claude/hooks/
```
Merge into `~/.claude/settings.json` (keep existing `PreToolUse` entries):
```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "python3 ~/.claude/hooks/prompt-suggestion-misread-guard.py", "timeout": 5 }
] } ] } }
```

### 9. Restart sessions after a Claude Code update (optional)
When Claude Code updates itself, every running session stays on the old build and shows `✔ Update installed · /restart to apply` above its input box until you type `/restart`. This job types it for you, every 5 minutes, into each session that is safely idle. `/restart` restarts the session in place: same pane, session id, account and permission mode, no model turn, and session-only scheduled jobs survive it. Claude Code refuses it while background work runs, so a shell or Monitor is never killed. The screen is blank for about 15 seconds mid-restart.

A session is restarted only when all of these hold:
- herdr says idle or done (never working, never blocked on a question or permission prompt), and its pane runs a different version from the one `~/.local/bin/claude` points at.
- The notice is the line directly above the input box (a conversation that quotes it does not count), and the footer shows no background shells or monitors.
- Its transcript has not been written for 3 minutes.
- You are not at it: it is not the focused pane while the Mac has had keyboard or mouse input in the last 10 minutes.
- Claude Code has not refused to restart it in the last 30 minutes.
- Right before typing, under the herdr session manager's per-pane send lock (and the comms manager's per-session wake lock when [`../comms/`](../comms/) is installed): still idle, and the input box empty.

At most 3 per sweep. Each is checked afterwards (same session back on the new version, notice gone) and logged to `~/.claude/state/state_claude_restart_sessions_after_update.log` as `restarted`, `refused` or `unconfirmed`. A skip-mode session comes back as `--permission-mode bypassPermissions`, which the skip-mode hook in [`../claude-code/`](../claude-code/) (piece 9) counts as skip mode.

Not in the default install. From the repo folder: `./install.sh --only update-restart` (herdr installed first). By hand:
```bash
install -m 755 claude_restart_sessions_after_update.py ~/bin/
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-restart-sessions-after-update.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.knowledge-worker-stack.claude-restart-sessions-after-update</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/claude_restart_sessions_after_update.py</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/bin:$HOME/.local/bin:$(brew --prefix)/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/claude_restart_sessions_after_update_launchd.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-restart-sessions-after-update.plist
claude_restart_sessions_after_update.py --dry-run              # what it would restart now; why a session showing the notice is skipped
claude_restart_sessions_after_update.py --only <uuid prefix>   # one session only
```

#### Remove it
`./install.sh --uninstall --only update-restart`, or by hand:
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.claude-restart-sessions-after-update
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.claude-restart-sessions-after-update.plist ~/bin/claude_restart_sessions_after_update.py
rm -f ~/.claude/state/state_claude_restart_sessions_after_update.*
```

#### Known limits
- Needs Claude Code's native install, where `~/.local/bin/claude` links to a versioned build; otherwise it logs an error and restarts nothing.
- It reads Claude Code's screen (the notice, the `❯` input line, the `⏵` mode line). If Claude Code changes that layout, the notice stops matching and nothing is restarted until this script is updated.
- If the Mac's idle time cannot be read, a focused pane counts as unattended.
- A restart slower than 90 seconds is logged `unconfirmed` and not checked again.

Tested on macOS 26 in a throwaway home folder with stand-ins for herdr, the herdr session manager, `ioreg` and the transcript finder: each gate's refusal paired with a pass, the typed `/restart` and its check, a refusal and its 30-minute wait, with and without the comms manager's wake lock, and `--dry-run` writing nothing; the installer part (left out by default, installed with `--only`, a second run with no changes, dry run, uninstall). Not tested: a real `/restart` in a real Claude Code session, and the LaunchAgent firing on schedule.

## Use

### Open, detach, keys
```bash
h            # attach (starts the server if it is not running)
```
- Detach with `ctrl+b q`; herdr and every session keep running. `h` then switches off the mouse and paste modes the detach leaves on, which otherwise print escape codes on every keystroke.
- herdr's prefix is `ctrl+b`. `prefix+n` / `prefix+p` move between tabs.
- Your settings live in `~/.config/herdr/config.toml`; `herdr server reload-config` applies an edit without a restart and reports `partial` plus the offending key on a bad binding. Worth adding:
```toml
onboarding = false

[keys]
previous_tab = ["prefix+p", "alt+shift+left"]     # a binding REPLACES the default key: keep it in the list
next_tab = ["prefix+n", "alt+shift+right"]
previous_workspace = "alt+up"
next_workspace = "alt+down"
previous_agent = "ctrl+alt+up"                    # walk the sidebar's agent list
next_agent = "ctrl+alt+down"
```
- Optional, only when the target is installed: a key for the grid ([`grid/`](grid/)) and one for the chief of staff ([`../comms/`](../comms/)). herdr has no bind-to-one-tab action, so each runs a script that finds its tab. Unquoted `EOF` on purpose: the shell writes your real home path into the file, because whether herdr expands `$HOME` in a key command is untested. Each block is skipped if its script is not installed or its key is already bound, so running it again (or after the grid's or comms' own step) adds nothing:
```bash
[ -x ~/bin/herdr_session_grid.py ] && ! grep -q 'ctrl+alt+g' ~/.config/herdr/config.toml 2>/dev/null && cat >> ~/.config/herdr/config.toml << EOF

[[keys.command]]
key = "ctrl+alt+g"
type = "shell"
command = "PATH=$HOME/bin:$(brew --prefix)/bin:/usr/bin:/bin $HOME/bin/herdr_session_grid.py go"
EOF
[ -x ~/bin/claude_chief_of_staff_go.sh ] && ! grep -q 'ctrl+alt+c' ~/.config/herdr/config.toml 2>/dev/null && cat >> ~/.config/herdr/config.toml << EOF

[[keys.command]]
key = "ctrl+alt+c"
type = "shell"
command = "$HOME/bin/claude_chief_of_staff_go.sh"
EOF
herdr server reload-config
```
- `ctrl+alt+g` lands on the grid's own tab; `ctrl+alt+c` on the chief of staff's, resuming it if stopped.
- The `alt` keys need your terminal to send Option as Escape: iTerm2, Profiles > Keys > Left Option key: Esc+; Terminal.app, Settings > Profiles > Keyboard > Use Option as Meta key.
- Focusing an agent's row clears its unread "done" marker.

### Name tabs, not panes
- Name every tab: `herdr tab rename <TAB_ID> notes`, or `--label` when the herdr session manager starts one. The tab name is the one name that survives a herdr restart, and `hr` uses it as a check.
- One word, two at most. The full session title lives in the session; the tab bar is a map, and long names eat it. Read with the workspace name: workspace `project-a` + tab `notes` says enough.
- When `resume` or `tell` opens a new tab and has no `--label`, it uses the grid cell's label, else the session's title without its date, which can be long. Pass `--label`, or rename the tab afterwards.
- An agent name (`herdr agent rename`) is an address for commands, lowercase with no spaces, gone when the agent exits. The terminal title cannot be set.

### Resume
```bash
cr <full-session-uuid>            # resume one session; anything after the uuid goes to claude, e.g. --model opus
hr                                # in a herdr tab: resume the session this tab last held
hr -n                             # just show which one it would resume
```
- `cr` refuses a session that is already open in another process: two copies write one transcript and one branch of the conversation is silently lost. Prefer `cr` over `claude --resume` for that reason alone.
- `cr` resumes from the folder the session started in, on its own account, keeps its title, and starts in `--permission-mode auto` (set `CR_PERMISSION_MODE` to change that, or empty for Claude Code's default).
- `hr` refuses when the tab was renamed since the session was recorded, because that is also what a renumbered tab would look like: `hr --force` if you renamed it.
- A new tab has no record; `hr` then opens Claude Code's resume picker.

### After a restart: put the sessions back
herdr restores its layout by itself, and by default types `claude --resume <id>` into each pane that held a Claude session, bare: no account, no title, default mode. For anything it missed:
```bash
hr                      # run OUTSIDE herdr: resume every session that was running when herdr stopped
hr --list               # what each recent hourly backup holds
hr --from 20261028_1400 # restore the set that was running at that hour instead
herdr_session_restart_and_restore.py --last --check   # validate, restart nothing
herdr_session_restart_and_restore.py --last           # restart herdr, then restore
```
- Each session goes back into its own tab, through `cr`. Skipped and reported: transcript gone, tab gone, already running, or another session holds the tab. Re-running is safe.
- Quitting a session on purpose removes it from the set within a minute. Only herdr going away preserves the set.
- The restart-and-restore detaches before it stops herdr, because stopping herdr kills the pane it was typed into. Its story lands in `~/Library/Logs/knowledge-worker-stack/herdr_session_restart_and_restore.log`. If `claude_fix_status_line_lost_on_scroll.py` from [`../claude-code/`](../claude-code/) is installed, it runs after the restart to undo Claude Code switching off its pinned status line; absent, it is skipped.

### The herdr session manager
For an agent (or you) acting on a Claude Code session in another pane. Every verb checks its own result.
```bash
herdr_session_manage.sh start notes --workspace w3 [--cwd ~/projects/x] [--account project-b] [--session-name "Title"] [--model opus]
herdr_session_manage.sh resume <uuid> [--pane w3:p2 | --workspace w3 --label notes] [--permission-mode plan]
herdr_session_manage.sh quit w3:p2           # refuses if the input box holds unsent text
herdr_session_manage.sh draft w3:p2          # print unsent text (exit 1), "empty" (0), or cannot tell (2)
herdr_session_manage.sh goto w3:t4           # put your screen on that tab
herdr_session_manage.sh move this project-a  # carry this session's pane, label included, to another workspace
herdr_session_manage.sh tell <uuid> "the folder moved; re-read it before you act"
```
- `tell` gets a message into a session whether or not it is running: it resumes a stopped one through `cr` (`--pane w3:p2` resumes it into that pane), pastes the message as one block and presses Enter, refuses one that is blocked on a question (checked before the paste and again before Enter), lifts any unsent text out of the box and puts it back afterwards, and proves delivery by finding the message in the target's own transcript. Exit 0 delivered, 1 refused or arrived wrong, 2 usage, 3 sent but not yet confirmed: read the target's transcript before you ever resend, because a resend double-prompts it.
- `tell` takes the first 8 or more characters of a session id when they match only one session. A session in the middle of a turn gets the message in Claude Code's own queue and reads it at its next step; `--now` presses Ctrl+Enter instead, so it reads it at once and a command it is running keeps going in the background. `--timeout` is only how long to wait for another send to the same session. Two sends to the same session take turns, so neither one picks up the other's half-typed text.
- `tell` refuses a draft taller than the input box (the box shows `↑ N more` in its border): only part of it is on screen, so it cannot be lifted out whole. Nothing is sent and the box is left alone.
- A message one session sends another should open with `From session <sender's title>:`. The comms owed scan ([`../comms/`](../comms/)) uses that opening to tell a session's message from yours; `tell` itself does not add or check it.
- `resume` and `tell` on an older, stopped member of a numbered series ("Notes 24" when "Notes 25" exists) go to the newest member instead; `--exact` overrides.
- A resumed session goes back where it lived: its old pane if that is at a shell, else that pane's workspace, else a new workspace. Never into the caller's.
- `--model` fails soft in Claude Code (an unknown name is accepted silently), so the herdr session manager reads it back off the status line and warns. That read expects the knowledge-worker-stack status line (`../claude-code/`); with another, it warns that the model went unverified.

### Exit a session from inside it
```bash
claude_exit_session.sh       # no uuid = this session: reply, go idle, it quits and closes its tab
```

### Restore from a backup
Overwrites the live layout, and the restart closes every pane, so treat it as a rebuild:
```bash
herdr server stop
cp ~/knowledge-worker-stack-backups/herdr/herdr-<YYYYMMDD_HHMM>-default-<N>spaces-<M>tabs-session.json ~/.config/herdr/session.json
launchctl kickstart gui/$(id -u)/local.herdr.server
```
- Stop BEFORE copying, or the server writes its own layout over the restored file on the way down.
- The other families restore the same way: `*-global-config.toml` to `~/.config/herdr/config.toml`, the newest `*tabstore.json` to `~/.claude/state/state_claude_session_herdr_tabs.json`, `*grid.json` to the grid's file.
- On a new Mac: install (steps 2-5), stop the server, restore config.toml and session.json, kickstart. The sessions themselves come from `~/.claude/projects`, not from here.

## Cautions
- **A herdr restart kills every pane**, and every agent in one. The tab count comes back the same, which makes it look like a live handoff; it is not. Sessions come back only by being resumed from their transcripts.
- **Never read agent status as "finished".** `done` only means the agent went idle and its tab has not been looked at since; `unknown` covers both an exited agent and one herdr cannot classify. Check the work itself (a file, a commit) and use herdr only to see that the agent went away.
- **`herdr agent prompt` appends to whatever is in the target's input box and submits both**, so it can send someone's half-typed draft. Use `tell`, which checks the box first.
- **Parse herdr's JSON with `jq` or Python, never `grep`.** Each reply is one line, so a grep on a label matches the whole list and hands back the first id on it.
- **Upgrading herdr while the server runs** makes every `herdr` command fail with a protocol mismatch until the server restarts. `hr`, the recorder and the restore keep working, because they read files or speak the socket directly.

## Remove it
```bash
for j in snapshot record-live server; do launchctl bootout gui/$(id -u)/local.herdr.$j; rm ~/Library/LaunchAgents/local.herdr.$j.plist; done
cd ~/bin && rm -f h cr hr claude_session_transcript.sh herdr_session_manage.sh herdr_session_record_live.sh \
  herdr_session_resolve_tab.py herdr_session_restore.py herdr_session_restart_and_restore.py \
  herdr_session_snapshot.sh claude_exit_session.sh
rm ~/.claude/hooks/record-herdr-tab.sh ~/.claude/hooks/skip-if-nested-claude.sh ~/.claude/hooks/prompt-suggestion-misread-guard.py
herdr integration uninstall claude 2>/dev/null
```
- First take `bash ~/.claude/hooks/skip-if-nested-claude.sh ` back off herdr's entry in `~/.claude/settings.json`: `herdr integration uninstall` removes only its entry as it wrote it.
- Remove the step 5 and step 8 hook entries (and any step 6 rules) from `~/.claude/settings.json` by hand.
- Optional: `rm ~/.claude/state/state_claude_session_herdr_tabs.json ~/.claude/state/state_claude_herdr_live_sessions.json ~/.claude/state/state_claude_session_last_herdr_pane.json ~/.claude/state/state_claude_session_last_herdr_pane.json.lock`, `rm -r ~/knowledge-worker-stack-backups/herdr ~/.local/state/herdr-snapshot`, `rm -f ~/Library/Logs/knowledge-worker-stack/herdr_*.log`, `brew uninstall herdr` and `rm -r ~/.config/herdr`.

## Known limits
- A tab that moves to another workspace is a new tab with a new id; the recorder catches up within a minute, so `hr` right after a move misses.
- herdr writes its layout file a little behind; a tab renamed seconds ago can still read under its old name.
- Codex and the other harnesses herdr supports are not covered: `cr`, `hr` and the herdr session manager are Claude Code only.
- Titles shown by `hr` and the restore come from the date-prefix title hook in `../claude-code/`; without it they show the session id or the tab label.
- `herdr_session_restart_and_restore.py` restarts through the `local.herdr.server` LaunchAgent; set `HERDR_LAUNCH_AGENT` if yours is named differently.
- The herdr session manager types into panes, so it needs each pane's shell to be at a prompt; a pane running something else is refused, not interrupted.
- `skip-if-nested-claude.sh` counts processes that `ps` names `claude`; where Claude Code runs under another name (`node`), nothing counts as nested and the hooks run as before.

Tested on macOS 26 with herdr 0.9.5 and the system bash 3.2, against a private herdr server on its own socket and a throwaway home folder, with a stand-in for `claude`: `cr` (accounts, title, folder, the already-open refusal both ways), `hr` (lookup, the rename refusal, `--force`, no record), the tab hook, `skip-if-nested-claude.sh` under 0 to 3 processes named `claude` and with `ps` failing, the installer wrapping herdr's entry (a second run, herdr re-adding it, uninstall), the recorder (including silence with herdr down), the tab-move catch-up, restore (live set, `--list`, `--from`, the skips, an actual resume typed into a bare tab), the herdr session manager's `start` (every flag, passed through to the stand-in), `goto`, `move` (whole tab, to a new workspace, `this`), `draft`, `tell` against the stand-in (one bracketed paste then Enter, Ctrl+Enter with `--now`, a working target queued, a blocked one refused before the paste and again before Enter, a draft taller than the box refused, `--pane`), and its refusals, the backup (first run, no change, a repaired family, a failure, the prune), and the alert routing (shared poster, its fallback, no poster) with stand-ins, `--help` and unknown-flag refusals on every script that takes arguments, the input-box guard with sample hook input and a stand-in herdr and session manager (plain-text reads refused, ANSI reads and the marker passing, a send refused into a draft and into a blocked target, passed into an empty box, and passed with a warning when herdr does not answer), and the key-binding block (written with absolute paths, `reload-config` applied with no diagnostics; the keys were not pressed). Not tested: `start`, `resume`, `quit` and `tell` against a real Claude Code session; the real restart in `herdr_session_restart_and_restore.py`; the three LaunchAgents; `claude_exit_session.sh` past its checks; panes running zsh.
