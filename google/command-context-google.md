# Google: rules for g and gws (shown the first time a session runs either)

<!-- claude-command-context: mode=guard; match=\A(?:[^'"]|'[^']*'|"(?:[^"\\]|\\.)*"|"(?=[^"]*(?:\$\(|`)))*?(?:^|[;&|(`\n]|\b(?:ba|z)?sh\s+-l?c\s+["'])\s*(?:(?:sudo|time|env|xargs)\s+(?:-\S+\s+)*|\w+=\S*\s+)*"?(\S*/)?(g|gws)(["'\s;&|)`]|$) -->
These are the rules for Gmail, Drive, Sheets, Docs and Calendar through `g` and `gws`. Re-run the identical command and it will go through.

- Gmail goes through `g` (`g --help` lists the verbs). Raw `gws` is for what `g` does not wrap: Drive, Sheets, Docs, Calendar, and trashing mail.
- NEVER send email. Create or edit drafts only; the user reviews and sends every message, tests included. Never send with raw `gws`: no `send` method, and no `+send`, `+reply`, `+reply-all` or `+forward` without `--draft`.
- Never type the user's name or a signature into a draft yourself: end the body at the sign-off ("Best,"). `g` appends the user's own default Gmail signature.
- One draft per conversation. Revise with `g draft-edit`, never a second draft. A draft you replaced this session, remove at once with `g draft-rm`; any other draft only after the user's OK.
- `g draft-read` before every `draft-edit` or `draft-rm`, even on a draft you made minutes ago: the user may have changed it in Gmail, and `draft-edit` replaces the whole body. If it differs from what you wrote, it is the user's now; stop and ask.
- Read each draft-create line: it prints the stored To and Cc. Cc goes in `--cc a@b,c@d` (`--no-cc` for none).
- Trash, never delete: Trash is recoverable for 30 days. Never use `delete` or `batchDelete` on mail. Trash one message: `gws gmail users messages trash --params '{"userId":"me","id":"<id>"}'`.
- Read each message before trashing it, and trash only what the user named as junk; anything else, ask first. A search filter is not proof of what a message is.
- Ask before sharing a Drive file, changing who can see or edit it, or deleting or overwriting a file, sheet, doc or calendar event.
- Check what is allowed before promising it: `gws auth status` lists the granted scopes. Read-only scopes cannot draft or label; never run `gws auth login` yourself unless the user asked to change permissions (it opens their browser).
- To save a message as a PDF: `gmail_message_to_pdf.py <msg-id> '<subject>.pdf'`. It holds the text only; inline images are not reproduced.
- `g search` is for looking, not counting: it can return fewer rows than exist. For a complete id list use `gws gmail users messages list --params '{"userId":"me","q":"<query>"}' --page-all`. A query that starts with `-` is refused: put a positive term first.
- gws may print a "Using keyring backend" line before its JSON: slice from the first `{` or `[` before parsing.
<!-- end claude-command-context -->
