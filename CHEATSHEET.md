# Cheat sheet

## Getting started
1. Open Terminal (Cmd+Space, type `Terminal`, press Enter).
2. Type `h` and press Enter. You are now in herdr, where every Claude session lives in its own tab.
3. Type `claude` and press Enter to start a session. Talk to it in plain words.

To leave, press ctrl+b, then q. Everything keeps running. Type `h` again to come back.

## Moving around in herdr
ctrl+b is the "prefix": press ctrl+b, let go, then press the next key. You can also just click tabs, panes and the sidebar.

| To | Press |
|:---|:---|
| Open a new tab | ctrl+b, then c |
| Next / previous tab | ctrl+b, then n / p (or alt+shift+right / left) |
| Next / previous workspace (a group of tabs; the sidebar lists them) | alt+down / alt+up |
| Jump to the next / previous session | ctrl+alt+down / ctrl+alt+up |
| Split the screen right / down | ctrl+b, then v / - |
| See every key | ctrl+b, then ? |
| Leave (everything keeps running) | ctrl+b, then q |

The alt keys need Terminal's "Use Option as Meta key" turned on (Settings > Profiles > Keyboard).

## The grid: ctrl+alt+g
One screen with every session, running or put away. From a plain Terminal, type `hg` (if you use Mercurial, whose command is also `hg`, ask the agent to rename this one).

| Key | Does |
|:---|:---|
| arrows, Enter | move; open the session (a parked one comes back) |
| n | new session here |
| p | park: close the session to free memory; its spot stays |
| b / Tab | bookmark / jump to the next bookmark |
| / | search |
| ? | every key |
| q | quit the grid |

Dots: yellow = working, green = waiting for you, red = asking you a question, P = parked.

## Chief of staff: ctrl+alt+c
If you set one up: jumps to your chief of staff session (and wakes it if it was stopped). Ask it "what's waiting on me?" Type `priorities.py` in a tab to see its ranked list of what needs you; p on a row sets its rank, and the chief keeps yours. A text from your phone never approves sending, posting, submitting or paying; do that at the Mac.

## Typing in a session
| Type | When |
|:---|:---|
| `/successor` | The session is getting long. It hands over to a fresh, numbered session in a new tab. |
| `/loose-ends` | Before you close a session. It finds and finishes anything left undone. |
| `/retitle` | The session's title no longer says what it is doing. |
| `/prime-directive` | See or set what this session is for and when it is done. |
| `/bro` | Say that last reply again, plainer. |
| `/wait-what` | Explain that last reply again, with a little context. |
| `skip` | Just the word: restarts the session with no permission prompts. Only you can turn it on, and it stays on for that session. Risky; only for work you trust. |

Replies come as a one-line TL;DR and a checklist (the Rundown style); switch styles with `/output-style`.

Under the input box, `Cx:` shows how full the session is: green is fine, yellow means wrap up soon, red means run `/successor`.

## Asking the agent
- **Browser:** "Use the browser to look up …" It works in its own tab. Sign in to a site once yourself; after that it can use the site.
- **Google:** "Find the dishwasher warranty in my Drive", "read the budget sheet", "draft a reply to that email", "save that email as a PDF" (needs Chromium or Google Chrome installed). Claude only drafts, and only if you allowed drafting during setup; you send every email yourself.
- **Excel:** "Add these rows to the budget workbook." Claude works on a copy and keeps formulas, formats and pivot tables intact.
- **Passwords:** the agent keeps its own logins in its vault. "Add a vault entry for Example Site" makes a box pop up for you to type the password.
- **Approving:** Claude Code may ask you before Claude starts, messages or closes another session, or moves a session to another account. Read what it is about to do, then allow it or not.
- **A box asking for a password:** that is the agent asking for something only you know. Read what it says it is for before you type. Never paste a password into the chat.
- **Waiting:** "Wake this session at 9 tomorrow to check on this" or "when a new file lands in Downloads". The session can stop; it comes back on its own.

## If something looks wrong
- Sessions gone after a restart: in a plain Terminal (not inside herdr), type `hr` and press Enter.
- Ask the agent. It can read every guide in this folder.
