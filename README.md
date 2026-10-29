# Knowledge Worker Stack

Everything you need to run several Claude Code sessions on your Mac at once and let them do real work: drive a browser, use passwords without ever seeing them, hand long jobs on to fresh sessions, and wake up when a message they are waiting for arrives.

For someone who works in Claude Code every day and wants it to do more on its own; no engineering needed. Not yet installed end to end on a fresh Mac (see [Status](#status)).

## Set it up
Open Claude Code and say:

> Download github.com/thejohnha/knowledge-worker-stack into ~/knowledge-worker-stack and follow INSTALL.md.

It asks you a few questions (whether the agent gets a browser, whether you want to text your agents from your phone, Google, Excel files, and whether it should see your incoming texts), runs [`install.sh`](install.sh), and then walks you through the few clicks only you can do, one at a time.

- **Try first:** `./install.sh --dry-run` lists every change without making any.
- **Undo:** `./install.sh --uninstall`, run from this folder (so keep it), moves what it added to `~/knowledge-worker-stack-backups/` and puts back any file it had replaced. It keeps the vault, the chief of staff's Priorities list, Mattermost's messages, the browser's logins, files you changed since, and the apps Homebrew installed (it prints how to remove them). It deletes the saved Outlook sign-in and its copies of your messages; for Google it prints how to sign out.
- **Update:** get the new version into this folder (`git pull`, or the download in [INSTALL.md](INSTALL.md#1-check-the-machine)), then run `./install.sh` again. An installed file you changed is backed up before it is replaced.

## What you need
- A Mac with Apple silicon (M1 or later) and macOS 15 or later (tested on macOS 26). Intel Macs are untested.
- Claude Code, signed in. A few background checks (screening incoming messages) call Opus and count toward your Claude plan's usage.
- Homebrew. If it is missing, the installer stops before changing anything and gives you the one command that installs it.

## Every day
Open Terminal, type `h`, press Enter. That is the whole start. [CHEATSHEET.md](CHEATSHEET.md) is the one page to keep: the keys for moving between sessions, the grid, and the commands you can type to Claude.

## What you get
| Folder | In plain words |
|:---|:---|
| [`secret-dialog/`](secret-dialog/) | When Claude needs a password only you know, a small window pops up and asks you. What you type goes straight to where it is needed; Claude never sees it. |
| [`vault/`](vault/) | A separate password store just for Claude, holding only the logins you choose to give it. Claude can use a password without ever seeing or displaying it. |
| [`browser/`](browser/) | Claude uses a real browser, signed in to your sites, in its own background windows that never take over your screen. In the Linux-machine setups it can also delete cookies from sites you didn't ask to keep. |
| [`herdr/`](herdr/) | A terminal that keeps many Claude sessions open side by side in tabs, starts with your Mac, brings back the right session in the right tab after a restart, and lets one session message another. |
| [`herdr/grid/`](herdr/grid/) | One screen showing every session, running or put away. Put sessions away to free memory, bring them back with Enter, star, search, rename and archive them. |
| [`claude-code/`](claude-code/) | Add-ons for Claude Code: dated session titles that keep themselves tidy, a status bar, `/successor` to hand a long session to a fresh one (automatically once it gets very long), a sweep for loose ends, a stated purpose for every session, the date and time on every message, "skip" to stop permission prompts, plainer replies on request, sign-in without Keychain pop-ups, hourly memory backups, old sessions kept instead of deleted after 30 days, text put on your clipboard checked before Claude says it is there, and a starter CLAUDE.md (the standing instructions Claude reads in every session) with good working rules. |
| [`google/`](google/) | Claude searches and reads your Gmail, finds files in Drive, reads Sheets and Docs and checks your calendar, through Google's own command-line tool signed in as you. It writes email drafts; you send them. It can also save an email as a PDF. |
| [`office/`](office/) | Lets Claude change Excel workbooks without losing formulas, stored results, formats or pivot tables, and lists the traps that corrupt a workbook. Optional. |
| [`comms/`](comms/) | A session can say "wake me when this message arrives" and stop; it is woken when it does. A chief-of-staff session keeps track of what every other session is waiting on you for, and keeps one ranked list of everything that needs you, with deadlines, which it works from. Optionally, text the chief of staff from your phone through [Mattermost running on your own Mac](comms/mattermost/); as installed only the Mac reaches it, and opening it to the phone is an extra, untested step. A text from the phone never approves sending, posting, submitting or paying; only you, typing at the Mac, do. |

## Know the risks
- **The browser on your Mac.** With the Mac browser setup, any program running as you can drive that browser, with every login in it, and read any file on your Mac through it. Keep it to sites you are comfortable letting Claude use, or choose the separate Linux-machine setup in [`browser/`](browser/).
- **"skip".** It restarts a session with every permission prompt and safety check turned off, so anything that session reads (a web page, an email) could steer it unchecked. It turns on only when you type the word; Claude has to ask you for it. It stays on for that session, also after a restart; a session handed on with `/successor` does not inherit it. Use it only for trusted work.
- **Texting from your phone.** Mattermost's traffic is not encrypted. Opened to your Wi-Fi, anyone on that network could read it and pose as you, and the chief of staff acts on what you text it. Reach it only through an encrypted route such as Tailscale (not tested here).
- **The vault's key file.** It opens the vault without a password, which is what lets Claude use it unattended. Never put the key file in a folder that syncs to the cloud, and back it up.

## Installing by hand
Each folder's README is complete on its own, and `install.sh` does exactly what they say. Install in this order, because later folders use earlier ones:

1. `secret-dialog/` → `vault/`
2. `browser/` (any one setup; `orbstack/` also installs the OrbStack that Mattermost uses)
3. `herdr/` → `claude-code/` → `herdr/grid/`
4. `comms/mattermost/` → `comms/`
5. `google/`, any time after `claude-code/` (its rules load through claude-code's tool-rules hook); `office/`, any time

Scripts go in `~/bin`. Afterwards, open a new terminal and restart Claude Code so both pick up the new `PATH`, hooks and skills.

The rules that keep passwords out of Claude's output are already in the starter CLAUDE.md. If you keep your own `~/.claude/CLAUDE.md` instead, add these:

```markdown
# Credentials
- NEVER show a password, key, token or 2FA seed in output. Pipe it straight into the program that uses it, or into a variable: `P=$(agent_get_credential '<full title>')`. Cutting off part of a value does not hide it.
- Credentials come from the agent vault with `agent_get_credential`. Find titles with `list` or `find`; never guess them.
- A secret only I know goes through `ask_secret.sh`, never a command for me to paste. Make the dialog say what the password is for.
- Never read the Notes field of a vault entry.
- Prefer a site's API or a dedicated tool; use the browser only for sites that have nothing else.
```

## Status
A snapshot shared as-is and updated from time to time. No test suite ships. Each part was tested in a throwaway setup, and each folder's README says what was and was not tested; the whole install has not yet been run end to end on a fresh Mac.

## License
MIT, see [LICENSE](LICENSE). The `/wait-what` skill is from [mattpocock/skills](https://github.com/mattpocock/skills), also MIT; its notice is in [claude-code/skills/wait-what/LICENSE](claude-code/skills/wait-what/LICENSE).
