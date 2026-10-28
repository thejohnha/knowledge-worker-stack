# The grid

One screen that shows every herdr workspace as a row and every tab as a cell, including Claude sessions you closed. Close a session to free memory and its cell stays (parked, `P`); press Enter on it later and it comes back in its own tab. Type `hg` from any terminal to get there.

```
 herdr grid   2 live · 5 parked · 1 ★
herdr sessions: ·        │Website redesign 03
     project-a: ● ○ P P  │
     · reports: P        │20261028 Website redesign 03
     project-b: ★ P      │parked · no tab · 3f9a1c22 · default
      unsorted: P        │4.2 MB · Cx 160k
```

Needs the [herdr setup](../) installed first: herdr itself, `herdr_session_manage.sh` on your PATH, and the tab recording (so a closed tab remembers which session it held). macOS, Python 3 (the one macOS ships is fine).

## Install
Run from this folder (`cd /path/to/knowledge-worker-stack/herdr/grid`).

1. Copy the scripts and load `hg` in every new terminal:
```bash
mkdir -p ~/bin
cp herdr_session_grid.py herdr_session_bookmarks.py claude_session_lineage_delete_or_archive.py hg.sh ~/bin/
chmod 755 ~/bin/herdr_session_grid.py ~/bin/herdr_session_bookmarks.py ~/bin/claude_session_lineage_delete_or_archive.py; chmod 644 ~/bin/hg.sh
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
grep -q 'bin/hg.sh' ~/.zshrc 2>/dev/null || echo 'source "$HOME/bin/hg.sh"' >> ~/.zshrc
```
2. A herdr key, ctrl+alt+g, that jumps back to the grid from any tab. The shell writes the real paths into herdr's config; the block does nothing if the key is already there (for example from [herdr's README](../README.md#open-detach-keys), which adds the same lines):
```bash
grep -q 'ctrl+alt+g' ~/.config/herdr/config.toml 2>/dev/null || cat >> ~/.config/herdr/config.toml << EOF

[[keys.command]]
key = "ctrl+alt+g"
type = "shell"
command = "PATH=$HOME/bin:$(brew --prefix)/bin:/usr/bin:/bin $HOME/bin/herdr_session_grid.py go"
EOF
herdr server reload-config
```
3. Start the grid on its own after a reboot or herdr restart: a LaunchAgent runs `ensure` every minute. launchd starts jobs with a bare PATH, so the plist names the folders holding `herdr` and the scripts. Unquoted `EOF` on purpose: the shell writes your real paths into the file now.
```bash
mkdir -p ~/Library/Logs/knowledge-worker-stack     # launchd does not create a log's folder
cat > ~/Library/LaunchAgents/local.herdr.grid-ensure.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.herdr.grid-ensure</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/herdr_session_grid.py</string><string>ensure</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/bin:$(brew --prefix)/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_grid-ensure.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.herdr.grid-ensure.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.herdr.grid-ensure.plist
```
It acts only in the first 10 minutes after the herdr server starts, so a grid you quit on purpose stays quit. It prints nothing and logs a launch to `~/.claude/state/state_claude_session_grid_autostart.log`.

4. Open a new terminal and type `hg`.

## Use
- `hg` goes to the grid: it makes a `herdr sessions` workspace first in the sidebar if there is none, starts the grid there if it is not running, and switches to it. From a plain terminal with herdr running but not shown, it also opens herdr there.
- `hg run` draws the grid in the current pane instead.
- `herdr_session_grid.py run --demo` draws your real grid with every name, title and id replaced by a placeholder and writes nothing, so a screenshot is safe to share. herdr must be running.

### Cells
| Glyph | Meaning |
|:---|:---|
| `●` yellow | working |
| `●` green | done, not looked at yet (waiting for you) |
| `○` green | idle (waiting for you) |
| `●` red | blocked on a question |
| `◌` blue | tab open, session not running; Enter resumes it in that tab |
| `P` blue | parked: no tab; Enter brings it back |
| `◷` blue | parked, and the comms manager will reopen it when the message it waits for arrives (only with [comms](../../comms/) installed) |
| `◐` | resuming, still starting up |
| `·` | a tab that never held a Claude session |
| `★` / `☆` | bookmarked (keeps the status color; `☆` where the dot would be hollow) |
| `A` | archived (on the archived side, `A`) |

The panel on the right shows the cursor's cell: tab label, full title, status, session id and account, transcript size, context size (green under 150k, yellow to 200k, red past), last activity, and the session's prime directive when it has one (else the title is the description).

### Keys
- Arrows move. Enter on a live cell goes to its tab. Enter on a parked or stopped cell brings the session back in the background and stays in the grid, so you can wake several and then pick one; Enter again goes there.
- `n` new session in this row's workspace, in the cursor's slot: asks for a tab label, then optional words sent as its first prompt. Uses the account of the cell under the cursor.
- `p` park: quit the session and close its tab; the cell stays as `P`. Asks first.
- `x` forget a parked cell. The transcript is untouched. Asks first.
- `d` delete a parked cell: the transcripts of the whole lineage go to the Trash. Asks first.
- `a` archive a parked cell: the whole lineage moves into a folder of the archive. Asks for the folder (prefilled with a guess; Tab cycles the existing ones), then asks to confirm.
- `A` the archived side: one row per archive folder. Enter asks which workspace, moves the session back where Claude Code expects it, resumes it and returns to the live side.
- `t` rename the session's title across its whole lineage (archived members too). Lists the members, prefills the description; each keeps its own date, marker and number.
- `r` rename the tab label (the short name herdr shows).
- `m` grab a cell, arrows carry it (up/down moves it to another workspace), `m` or Enter drops it, Esc cancels.
- `b` bookmark, Tab next bookmark.
- `v` views: all cells / running plus bookmarked / running only.
- `o` order: yours / newest first (display only).
- `/` search label, title and prime directive as you type; Enter keeps it, Esc clears.
- `=` push the grid's tab order onto herdr. `R` refresh (it also refreshes every 3 s). `?` every key. `q` quit (Esc never quits).

### Words
- A **lineage** is a session and its successors: titles that match once the date, the marker (`⭐ ☑️ 1️⃣`…) and the trailing number are removed. `20261027 Website redesign 02` and `20261028 Website redesign 03` are one lineage, and one cell, which opens the highest number.
- **Subgroups**: a workspace labeled `project-a-reports` shows as `· reports` right under `project-a`.

## Where it finds sessions
Claude Code keeps each transcript in `~/.claude/projects/<folder>/`, where the folder is the directory you started `claude` in with every character other than a letter or digit turned into `-` (`/Users/you/work` → `-Users-you-work`). The grid reads every such folder, so it does not matter where you start Claude. Bringing a session back from the archive puts it in the folder named for the directory it was started in, which is where `claude --resume` looks.

Every session with a title (set with `/rename`, or automatically by [claude-code](../../claude-code/)'s dated titles) gets a cell, even one never opened in herdr. Untitled sessions are skipped. A new cell lands in the first row that fits: the one your `categories` setting names, else the workspace named like the title's first word or two (`project-a notes` goes to `project-a`), else a row called `unsorted`. A row whose workspace does not exist yet is created the first time you open one of its cells.

## Settings (optional)
`~/.config/knowledge-worker-stack/grid.json`, every key optional:
```json
{
  "archive_dir": "~/.claude/projects/-archive",
  "categories": [["\\b(recipe|garden)\\b", "project-a"], ["\\btravel\\b", "travel"]]
}
```
- `archive_dir`: where `a` files sessions, one subfolder per topic. Default `~/.claude/projects/-archive`.
- `categories`: title pattern (a regular expression, case-insensitive) → name. First match wins. A new cell lands in the row of that name, and `a` suggests the archive folder of that name when it exists. Empty by default.
- More than one Claude account: list them in `~/.config/knowledge-worker-stack/accounts.json` (see [claude-code](../../claude-code/)). The grid then reads every account's sessions and checks every account before a delete, archive or rename.

## Safety
- `d`, `a` and `t` refuse when any member of the lineage is running anywhere, in herdr or a plain terminal, and name the running ones. Nothing is half-done: a rename that skipped a running member would split the lineage. They also refuse when a Claude process exists whose session id cannot be read.
- `d` and `a` work on parked cells only; park a live one first with `p`.
- Delete never erases: it uses the macOS `trash` command (built into newer macOS; else one on your PATH, such as `brew install trash`; else Finder). Undo with Finder's Put Back.

## Files
- `~/.claude/state/state_claude_session_grid.json`: row order, cells and their order, parked cells, labels, bookmarks, forgotten lineages. Delete it and the next run starts fresh from herdr, with nothing parked except sessions found on disk.
- `~/.claude/state/state_claude_session_grid_cursor.json`: where the cursor was, so a restart lands on the same cell.
- `~/.claude/state/state_claude_session_grid_autostart.log`: what the `ensure` job did.
- `~/.claude/state/state_claude_session_grid_undelivered_prompt.txt`: your first-prompt words from `n`, kept when the start failed.
- Reads, never writes: herdr's live state, the tab record `state_claude_session_herdr_tabs.json`, the account record `state_claude_session_accounts.json` (no row = `default`), and the comms manager's `state_claude_frontdesk/` (absent = no `◷`).
- `t` also updates `state_claude_session_titles.json` and `state_claude_session_title_lineage.json` when they exist (from [claude-code](../../claude-code/)'s dated titles and `/retitle`), so a resumed session keeps the new name.
- `herdr_session_bookmarks.py toggle <session-id>` / `list` sets or lists bookmarks from the command line.
- `claude_session_lineage_delete_or_archive.py delete|archive <session-id>` is `d` and `a` from the command line, for any session, parked or not: it lists the lineage, asks (the archive folder too, Tab completes), and drops every grid cell of the lineage in every workspace. Same refusals as `d` and `a`; `--check` lists the members and runs the refusals without changing anything. It needs a terminal to ask in, and `herdr_session_grid.py` beside it.

## Remove it
Delete the `ctrl+alt+g` block from `~/.config/herdr/config.toml` and the `source "$HOME/bin/hg.sh"` line from `~/.zshrc`, then:
```bash
launchctl bootout gui/$(id -u)/local.herdr.grid-ensure
rm ~/Library/LaunchAgents/local.herdr.grid-ensure.plist
rm ~/bin/herdr_session_grid.py ~/bin/herdr_session_bookmarks.py ~/bin/claude_session_lineage_delete_or_archive.py ~/bin/hg.sh
rm ~/.claude/state/state_claude_session_grid*
```
Archived sessions stay in the archive folder.

## Known limits
- One herdr server: the grid talks to the default socket (or `HERDR_SOCKET_PATH`).
- `hg` shadows Mercurial's `hg` command. If you use Mercurial, rename the function in `~/bin/hg.sh`.
- The first run adopts every titled session on disk as a parked cell; with many old sessions that is a long `unsorted` row. `x` forgets one for good; `a` archives a lineage.
- After a bring-back from the archive fails to create its workspace, the archived side still lists the session until you press `R`.
- `--demo` needs herdr running; without it the grid exits with "herdr is not running".

Tested on macOS 26 with Python 3.9, against a sandbox (a throwaway home folder and a stand-in for herdr): drawing, `--demo` (writes nothing), cell placement with and without `categories`, bookmarks, views, help, `t` rename (refused while a member runs; renames live and archived members, keeps dates and numbers, updates the title files), `a` archive and bring-back into the right project folder, `d` delete (refused while a member runs) with a stand-in Trash, `claude_session_lineage_delete_or_archive.py` (`--check`, delete, archive into an existing and a new folder, cells dropped across workspaces, refused while a member runs, canceled), and `ensure`. Not tested here: anything against a real herdr server (going to the grid, resuming, `n`, `p`, moving cells, `=`), the real Trash, the `ensure` LaunchAgent under launchd, and pressing ctrl+alt+g (the step that writes it was run twice against a throwaway config: one block, absolute paths).
