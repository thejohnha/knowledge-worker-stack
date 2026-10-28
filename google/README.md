# Google: Gmail, Drive, Sheets, Docs, Calendar

Lets Claude search and read your Gmail, write reply drafts for you to send, find files in Drive, read Sheets and Docs, and check your calendar. It uses `gws`, Google's own open-source command-line tool for Workspace, installed on this Mac and signed in once as you. Nothing goes through a third-party server: your Mac talks straight to Google.

- `gws` reaches every Workspace service. Claude reads `gws <service> --help` to find a command.
- `g` is a small wrapper for everyday Gmail jobs: search, read, attachments, drafts, labels. It has no way to send mail. Every draft carries your own Gmail signature, as if you had written it in Gmail, and waits in your Drafts folder until you send it yourself.

## What you need
- A Google Workspace account (a work address on your own domain), and permission to create a Google Cloud project. A personal @gmail.com address also works, but see Known limits.
- Homebrew. `g` uses the Mac's own `python3`, which comes with Apple's command line tools (Homebrew installs those too).

## Install
From this folder:
```bash
brew install googleworkspace-cli          # not `brew install gws`: that is a different program
mkdir -p ~/bin && cp g gmail_message_to_pdf.py ~/bin/ && chmod 755 ~/bin/g ~/bin/gmail_message_to_pdf.py
mkdir -p ~/.claude/command-context && cp command-context-google.md ~/.claude/command-context/google.md
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
gws --version
```

## One-time Google setup (about 15 minutes)
Google requires every program that reads your mail to be registered in a Google Cloud project, even one used only by you. You do this once, in the browser, signed in as the Google account Claude will use. A personal @gmail.com account differs at step 3: see Known limits. Claude can open each page for you. Only you can click through them.

1. **Create the project.** Open https://console.cloud.google.com/projectcreate. Name: `knowledge-worker-stack`. Under Organization or Location, keep your company's domain (Internal in step 3 needs it; a personal account shows No organization, which is fine). Click Create, then make sure `knowledge-worker-stack` is the project selected at the top of the page.
2. **Turn on the APIs.** Open https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,drive.googleapis.com,sheets.googleapis.com,docs.googleapis.com,calendar-json.googleapis.com, check that `knowledge-worker-stack` is selected, and click Next, then Enable.
3. **Consent screen.** Open https://console.cloud.google.com/auth/overview and click Get started. App name: `knowledge-worker-stack`. Support email: yours. Audience: **Internal** (a personal @gmail.com account: External). Contact email: yours. Agree and click Create.
   - Internal means only accounts in your organization can sign in. In return Google shows no "unverified app" warning, needs no test-user list, and does not sign you out every 7 days.
4. **Desktop client.** Open https://console.cloud.google.com/auth/clients, click Create client. Application type: **Desktop app**. Name: `gws`. Click Create, then **Download JSON**.
5. **Hand the file to gws.** Claude runs this. The file is a key, so it never goes in the chat:
   ```bash
   mkdir -p ~/.config/gws && chmod 700 ~/.config/gws
   mv ~/Downloads/client_secret_*.json ~/.config/gws/client_secret.json && chmod 600 ~/.config/gws/client_secret.json
   ```
6. **Sign in.** Claude runs the command below. A browser tab opens: pick your account and click Allow.
   ```bash
   gws auth login --scopes https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/spreadsheets.readonly,https://www.googleapis.com/auth/documents.readonly,https://www.googleapis.com/auth/calendar.readonly
   ```
   The sign-in is saved encrypted in `~/.config/gws`, and its key is kept in your Mac's Keychain. It stays signed in until you remove it.

## Which permissions (scopes)
Start read-only. It is enough to search and read mail, find and read files, and see your calendar, and Google itself blocks any change.

| To let Claude | Scope (add `https://www.googleapis.com/auth/` in front) |
|:---|:---|
| Search and read mail (the start) | `gmail.readonly` |
| Find and read Drive files, Sheets, Docs (the start) | `drive.readonly`, `spreadsheets.readonly`, `documents.readonly` |
| See your calendar (the start) | `calendar.readonly` |
| Write drafts, label and archive mail, move mail to Trash | `gmail.modify`, in place of `gmail.readonly` |
| Edit Sheets / Docs | `spreadsheets` / `documents` |
| Add and change calendar events | `calendar.events` |
| Read contacts | `contacts.readonly` (also enable `people.googleapis.com` as in step 2) |

- **Any scope that lets Claude write a draft also lets a program send mail.** Google has no "drafts only" permission. What keeps Claude from sending is that `g` has no send command and the rules below forbid it. If you want Google itself to make sending impossible, stay on `gmail.readonly`.
- **Add more later.** Run step 6 again with the complete list you want (full addresses, separated by commas), then check `gws auth status`. Claude can build the command.
- **Take one away.** Revoke the app at https://myaccount.google.com/connections, then run step 6 again with the smaller list.
- `--scopes` needs the full addresses. Short names like `gmail` are passed to Google as they are and fail.

## Check it works
```bash
gws auth status                                          # your address and the scopes you granted
gws gmail users getProfile --params '{"userId":"me"}'    # your mailbox
g search 'newer_than:7d' --max 3                         # three recent messages
gws drive files list --params '{"pageSize":3,"fields":"files(id,name)"}'
```

## Use
Just ask Claude: "find the dishwasher warranty in my Drive", "what does row 12 of the budget sheet say", "draft a reply to the latest email from the plumber saying Thursday works", "what's on my calendar tomorrow". Commands Claude reaches for:
```bash
g search 'from:someone@example.com newer_than:30d'      # list messages (--max N for more than 25)
g read <msg-id>                                          # full message; lists attachments
g attachment <msg-id> 1 > report.pdf                     # save attachment 1
g draft-reply <msg-id> < body.txt                        # threaded reply draft (needs gmail.modify)
gmail_message_to_pdf.py <msg-id> 'Report email.pdf'      # the message itself as a PDF
g drafts                                                 # list drafts
gws drive files list --params '{"q":"name contains '\''budget'\''","fields":"files(id,name,mimeType,modifiedTime)"}'
gws drive files export --params '{"fileId":"<id>","mimeType":"text/plain"}' -o doc.txt    # a Google Doc as text
gws sheets +read --spreadsheet <id> --range 'Sheet1!A1:F40'
gws calendar +agenda --tomorrow
```
`g --help` lists every verb. A Gmail search that starts with `-` is refused: put a positive term first (`'newer_than:7d -in:sent'`).

`gmail_message_to_pdf.py` prints the subject, From, To, Date, the body, the attachment names and the Gmail message id (so the original can be found again) to a PDF, through Chromium's print engine ([`../browser/macos/`](../browser/macos/)), or Google Chrome's when Chromium is not in Applications. It needs no browser sign-in, and it never touches a browser that is already running.

## Rules Claude follows
They live in [`command-context-google.md`](command-context-google.md), installed as `~/.claude/command-context/google.md`. The tool-rules hook ([claude-code piece 18](../claude-code/README.md#18-tool-rules-on-first-use)) shows them to a session the first time it runs `g` or `gws` (that command is stopped once, then goes through), so they cost nothing in sessions that never touch Google. Without that hook, paste the bullets of that file into `~/.claude/CLAUDE.md` instead. In short:
- Never send email. Claude only creates and edits drafts; you send every message.
- Claude never types your name or a signature; `g` adds your own Gmail signature.
- One draft per conversation, revised in place, and re-read before every change, because you may have edited it in Gmail.
- Trash, never permanent delete, and only mail you named as junk; anything else, Claude asks first.
- Claude asks before sharing a Drive file, changing who can see it, or deleting or overwriting a file, sheet, doc or event.

## Remove it
```bash
gws auth logout                                          # deletes the saved sign-in on this Mac
security delete-generic-password -s gws-cli -a "$USER"   # the encryption key gws kept in the Keychain
rm ~/bin/g ~/bin/gmail_message_to_pdf.py ~/.claude/command-context/google.md && brew uninstall googleworkspace-cli
mv ~/.config/gws ~/.Trash/                               # the client file from step 5
```
Then cut Google's side:
- https://myaccount.google.com/connections: find `knowledge-worker-stack` and choose Delete all connections. That revokes the sign-in even if this Mac is lost.
- Optional: delete the project at https://console.cloud.google.com/iam-admin/settings (Shut down).

## Known limits
- **Your Workspace admin can block it.** If sign-in says "Access blocked" or "admin_policy_enforced", the organization allows only approved apps: the admin trusts the client ID (from step 4) in Admin console > Security > Access and data control > API controls. Some organizations also stop users from creating Cloud projects.
- **A personal @gmail.com account** cannot pick Internal. Choose External, add yourself under Audience > Test users, and expect an "unverified app" warning (click Continue). While the app is in Testing, Google ends the sign-in after 7 days. Audience > Publish app stops that, but the warning stays.
- **`g` is Gmail only.** Drive, Sheets, Docs and Calendar go through `gws` directly, with fewer guard rails.
- **`g` cannot attach files to a draft.** Add attachments in Gmail before you send.
- **The PDF is not Gmail's own rendering.** It holds the text of the message; images in the body and its formatting are not reproduced.
- **`g search` is for looking, not for counting.** It can show fewer rows than exist. For a complete list Claude uses `gws gmail users messages list --page-all`.
- **gws is young** (version 0.x). An update can rename a command; `g` was written against 0.22.5.
- **Keychain.** After a `brew upgrade`, macOS may ask once whether `gws` may use its Keychain item: click Always Allow. A job running in the background with no one at the screen may fail until then.

Tested on macOS 26 against gws 0.22.5's own help and source, with a stand-in `gws` that records every call: all 14 `g` verbs, and the refusals (sent draft, unknown flag, unverified `--from`, self-Cc, not signed in); `gmail_message_to_pdf.py` against a stand-in `g` and a stand-in browser (Chromium chosen, the Chrome fallback, no browser, a failed read). No `g` command reached a send or a permanent delete, except that `draft-edit` on a reply permanently deletes the throwaway draft it made itself to build the new body. Not tested: a real Google account, the Cloud Console clicks (written from Google's documentation in October 2026), the Internal and admin-blocked paths, and the Keychain prompt.
