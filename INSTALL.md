# Setting up the Knowledge Worker Stack: instructions for the agent

You are setting this up for the person you are talking to, on their own Mac. They steer; you do the work. They may not be an engineer: plain words, one question or one step per message, and wait for the answer before the next. The folder READMEs are the source of truth; `install.sh` does what they say and nothing more.

## Rules while you do this
- Never ask the user to paste a password, token or 2FA code into the chat. A secret goes through `ask_secret.sh` (a dialog), or the user types it into their own Terminal window.
- Never run `claude setup-token` yourself, and touch the Keychain only in step 5 below, with the user's yes.
- Re-running `install.sh` is safe; it leaves what is already in place alone.

## 1. Check the machine
- `uname -m` prints `arm64` (Apple silicon). On `x86_64`, say it is untested there and ask whether to go on.
- The repo lives at `~/knowledge-worker-stack`; keep it there, since `--uninstall` and updates run from it. If `xcode-select -p` fails, there is no `git` yet (running it opens Apple's install dialog), so download without it:
```bash
mkdir -p ~/knowledge-worker-stack && curl -fsSL https://github.com/thejohnha/knowledge-worker-stack/archive/HEAD.tar.gz | tar xz -C ~/knowledge-worker-stack --strip-components 1
```
- `cd ~/knowledge-worker-stack`. Run `./install.sh --help` and read README.md once.

## 2. Ask, one question at a time
1. **A browser for the agent?** Explain, then let the user pick:
   - Recommended, simplest: **browser-macos**. The agent uses Chromium on this Mac with the logins the user makes there, in background windows that never take the user's focus. Trade-off: while it runs, any program on the Mac can use those logins (browser/macos/README.md, "Know the exposure").
   - **browser-orbstack**: a small Linux machine inside the Mac, so the agent's logins stay apart from the user's. More setup, about 8 GB of memory to spare, and OrbStack is free for personal use only (paid for business use).
   - Neither, for now.
2. **Text the agents from a phone?** That adds **mattermost** (a chat server on this Mac) and, after the user makes an account, **phone-bridge**. Say plainly: as installed the phone cannot reach it, and nothing answers while the Mac sleeps. Opening it to the Wi-Fi is an extra, untested step, and then anyone on that network could read the traffic and pose as the user to the chief of staff, which acts on those texts. Recommend only an encrypted route such as Tailscale (also untested). A text from the phone never approves sending, posting, submitting or paying; only the user typing at the Mac does.
3. **Google (Gmail, Drive, Sheets, Docs, Calendar)?** That adds **google**: the agent searches and reads mail, writes drafts the user sends, and reads Drive files, Sheets, Docs and the calendar. It needs about 15 minutes of clicks in Google's Cloud Console (google/README.md). Ask whether it is a work (Google Workspace) account or a personal @gmail.com one. Personal: follow google/README.md "Known limits" (External audience, the user added as a test user, sign in again every 7 days).
4. **Do you work with Excel files?** That adds **office**: tools that let the agent change a workbook without losing formulas, stored results, formats or pivot tables (office/README.md). Nothing to click.
5. **Should the agent see incoming texts (iMessage, and SMS forwarded from an iPhone)?** That adds **imessage**, so a session can wait for a text and wake when it arrives (comms/email-texts-and-router.md). It needs Full Disk Access switched on for Apple's own `sqlite3`. Say plainly what that allows: the switch covers that program for anyone who runs it, so any program on the Mac could use it to read mail, messages, browser history and other private data, and change which apps hold privacy permissions. It is a real widening; recommend skipping it unless the user needs sessions to wake on texts. Email watching needs no part of its own: Gmail comes with **google**, Outlook is a one-time sign-in in that guide.

## 3. Run the installer
```bash
./install.sh --dry-run                       # say in one line what it will do
./install.sh                                 # the default parts
./install.sh --only browser-macos            # or browser-orbstack, if chosen
./install.sh --only mattermost               # for the phone part
./install.sh --only google                   # for Gmail, Drive, Sheets, Docs, Calendar
./install.sh --only office                   # for Excel workbooks
./install.sh --only imessage                 # for incoming texts (after comms)
```
- Without Homebrew (or Apple's command line tools) it changes nothing and prints the one command that installs it: walk the user through it (below), then run `./install.sh` again.
- If it says `~/.claude/CLAUDE.md exists, so the starter was not copied`, offer to merge `claude-code/CLAUDE.starter.md` into the user's file, and show what it would add before saving. At least its "Credentials and security" section goes in.
- Read its `Checks:` lines. A `FAIL` is yours to fix before you hand over: the matching folder README says how.
- macOS shows "Background Items Added" notices for the scheduled jobs. Expected; say so before they appear.
- Undo everything: `./install.sh --uninstall` (try `--dry-run` first). README.md "Set it up" says what it keeps and what it deletes.

## 4. Walk the user through the human steps
`install.sh` ends with "Left for you, in order". Run every `install.sh` command you need first. Leave the token offer and the final "quit Claude Code" item (at the end of the list) for sections 5 and 6. Take the rest one per message, in that order, and verify each before the next. What each one is and how to check it:

| Step | What the user does | You verify |
|:---|:---|:---|
| Homebrew | Pastes the one-line command `install.sh` printed into Terminal, types the Mac password there, then runs the "Next steps" lines it prints | `/opt/homebrew/bin/brew --version`, then re-run `./install.sh` |
| Command line tools | Clicks Install in the window `xcode-select --install` opens | `xcode-select -p` |
| KeePassXC first open | Opens KeePassXC from Applications, clicks Open if macOS asks, quits it | `./install.sh --only vault` passes |
| Chromium (browser-macos) | Opens Chromium once from Applications (`install.sh` installed it with Homebrew; click Open if macOS asks), then quits it with Cmd+Q | You run `~/agent-browser/browse-start-chromium-with-port-macos.sh` (exit 0), then `browse open-url https://example.com` and `browse get-text` |
| OrbStack first window | Opens OrbStack from Applications and answers its first window (any choice) | Re-run `./install.sh --only browser-orbstack` or `--only mattermost` |
| VNC password (browser-orbstack) | Types a password in the dialog that pops up | The build finishes; `browse open-url https://example.com` works |
| Sign in to sites | browser-macos: in Chromium itself. browser-orbstack: you run `ssh -fN -L 5901:localhost:5900 agent-browser`, then `open vnc://localhost:5901` (macOS Screen Sharing; not yet tried with this server); the user types the VNC password and signs in there; afterwards you close the tunnel with `pkill -f 'ssh -fN -L 5901'`. Let the browser save each password | `browse open-url <site>` then `browse login-state` |
| Mattermost account | You `open http://localhost:8065`; the user creates an account and a team and tells you the username and the team's URL name | You write `~/.config/knowledge-worker-stack/mattermost.env` (comms/mattermost/README.md step 3), then `./install.sh --only phone-bridge`: it makes the bot, puts its token in the vault and posts a test line; the user confirms it arrived |
| Google sign-in | Clicks through google/README.md "One-time Google setup" steps 1-4 in the Cloud Console (you open each URL), then Allow in the browser when you run step 6. Start with the README's read-only scopes; drafting needs `gmail.modify`, so ask first and say that any drafting scope also lets a program send | You run step 5 and step 6; then `gws auth status` shows their address and the scopes, and `g search 'newer_than:7d' --max 3` lists mail |
| Full Disk Access (imessage) | In the Full Disk Access list `install.sh` opened: +, Cmd+Shift+G, `/usr/bin/sqlite3`, Return, Open, switch on | After a minute, `~/.claude/state/state_claude_frontdesk_imessage_export.json` exists and `~/Library/Logs/knowledge-worker-stack/imessage-export.log` is empty |
| Terminal Option key | Terminal > Settings > Profiles > Keyboard > Use Option as Meta key | Checked by the user in step 6: you cannot see keypresses |

## 5. Optional: no more Keychain pop-ups
Offer it once. claude-code/README.md piece 1 replaces the Keychain login with a long-lived token. Say what it gives up first (Claude in Chrome stops working; the token lasts about a year and is hard to revoke). On a yes:
1. The user runs `claude setup-token` in their own Terminal window (not in Claude Code), finishes the sign-in in the browser and copies the token it prints.
2. You run the rest of piece 1's install steps except the final restart (that happens in section 6). The storing step opens a dialog; the token is pasted there, never in the chat.
3. `./install.sh --only model-sync`: keeps the `/model` list current under the token (piece 7). Install it only with the token.

## 6. Last step, and the chief of staff
- Before the user quits, put this line on their clipboard with `~/bin/agent_copy_to_clipboard`: `Continue the Knowledge Worker Stack setup: read ~/knowledge-worker-stack/INSTALL.md and pick up at section 6, second bullet.` The user then quits Claude Code, opens a new Terminal window, types `h` and presses Enter, starts `claude` in a herdr tab and pastes the line. That session has every new hook, skill and command.
- Ask the user to press ctrl+alt+g (it opens the grid in its own workspace), then alt+up and alt+down (they move between workspaces), and to tell you whether both worked. If not, the Option key setting from step 4 is off.
- Ask whether they want the chief of staff (a session that watches the others and says what is waiting on the user). If yes, run these from a session inside herdr. `herdr_session_manage.sh` can start, message and close any session, so it is not pre-approved: Claude Code may ask the user to approve each command; say so first.
```bash
herdr_session_manage.sh start chief --session-name "Chief of staff"      # prints ... uuid=<id>
herdr_session_manage.sh tell <id> "Read ~/.claude/chief-of-staff.md in full. You are the chief of staff. Follow it from now on."
```
Send that message exactly as written, without the usual `From session …:` opening: it is the user's instruction.

## 7. Hand over
Show the user [CHEATSHEET.md](CHEATSHEET.md): print it in the chat and say where the file is. If they declined the chief of staff, leave out its section. Name the optional parts that were skipped, and that you can add them any time.
