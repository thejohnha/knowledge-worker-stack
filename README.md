# Knowledge Worker Stack

Everything you need to run several Claude Code sessions on your Mac at once and let them do real work: drive a browser, use passwords without ever seeing them, hand long jobs on to fresh sessions, and wake up when a message they are waiting for arrives. The point of it all: a chief-of-staff session starts work on every task that reaches you, from you or from your email and texts, so when you open your laptop or phone, the work is done up to the step only you can take, and that step is waiting for you.

For someone who works in Claude Code every day and wants it to do more on its own; no engineering needed. Not yet installed end to end on a fresh Mac (see [Status](#status)).

## Set it up
Open Claude Code and say:

> Download github.com/thejohnha/knowledge-worker-stack into ~/knowledge-worker-stack and follow INSTALL.md.

It shows you what you can get (below), asks which parts you want, runs [`install.sh`](install.sh), and then walks you through the few clicks only you can do, one at a time.

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
| What you get | In plain words | Where |
|:---|:---|:---|
| **Work done before you look** | A chief-of-staff session reads what reaches you (your email and texts, and whatever you hand it) and puts each task in the hands of a session that does everything that can be undone. When you open your laptop or phone, what waits for you is only the step only you can take: a send, a payment, a signature, a decision. It keeps one ranked list of everything that needs you, with deadlines, and works it in that order. | [`comms/`](comms/) |
| **Sessions that wait, then pick up** | A session can say "wake me when this reply arrives" and stop; it is woken when the email, text or reply lands. | [`comms/`](comms/) |
| **Many sessions, one screen** | Many Claude sessions side by side in tabs, started with your Mac and brought back in the right tab after a restart. One screen shows them all, running or put away. | [`herdr/`](herdr/), [`herdr/grid/`](herdr/grid/) |
| **Sessions that keep their place** | A long session hands itself on to a fresh one without losing the thread; every session has a stated purpose, a dated title, and the date and time on every message. Starter working rules for Claude come with it. | [`claude-code/`](claude-code/) |
| **A browser of its own** | Claude uses a real browser, signed in to your sites, in background windows that never take over your screen. | [`browser/`](browser/) |
| **Passwords it uses but never sees** | A separate password store holding only the logins you give Claude, and a pop-up for the ones only you know. | [`vault/`](vault/), [`secret-dialog/`](secret-dialog/) |
| **Your Gmail, calendar and Google files** | Claude searches and reads your mail, Drive, Sheets, Docs and calendar. It writes drafts; you send them. | [`google/`](google/) |
| **Text your chief of staff from your phone** | Optional, through [Mattermost on your own Mac](comms/mattermost/). A text from the phone never approves sending, posting or paying; only you, at the Mac, do. | [`comms/mattermost/`](comms/mattermost/) |
| **Keeps working while you are away** | Type `zz` and the Mac stays awake, lid closed too; `zzz` lets it sleep again. Optional. | [`keep-awake/`](keep-awake/) |
| **Excel files changed safely** | Claude changes a workbook without losing formulas, formats or pivot tables. Optional. | [`office/`](office/) |

## Know the risks
- **The browser on your Mac.** With the Mac browser setup, any program running as you can drive that browser, with every login in it, and read any file on your Mac through it. Keep it to sites you are comfortable letting Claude use, or choose the separate Linux-machine setup in [`browser/`](browser/).
- **Work started by an email.** The chief of staff starts a session for a task it finds in your email or texts without asking you, so a stranger's email can get one going and spend your Claude plan's usage. That session is told the task came from outside, treats the sender's words as information, never instructions, and stops before anything leaves the Mac; the chief starts at most 10 such sessions a day. You can tell the chief to ask you first instead.
- **"skip".** It restarts a session with every permission prompt and safety check turned off, so anything that session reads (a web page, an email) could steer it unchecked. It turns on only when you type the word; Claude has to ask you for it. It stays on for that session, also after a restart; a session handed on with `/successor` does not inherit it. Use it only for trusted work.
- **Texting from your phone.** Mattermost's traffic is not encrypted. Opened to your Wi-Fi, anyone on that network could read it and pose as you, and the chief of staff acts on what you text it. Reach it only through an encrypted route such as Tailscale (not tested here).
- **A Mac that cannot sleep.** After `zz`, a closed Mac keeps running, in a bag too, where it can overheat and drain its battery flat; nothing turns sleep back on by itself. Run `zzz` before you pack it. Its optional sudo rule lets any program running as an admin user turn sleep blocking on or off without a password (only those two exact commands).
- **The vault's key file.** It opens the vault without a password, which is what lets Claude use it unattended. Never put the key file in a folder that syncs to the cloud, and back it up.

## Installing by hand
Each folder's README is complete on its own, and `install.sh` does exactly what they say. Install in this order, because later folders use earlier ones:

1. `secret-dialog/` → `vault/`
2. `browser/` (any one setup; `orbstack/` also installs the OrbStack that Mattermost uses)
3. `herdr/` → `claude-code/` → `herdr/grid/`
4. `comms/mattermost/` → `comms/`
5. `google/`, any time after `claude-code/` (its rules load through claude-code's tool-rules hook); `office/`, any time; `keep-awake/`, any time

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
