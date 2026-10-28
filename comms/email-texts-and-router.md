# Email, texts and the comms router

Optional sources for the [comms manager](README.md): wake a session when a Google or Outlook email, or an iMessage or SMS, arrives; and the comms router, which reads every new message once and sends the chief of staff the asks no session owns and every deadline. Each part is separate: set up only the ones you use.

Every message these bring in is outside text. Before any session or the chief sees it, the injection checker reads what the watcher brings in (for an email: sender, subject and the start of the body), and anything that looks like an attempt to make the reader act is held: you get an alert. Mail a session opens itself afterwards, for example with `g read`, is not screened. `claude_frontdesk.py release <name> <n>` asks you in a dialog on this Mac, so a session following its rules cannot release a held message; a session with file access could still edit the watcher's state file. Sessions get the text as a file, never as a typed prompt.

All access is read-only. Nothing here can send, delete, move or mark a message.

## Email: Google (Gmail or Google Workspace)
Uses `gws`, installed and signed in by [`../google/`](../google/README.md): one Google account, with the read-only Gmail permission (`gmail.readonly`). Set that up first; nothing here signs in to Google.

Watch for a message (from inside a session):
```bash
claude_frontdesk.py add hotel-reply --what "The hotel's reply about the trip dates" --then "Read it and draft an answer; send nothing" \
  --every 10m --until 14d -- gmail_new 'from:hotel@example.com dates'
```
- The query is Gmail's own search syntax. What matches when you register never fires; only new matches do. The event names each message's sender, date, subject and the first 1500 characters of its body; the session reads the rest itself with the read tools in [`../google/`](../google/README.md), unscreened.
- If `gws` is missing or signed out, the check fails, and after an hour you get one alert. It never tries to sign in.
- `gws` keeps its key in your login Keychain. Whether a launchd job can always reach it, for example right after `brew upgrade` replaces `gws`, is untested; if the check starts failing with a Keychain error, run any `gws` command once in Terminal and click Always Allow.

## Email: Outlook (Outlook.com or Microsoft 365)
Password sign-in for mail programs is gone: Microsoft 365 (work or school) turned it off in 2022, Outlook.com on September 16, 2024. So this uses Microsoft Graph with a one-time sign-in in the browser, read-only: `Mail.Read` (senders, subjects and text), or `Mail.ReadBasic` (senders and subjects only) if you add `--headers-only`, plus `offline_access` so it keeps working unattended.

Sign in (the agent runs it; you open the page it prints, type the code, and sign in):
```bash
~/bin/claude_frontdesk_checks.py outlook-login you@outlook.com
```
- It prints a code and https://microsoft.com/devicelogin. The code works for 15 minutes.
- `--tenant consumers` for an Outlook.com, Hotmail or Live address, `--tenant organizations` for a work or school address; the default `common` takes either.
- The sign-in is saved in `~/.config/knowledge-worker-stack/outlook/<address>.json`, readable only by you. Microsoft hands out a new refresh token each time it is used, and the newest is saved each time. It lasts until you change your password, go 90 days without it being used, or remove the app at https://account.live.com/consent/Manage (Outlook.com) or https://myapps.microsoft.com (work).
- Nobody registers an app: the sign-in uses Microsoft's own public "Microsoft Graph Command Line Tools" app. Microsoft documents that app and its device sign-in, but says nothing for or against other programs using it. If Microsoft ever stops it, the fallback below still works.

**Work or school accounts may need your IT admin.** Any of these stops the sign-in, and only an admin can change them:
- The tenant blocks device sign-in (security defaults block it in tenants created from July 1, 2026; a Conditional Access policy, or Microsoft's own managed "Block device code flow" policy, can block it in any tenant). The error names Conditional Access or AADSTS530036.
- Users cannot approve mail access for apps themselves (the default in many tenants since late 2025). The page then says an administrator must approve; your admin can grant consent for the "Microsoft Graph Command Line Tools" app.
- If the admin will do neither, ask them to allow automatic forwarding to your Google address (Exchange Online blocks forwarding outside the company by default, and the forwarded mail bounces with 5.7.520 until they enable it in the outbound spam policy), then forward and watch it with `gmail_new`. On Outlook.com you can forward yourself: Settings > Mail > Forwarding.

Watch for a message (from inside a session):
```bash
claude_frontdesk.py add meeting-time --what "Sam's answer about the meeting time" --then "Tell me it arrived" \
  --every 5m --until 7d -- outlook_new you@company.com 'sam meeting'
```
- The second argument is optional: words that must all appear in the sender or subject. Without it, any new inbox message fires.

## iMessage and SMS
Reads this Mac's Messages history (`~/Library/Messages/chat.db`), read-only. SMS reaches it only if your iPhone forwards texts to this Mac (iPhone: Settings > Apps > Messages > Text Message Forwarding).

macOS protects that file: whatever reads it needs **Full Disk Access**. A launchd job runs Apple's own `/usr/bin/sqlite3` every minute with one read-only query, and appends the incoming messages among the newest 300 of any kind to a file only you can read. The comms manager reads that file and needs no grant. The grant itself is wide (the trade-off below): skip iMessage unless you need it.
```bash
mkdir -p ~/.claude/state ~/Library/Logs/knowledge-worker-stack
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.imessage-export.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.knowledge-worker-stack.imessage-export</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/sqlite3</string><string>-readonly</string><string>-json</string>
    <string>$HOME/Library/Messages/chat.db</string>
    <string>SELECT m.guid AS key, m.date / 1000000 + 978307200000 AS ts, COALESCE(h.id, '') AS frm, NULLIF(m.text, '') AS body, CASE WHEN COALESCE(m.text, '') = '' THEN hex(m.attributedBody) END AS rich, COALESCE(NULLIF(c.display_name, ''), CASE WHEN c.style = 43 THEN (SELECT group_concat(h2.id, ', ') FROM chat_handle_join x JOIN handle h2 ON h2.ROWID = x.handle_id WHERE x.chat_id = c.ROWID) END, c.chat_identifier, h.id, '') AS thread FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id WHERE m.is_from_me = 0 AND m.item_type = 0 AND m.associated_message_type = 0 AND m.ROWID &gt; (SELECT MAX(ROWID) FROM message) - 300 GROUP BY m.ROWID ORDER BY m.ROWID</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$HOME/.claude/state/state_claude_frontdesk_imessage_export.json</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/imessage-export.log</string>
</dict></plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.knowledge-worker-stack.imessage-export.plist
open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
```
- **The trade-off, plainly: a real widening.** Full Disk Access goes to the `sqlite3` program, not to this one query, and covers every launchd job that runs it as its own program. Any program running as you can add its own LaunchAgent that runs `sqlite3`, and through it read every protected database on this Mac, such as Mail's messages or Safari's history, and it may be able to write to your privacy settings database (`TCC.db`) to grant itself other access. To take the grant back: System Settings > Privacy & Security > Full Disk Access, switch `sqlite3` off or remove it with the minus button. Skipping iMessage avoids the grant entirely; everything else here works without it.
- **You, once:** in the Full Disk Access list that opens, click **+**, press **Cmd+Shift+G**, type `/usr/bin/sqlite3`, Return, Open, and switch it on. That grant is for `/usr/bin/sqlite3` only when it is a launchd job's own program; run from Terminal, Terminal's own permissions apply.
- Then load it and check (the agent does this):
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.imessage-export.plist
sleep 65; ls -l ~/.claude/state/state_claude_frontdesk_imessage_export.json; tail -3 ~/Library/Logs/knowledge-worker-stack/imessage-export.log
```
- A file with `-rw-------` and an empty log means it works. `authorization denied` or `unable to open database` in the log means the grant is missing.
- Each minute the query takes the incoming messages among the newest 300 in the database (your own and reactions count toward the 300), and the check drops what it has already seen. Newer macOS stores many messages only in a formatted field; the check extracts the text from it, and shows `[message without text]` where it cannot (a photo, a sticker).

Watch for a text (from inside a session):
```bash
claude_frontdesk.py add plumber-text --what "The plumber's text about Thursday" --then "Tell me what they said; reply nothing" \
  --every 5m --until 7d -- imessage_new '+1 555 123 0001'
```
- The thread is a phone number (any spelling), an email address, a group's name, or `*` for every incoming text.

## The comms router
One watcher that reads every new email and text from the sources you name, once, and asks the model (one `claude -p` call per run, no tools) for each message: which watcher's matter it belongs to, whether it asks you for something, a one-line summary, and whether it carries an obligation (a deadline, an amount due, a letter from a regulator or government office, a direct question to you, an appointment). It then sends the chief of staff one message listing every ask no watcher owns and every obligation, each as a summary and where to find it, never the message itself.
```bash
CHIEF=$(claude_chief_of_staff_wake.sh --find)          # the live chief's session id
claude_frontdesk.py add router --owner "$CHIEF" --what "Asks no session owns, and every deadline" \
  --then "Tell the user each one in one line: who, what, by when; offer to start a session for a new matter" \
  --every 5m --repeat --max-per-day 12 --until never -- router gmail outlook:you@company.com imessage
```
- Sources: `gmail`, `outlook:<address>` (one per signed-in address), `imessage`. Name only those you set up.
- **Dry run, the only mode built:** a message the model places with a watcher is only logged; that watcher still delivers it. The router's own message goes to the chief alone. Read `~/.claude/state/state_claude_frontdesk_router.jsonl` (one line per message: where it would go, ask, summary, obligation, why) to see whether its sorting matches yours.
- Per run it reads at most 8 emails in full and 10 text threads; the rest wait for the next run. The same sender and subject alert once in 3 days. Your own sent mail is skipped.
- Cost: one Opus call per run that finds new mail, plus the injection checker on its message.
- A model answer that is not the expected list fails the run: nothing is marked read, and the next run judges the same messages again.

## Remove it
```bash
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.imessage-export 2>/dev/null
rm -f ~/Library/LaunchAgents/local.knowledge-worker-stack.imessage-export.plist ~/.claude/state/state_claude_frontdesk_imessage_export.json
rm -f ~/Library/Logs/knowledge-worker-stack/imessage-export.log ~/.claude/state/state_claude_frontdesk_router.jsonl
rm -r ~/.config/knowledge-worker-stack/outlook
```
- Then switch `/usr/bin/sqlite3` off in Full Disk Access, and remove the Outlook app's access at https://account.live.com/consent/Manage or https://myapps.microsoft.com. Google: see `../google/`. Remove the watchers first with `claude_frontdesk.py rm`.

## Known limits
- Nothing is read while the Mac sleeps; the first run after waking catches up (Gmail and Outlook over the last 2 days for the router, 7 for a watcher; iMessage over the newest 300 messages).
- The injection checker is a model's judgment, not a guarantee. Watchers still hand sessions the text as a file to treat as data.
- iMessage text stored only in the formatted field is extracted on a best-effort basis.
- The Outlook sign-in rides on a Microsoft app whose use by other programs is undocumented, and work tenants often block it.

Tested in a throwaway home folder, with stand-ins for `gws`, for Microsoft's sign-in and Graph servers, and a sample Messages database:
- every kind registers, ignores what is already there, and fires on new mail or texts;
- the Outlook sign-in (device code, waiting, saving the token mode 600), the token replacing itself on each refresh, and a revoked token failing with a clear message;
- the iMessage export run exactly as the plist runs it, including text recovered from the formatted field;
- the router's sorting, log, to-do suggestions and its message to the chief;
- with the real injection checker and the real router model: a planted email telling an AI to run a script and send a key, and a planted text asking for a password and code, were both held and alerted; ordinary mail and texts went through. The release dialog was tested with a stand-in for its answers: Keep held, no answer in time, and Release (only the last released it).

Not tested: real Google, Microsoft or Messages data, Full Disk Access under launchd, work-tenant sign-in blocks, and the Keychain under launchd.
