#!/usr/bin/env node
// browse.js — agentic browser wrapper for a WINDOWS box driving Microsoft Edge.
// Drives a persistent, logged-in Edge over CDP (localhost:9222) so AI harnesses get one
// always-on browser, shared by many agent sessions at once without them colliding.
//
// WINDOWS/EDGE FORK of the Linux/Chrome browse.js ("upstream" below). This file is a FORK, not a branch:
//   it is meant to be edited freely for the box it runs on, and it does not track upstream. Everything below
//   that is not marked as a Windows difference is upstream's code and upstream's reasoning, unchanged.
//   Setup recipe: README.md, beside this file.
// Windows differences, all of them: the four state/download paths, the browser-restart command,
//   and the OS-level keystroke and the native-prompt probe (PowerShell instead of xdotool + AT-SPI).
//
// Deployed to C:\\agent-browser\\browse.js (MUST live there so Node resolves node_modules from the same folder).
// Invoke:  browse <verb> [args] [--account <email>] [--new] [--out <path|->]
//   ALWAYS through the entry point browse.ps1, which serializes callers and caps each call at 240s — this script
//   assumes serial access. From another machine, browse-ssh-entry.sh injects BROWSE_SESSION=$CLAUDE_CODE_SESSION_ID.
// Contract: data verbs print ONE JSON line to stdout; capture verbs (screenshot/print2pdf/save-page) write to
//   BROWSE_DOWNLOADS and print {path,bytes}, or stream raw bytes with `--out -`. Errors → stderr,
//   non-zero exit. Callers piping `--out -` MUST check the exit code (non-zero ⇒ discard stdout).
//   save-page is the exception to the streaming half: SingleFile writes the .html through the browser's own
//   download path, so there are no bytes to pipe and `--out -` is rejected.
//   download does NOT choose a directory: the file lands wherever the BROWSER saves it (its own default
//   download dir — on Windows that is %USERPROFILE%\\Downloads unless Edge has been pointed elsewhere) and the
//   absolute path comes back in the JSON. Use the returned path.
// STABLE ELEMENT REFS: `snapshot` prints the page's interactable elements, each with a `ref` that names the
//   NODE rather than a query, and click/enter-text/press-key/upload-file/get-text take `--ref <n>` in place of
//   a selector. Prefer a ref over a selector for any multi-step flow on a page that reflows between calls — a
//   re-resolved selector can land on a different element and exit 0; a ref hits the same node or fails loud.
//   Additive: every selector form is exactly as it was. See STABLE ELEMENT REFS for the anchor and its proof.
//   A ref pins IDENTITY, and that is all it pins: the press is still dispatched at coordinates, so a ref alone
//   does NOT stop a page that reflows mid-click from moving the element out from under the click point. The
//   pre-press recheck is what covers that, on the selector and the ref form alike — see PRE-PRESS RECHECK.
// open-url contract: the reported `status` may be null or stale (raw open-url only hard-fails on a
//   synchronous navigate error, not on HTTP error pages / session-expired 200 logins) — consumers MUST
//   validate status AND content, not trust exit code alone.
// --account: only meaningful for login (names the saved account to pick); rejected on other verbs.
//   Note: run-js output (and get-text/get-html) prints to stdout in plaintext — don't fetch secrets you
//   don't want in the transcript.
//
// MULTIPLAYER tab model (per-session tabs): each session gets its OWN tab so concurrent sessions never
//   clobber one another. The tab is keyed on $BROWSE_SESSION; the session→targetId map persists on disk
//   (BROWSE_SESSION_MAP) because each call is a fresh process. A call with NO BROWSE_SESSION (anon) gets an
//   EPHEMERAL throwaway tab — it can NEVER silently land on, or clobber, another session's tab. --new likewise
//   opens a throwaway tab (NOT registered to the session), closed after the op succeeds.
//
// RAW PER-TARGET CDP IS THE ONLY PATH — there is no Playwright in this tool. Every verb opens
//   a raw websocket straight to the ONE target it needs (ws://<host:port>/devtools/page/<targetId>) and drives
//   only that tab, so a wedged sibling tab is invisible to it. Read/capture verbs: open-url, get-text,
//   get-html, run-js, screenshot, print2pdf, highlight-text, browser-status, list-tabs, close-tabs,
//   dismiss-dialog, restart-browser, native-browser-prompts-view, native-browser-prompts-dismiss (the last two
//   touch no CDP target at all — they read Chromium's own UI over AT-SPI, outside CDP's scope entirely), and
//   login (whose whole property is that the pre-gesture proof holds). Act verbs: enter-text (clear + trusted
//   Input.insertText), press-key for its named control keys (KEY_MAP), click (trusted
//   Input.dispatchMouseEvent at real coordinates), click-and-await-fill (that same trusted click, then poll the
//   target field over the same ws), upload-file (DOM.setFileInputFiles) and download
//   (Browser.setDownloadBehavior + downloadProgress over the browser-level ws this dispatch already holds).
//   WHY IT IS BUILT THIS WAY, and why nobody should reintroduce a Playwright path:
//   chromium.connectOverCDP() attaches to EVERY tab and waits for all of them to initialize, so ONE wedged tab
//   (a forever-loading download/page) freezes ALL commands — act verbs on a heavy multi-iframe page (a
//   checkout with a dozen-plus iframes) can load the machine heavily and hold the global lock for ALL sessions until the
//   entry point's 240s cap.

const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');               // restart-browser's plan/apply token (a hash of the tab set)
const { spawnSync } = require('child_process'); // the PowerShell helper: OS keystrokes and the native-prompt probe

const CDP = process.env.BROWSE_CDP || 'http://localhost:9222';  // override for a test's throwaway browser
const CDP_URL = new URL(CDP);
const CDP_HOSTPORT = CDP_URL.host;                              // host:port — derived, never hardcoded (a test may use another port)
// WINDOWS: the four Linux paths upstream hardcodes (/root/Downloads, /run/browse-sessions.json, /run,
// /run/browse-refs.json) all derive from ONE box root here, so moving the install moves everything with it.
// BROWSE_STATE replaces /run. /run is tmpfs and clears on reboot; this directory does NOT, which is harmless:
// both maps are keyed on CDP target ids, and a stale id simply misses and is re-minted.
const HOME_DIR = process.env.BROWSE_HOME || 'C:\\agent-browser';
const STATE_DIR = process.env.BROWSE_STATE || path.join(HOME_DIR, 'state');
const DOWNLOADS = process.env.BROWSE_DOWNLOADS || path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'Downloads');  // override for tests (their captures must never touch the live dir)
const SESS_MAP = process.env.BROWSE_SESSION_MAP || path.join(STATE_DIR, 'browse-sessions.json');  // {sessionKey: cdpTargetId}
const PRESS_TIMEOUT_MS = Number(process.env.BROWSE_PRESS_TIMEOUT_MS) || 30000;   // raw press-key auto-wait for the selector (matches Playwright's 30s; tests override low)
// CLICK EFFECT: how long a click waits for the page to show ANY change before reporting effect:"unchanged",
// and how long an explicit --expect predicate is polled for. Env-overridable rather than a CLI flag, because
// the numbers are a property of the PAGE's speed, not of the caller's intent (a test can drop EFFECT_MS to
// 100ms to prove the window genuinely misses a slow change).
const EFFECT_MS = Number(process.env.BROWSE_EFFECT_MS) || 400;                   // automatic before/after signal
const EXPECT_MS = Number(process.env.BROWSE_EXPECT_MS) || 5000;                  // --expect default (a server round trip fits)
// …and the cap on ONE effect evaluation. Deliberately NOT EVAL_TIMEOUT_MS (90s): a click that raises a JS
// dialog BLOCKS the renderer, so the very first post-click read would sit there for a minute and a half
// holding the global flock — a click that used to return the instant it dispatched. 2s is far longer than a
// healthy read (single-digit ms) and short enough that a frozen renderer costs one poll, not the wrapper.
const EFFECT_EVAL_MS = 2000;
// How long ONE renderer evaluation may take before we call the renderer unresponsive. Overridable for the
// usual single reason — testability: the wedged-tab reaper (see reapWedgedTab) can only be proven by a page
// that really does pin its renderer, and that fixture must stay SHORT so a failing test can never strand a
// spinning renderer on a shared browser. A test pins for a few seconds and drops this to match.
const EVAL_TIMEOUT_MS = Number(process.env.BROWSE_EVAL_TIMEOUT_MS) || 90000;
const DOWNLOAD_TIMEOUT_MS = 120000;                                              // download TRANSFER cap — deliberately NOT PRESS_TIMEOUT_MS: a big file legitimately takes a couple of minutes
const NO_DOWNLOAD_MS = 15000;                                                    // …and a separate, much shorter cap on a download ever STARTING: a URL that renders/404s never downloads at all

// ---- restart-browser: the moving parts, all env-overridable -----------------------------------------------
// They are overridable for ONE reason: without that this verb cannot be tested. A hermetic test spawns its
// OWN throwaway Chromium and has no systemd unit at all, so it injects a command that kills+respawns that
// browser and reopens its tab set, standing in for Chromium's session restore on a real install.
// WINDOWS: Edge must run in the INTERACTIVE desktop session or it is not the browser a website sees, so it is
// started by a Scheduled Task that runs at logon, and restarting it means ending and re-running that task.
// schtasks /Run launches into the logged-on session even when called over SSH, which is the whole reason the
// task exists rather than a plain Start-Process. The installer creates the task; README.md
// documents it.
const RESTART_TASK = process.env.BROWSE_RESTART_TASK || 'AgentBrowserEdge';
const RESTART_CMD = process.env.BROWSE_RESTART_CMD
  || 'schtasks /End /TN ' + RESTART_TASK + ' >nul 2>&1 & ping -n 3 127.0.0.1 >nul & schtasks /Run /TN ' + RESTART_TASK;
// Where the pre-restart snapshot lands (see restartBrowser step 3): the same dir the session map already lives in.
const RESTORE_DIR = process.env.BROWSE_RESTORE_DIR || STATE_DIR;
const RESTART_CMD_MS = 60000;                                                    // cap on the restart command itself …
const READY_MS = Number(process.env.BROWSE_READY_MS) || 45000;                   // … then on a NEW browser answering, and
                                // again on the tab count coming back. (Overridable so a test can prove the
                                // no-op-restart guard below in seconds instead of 45s.)
const READY_POLL_MS = 3000;     // per-POLL HTTP cap inside those gates: they used to inherit the 60s socket
                                // timeout, so ONE hung poll could eat a whole gate — and the budget with it.
// ONE wall-clock budget for the whole verb, checked before every gate, with each gate's deadline min()'d
// against it. Arithmetic: snapshot <=32s, restart command <=60s (RESTART_CMD_MS), then the gates are all
// bounded by this deadline ⇒ the verb cannot outlive it. 195s sits inside the entry point's 240s hard
// kill with ~45s to spare; without the budget the caps summed to >400s, i.e. the wrapper would SIGKILL node
// mid-gate and the caller would see a bare exit 124 with no snapshot path.
const BUDGET_MS = Number(process.env.BROWSE_RESTART_BUDGET_MS) || 195000;

// TEACH ON TIMEOUT: a hang is the ONE failure whose cause an agent cannot read off the message — a frozen
// renderer (native dialog) and the heavy-tab wedge produce the SAME "timed out". So every timeout that reaches
// a caller carries ONE extra line naming the next move, and dismiss-dialog's probe then tells them WHICH it is.
// A wrapper that kills node on its own time cap should print the same hint.
const TIMEOUT_HINT = 'call timed out — if a tab is frozen by an orphaned native dialog, run: browse dismiss-dialog --probe-only';
const die = (msg, code = 1) => {                                        // synchronous → real abort
  fs.writeSync(2, 'ERR ' + msg + '\n');
  if (/timed out|timeout/i.test(String(msg))) fs.writeSync(2, TIMEOUT_HINT + '\n');
  process.exit(code);
};

// ---- arg parse: flags may appear ANYWHERE; the verb is the first non-flag token ----
//   so `browse --new get-text` and `browse get-text --new` are equivalent (no flag-position footgun).
const rawArgs = process.argv.slice(2);
const flags = { account: null, new: false, out: null, agents: false, stale: false,
                expectUrl: null, probeOnly: false, yes: null,
                echoValue: false, noPreflight: false, rawUrls: false, button: null, list: false, resolve: false,
                username: null, card: null, stayFront: false, ref: null, expect: null, expectMs: null, noEffect: false,
                force: false, wait: null, noWait: false, noRecheck: false, noActivateRetry: false, frame: null,
                target: null, anySession: false };
const pos = [];
const needVal = (name, v) => (v === undefined ? die(name + ' needs a value') : v);
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a === '--') { pos.push(...rawArgs.slice(i + 1)); break; } // end of flags; rest verbatim (flag-like text)
  else if (a === '--account') flags.account = needVal('--account', rawArgs[++i]);
  else if (a === '--new') flags.new = true;
  else if (a === '--agents') flags.agents = true;
  else if (a === '--stale') flags.stale = true;
  else if (a === '--target') flags.target = needVal('--target', rawArgs[++i]);     // close-tabs scope: ONE named tab
  else if (a === '--any-session') flags.anySession = true;                         // ...even if another session owns it
  else if (a === '--out') flags.out = needVal('--out', rawArgs[++i]);
  else if (a === '--expect-url') flags.expectUrl = needVal('--expect-url', rawArgs[++i]);
  // click: DID THE CLICK DO ANYTHING? --expect states what success looks like and is asserted AFTER the click
  // (bounded wait); --expect-ms caps that wait; --no-effect drops even the automatic before/after signal.
  // NOTE the two flags one hyphen apart, deliberately kept distinct: --expect-url guards the tab BEFORE any verb
  // acts (wrong tab ⇒ refuse), --expect asserts a page CHANGE AFTER the click landed. See CLICK EFFECT.
  else if (a === '--expect') flags.expect = needVal('--expect', rawArgs[++i]);
  else if (a === '--expect-ms') flags.expectMs = needVal('--expect-ms', rawArgs[++i]);
  else if (a === '--no-effect') flags.noEffect = true;
  // click: dispatch even when the obscured hit test says something COVERS the target at every probe point.
  // The escape hatch for a decorative layer that forwards the event on — never the default, and the coverer
  // is still named in the output as `centerObscuredBy`. See rawClick.
  else if (a === '--force') flags.force = true;
  // click (and every verb that clicks): press at the coordinates the hit test chose WITHOUT re-validating
  // them in the round trip before the press. The recheck is on by default
  // because without it a page that reflows between the two silently gets the WRONG element clicked and
  // reports success (measured; see PRE-PRESS RECHECK). This is the escape for a page that never holds still
  // and whose click is harmless to aim approximately.
  else if (a === '--no-recheck') flags.noRecheck = true;
  // click / press-key Enter: do NOT activate the tab and try once more when the interaction reports no effect
  // at all. The recovery is on by default because a BACKGROUNDED tab silently swallows interactions on a
  // visibility-gated page and the failure looks exactly like a broken selector (see ACTIVATION RECOVERY).
  // Turn it off for a NON-IDEMPOTENT action: a purely server-side effect reads `unchanged`, so the retry can
  // fire such a click twice. Also the flag for a caller who must not disturb the foreground at all.
  else if (a === '--no-activate-retry') flags.noActivateRetry = true;
  // THE AUTO-WAIT BUDGET, per invocation. The wait itself is not new — the raw act verbs have always polled a
  // late/disabled/zero-size target to PRESS_TIMEOUT_MS (see rawClick / focusWithWait). What was missing is any
  // way to say how long from the command line: the budget was env-only, so a caller who KNOWS a selector is a
  // typo still paid the full 30s, and since every call is serialized behind one lock, that one bad selector
  // blocked EVERY other session on a shared browser for half a minute. --no-wait is the
  // escape from exactly that. On the READ verbs the flag runs the other way: they have never waited and still
  // do not by default (an assert-absent read must stay instant), so --wait is how a caller OPTS IN to polling
  // for a value that has not rendered yet. See WAIT_MS and readWithWait.
  else if (a === '--wait') flags.wait = needVal('--wait', rawArgs[++i]);
  else if (a === '--no-wait') flags.noWait = true;
  // Act/read INSIDE an iframe instead of the top document — the value is a CSS selector for the <iframe>
  // ELEMENT itself, resolved in the top document. See FRAME REACH. Explicit by design: never "find the frame
  // that happens to contain the selector".
  else if (a === '--frame') flags.frame = needVal('--frame', rawArgs[++i]);
  else if (a === '--probe-only') flags.probeOnly = true;                            // dismiss-dialog: diagnose, change nothing
  else if (a === '--button') flags.button = needVal('--button', rawArgs[++i]);      // which button the dismiss verb presses
  // native-browser-prompts-choose: WHICH SAVED ACCOUNT to pick out of Chromium's saved-password chooser. A
  // username, not the row's visible label — the label is Chromium's own phrasing of it ("Password for <u>")
  // and is localized, while the username is the thing a caller actually knows. Deliberately not --account,
  // which belongs to `login`.
  else if (a === '--username') flags.username = needVal('--username', rawArgs[++i]);
  // native-browser-prompts-choose: WHICH SAVED CARD to accept out of the SAME popup. Chromium paints saved
  // passwords and saved payment cards through one widget, so this is the card-shaped sibling of --username
  // rather than a second verb. It takes the LAST FOUR and nothing else, for two reasons: the row's visible
  // label cannot survive a shell round trip (bidi marks and word joiners inside it), and the label carries the
  // card's EXPIRY, which must never be echoed. Last four is the one part of a card that identifies it to a
  // human and is safe to print.
  else if (a === '--card') flags.card = needVal('--card', rawArgs[++i]);
  // enter-text: debugging-only opt-in to restore the landed value in the output. Default output is redacted
  // (see LEAK 1 below) so a live password/passcode typed via enter-text can't land in a transcript by accident.
  else if (a === '--echo-value') flags.echoValue = true;
  // click-and-await-fill: skip the pre-gesture autofill proof and always click, then poll. For the one case the
  // proof gets wrong — a clickSelector that also EXPANDS a collapsed login widget, so skipping the click leaves
  // the submit button hidden. See rawClickAndAwaitFill.
  else if (a === '--no-preflight') flags.noPreflight = true;
  // login: name every enrolled site and nothing else. DISCOVERY IS A LEAK-PREVENTION FEATURE, not a
  // convenience: agents that cannot find out what is available start guessing credential labels at a
  // credential store. A verb whose inventory cannot be listed gets routed around.
  else if (a === '--list') flags.list = true;
  // login-state: let the probe spend ONE trusted click on the password field to settle an UNRESOLVED verdict
  // (Chromium's fill lands 0.5-2s after the gesture). Opt-in because it is the one thing the verb does that is
  // not read-only: it spends the document's user activation, which is exactly what `login`'s gate needs unspent.
  else if (a === '--resolve') flags.resolve = true;
  // browser-status/list-tabs/dismiss-dialog/restart-browser/open-url: opt-in to skip URL redaction (see
  // redactUrl below) for a caller who genuinely needs the full tab URL, query string included.
  else if (a === '--raw-urls') flags.rawUrls = true;
  // screenshot: DON'T hand the foreground back — leave the captured tab in front (see restoreForeground).
  // For a caller that needs the tab to stay in front, e.g. so the browser's own save-password bubble (drawn
  // for the foreground tab) can then be read by native-browser-prompts-view. The default restores, which is
  // what a human watching the screen needs.
  else if (a === '--stay-front') flags.stayFront = true;
  // restart-browser: the destroy-every-tab confirmation, and it takes the PLAN TOKEN the dry run printed —
  // a hash of the exact tab set that was shown. Bare `--yes` is refused (needVal), so nobody can approve a
  // blast radius they never read, and a token that no longer matches is refused too (the tab set moved).
  else if (a === '--yes') {
    flags.yes = needVal('--yes', rawArgs[++i]);
    if (!/^[0-9a-f]{8}$/.test(flags.yes))
      die('--yes takes the plan token printed by the dry run (8 hex chars), got "' + flags.yes + '" — run '
        + '`browse restart-browser` with no --yes first, read the blast radius, then pass the token it prints');
  }
  // click/enter-text/press-key/upload-file/get-text: aim at a STABLE REF from `browse snapshot` instead of a CSS
  // selector, so a page that reflowed between two calls cannot silently hand the verb a different element (see
  // STABLE ELEMENT REFS). Additive: every selector form is unchanged and keeps working.
  else if (a === '--ref') {
    const v = needVal('--ref', rawArgs[++i]);
    if (!/^\d+$/.test(v) || Number(v) < 1)
      die('--ref takes a ref NUMBER from `browse snapshot` (a positive integer), got "' + v + '"');
    flags.ref = Number(v);
  }
  else if (a === '--raw') die('--raw is retired: raw per-target CDP is the ONLY path every verb takes — drop the flag');
  // TOMBSTONE: --legacy is GONE with the Playwright path it selected. Refused by name, because a caller
  // passing it would otherwise get `Cannot find module 'playwright'`, which reads like a broken box rather than a
  // retired flag.
  else if (a === '--legacy') die('--legacy is retired: there is no Playwright path any more (raw per-target '
    + 'CDP is the only path every verb takes). Drop the flag. For a target a CSS '
    + 'selector cannot name, use `browse snapshot` and aim with --ref <n>; to reach inside an iframe, --frame '
    + '<iframe selector>');
  else if (a.startsWith('--')) die('unknown flag: ' + a + ' (pass `--` before a literal --argument)'); // fail loud, never a silent positional
  else pos.push(a);
}
const verb = pos.shift(); // first non-flag token — flag-position-independent

// ---- --wait / --no-wait: the auto-wait budget for THIS call ------------------------------------------------
// Validated here, with the other flags, so a malformed budget costs neither a CDP connect nor a minted
// tab — the same discipline --expect follows. WAIT_MS is the ONE number every waiting call site reads.
// NO SECOND ENV NAME. BROWSE_PRESS_TIMEOUT_MS already owns this budget and the suite sets it in ~20 cases; a
// BROWSE_WAIT_MS meaning the same thing would be two sources of truth for one number, and the pair would drift.
// So the env var stays the DEFAULT and the flags override it for one invocation.
// VERBS THAT WAIT — split by which direction the flag moves them:
//   act  (click/enter-text/press-key/upload-file/click-and-await-fill) already poll; the flags SHORTEN or
//        lengthen a wait that is on by default.
//   read (get-text/get-html/get-values/highlight-text) never poll; --wait turns polling ON, opt-in only.
// Anywhere else the flag would do nothing, and a silently-ignored flag is a lie the caller acts on — so it is
// refused by name, exactly as --expect is on a non-click verb.
const WAIT_ACT = new Set(['click', 'enter-text', 'press-key', 'upload-file', 'click-and-await-fill']);
const WAIT_READ = new Set(['get-text', 'get-html', 'get-values', 'highlight-text']);
// Every verb that reaches rawClick, i.e. dispatches a real mouse press: the four callers of it. This is the
// set --no-recheck applies to. `download` is in it because a SELECTOR-triggered download clicks the link;
// a url-triggered one never touches the page, and the flag is simply inert there rather than wrong.
const CLICKING_VERBS = new Set(['click', 'click-and-await-fill', 'download', 'login']);
// The two verbs that activate the tab and try again when the interaction reports NO effect at all, and so the
// two --no-activate-retry applies to. Full mechanism at ACTIVATION RECOVERY; WHICH VERBS, and why not more:
//   click       — the measured case, and the one verb that already carries an effect signal to trigger on.
//   press-key   — but for ENTER ONLY. Enter in a field was one of the four attempts that silently did nothing
//                 on a sign-in identifier page, and on a <form>-less page it is the whole submit path. The
//                 other control keys are excluded on purpose: a Tab that moves focus, an Escape with no dialog
//                 to close, an arrow key that scrolls — none of them mutate the DOM, so every one of them
//                 would read `unchanged` on a perfectly successful press and activate the tab for nothing.
//   enter-text  — EXCLUDED OUTRIGHT, and this is the interesting one. Input.insertText writing a field's value
//                 creates NO MutationRecord at all (the IDL value setter does not touch the content attribute
//                 — the same fact that makes `--expect value-changes:` necessary), so an effect check here
//                 would read `unchanged` on virtually every SUCCESSFUL call and steal the foreground on each
//                 one. It also needs no recovery: typing goes through the browser's own input pipeline into
//                 the field whether or not the tab is visible, and the verb already proves what landed by
//                 reading the value back. What a hidden tab suppresses is the page's REACTION to the typing,
//                 and that reaction is a click or an Enter away — both of which are covered above.
//   the other rawClick callers (click-and-await-fill, download, login) — each already verifies its own real
//                 outcome (a filled field, a file on disk, a signed-in probe), so a mutation-based no-op
//                 signal would be a weaker second opinion layered on a stronger first one.
const ACTIVATE_RETRY_VERBS = new Set(['click', 'press-key']);
if (flags.wait !== null || flags.noWait) {
  if (flags.wait !== null && flags.noWait)
    die('--wait and --no-wait contradict each other: --no-wait IS --wait 0');
  if (flags.wait !== null && !/^\d+$/.test(String(flags.wait)))
    die('--wait takes milliseconds (a whole number), got "' + flags.wait + '"');
  if (!WAIT_ACT.has(verb) && !WAIT_READ.has(verb))
    die('--wait/--no-wait do not apply to "' + verb + '" — they set how long a verb polls for its TARGET '
      + 'element. Valid: ' + [...WAIT_ACT, ...WAIT_READ].join(', ') + '.'
      + '\n  (For how long a CLICK is watched for an effect afterwards, the flag is --expect-ms.)');
}
// 0 is a real value here (--no-wait = one shot, no retry), so every reader must use ?? and never || — a `||`
// would quietly restore the 30s default at exactly the call the caller asked to be instant.
const WAIT_MS = flags.noWait ? 0 : (flags.wait !== null ? Number(flags.wait) : PRESS_TIMEOUT_MS);
// Is the click point re-validated in the round trip before the press? ON unless --no-recheck. Read as a
// module constant rather than threaded through rawClick's signature, exactly like WAIT_MS above and for the
// same reason: every one of rawClick's callers (click, click-and-await-fill, download, login) would otherwise
// have to pass it through, and a caller that forgot would silently ship the unguarded press. See PRE-PRESS
// RECHECK for what it does and what it deliberately cannot do.
const RECHECK = !flags.noRecheck;

// Which tab does THIS invocation operate on?
//   BROWSE_SESSION set  ⇒ this session's own persistent tab
//   neither (anon)      ⇒ an EPHEMERAL throwaway tab. Safe default: a raw/un-tagged call must NEVER silently
//                          land on a tab someone else is using. Anon = no persistence; set BROWSE_SESSION for
//                          multi-step work.
const envSession = (process.env.BROWSE_SESSION || '').trim();
const anon = !envSession;
const sessionKey = anon ? null : envSession;
const ephemeral = flags.new || anon; // anon callers get a throwaway tab, closed after the op
// A URL download drives a THROWAWAY tab, NEVER the caller's own. Module-level because both the dispatch (which
// target to resolve) and the download case (navigate vs click) read it, and pos[0] is already parsed by here.
const downloadIsUrl = verb === 'download' && /^https?:\/\//.test(pos[0] || '');
// click-and-await-fill's fill window (optional 3rd positional, default 4000ms). Module-level for the same
// reason as downloadIsUrl: the dispatcher validates it BEFORE any tab is minted, and the verb's case then
// reads the one parsed value.
const cafTimeoutMs = (verb === 'click-and-await-fill' && pos[2] != null) ? Number(pos[2]) : 4000;
// login's registry entry, resolved and VALIDATED in the dispatcher before any tab is minted (a bad site name
// must not cost a blank tab on a shared browser) and read again inside runRaw's switch.
let loginSite = null;
// click's --expect predicate + its wait, parsed in the dispatcher for the same reason: a malformed predicate
// must be refused before anything is clicked, never discovered after the page has already been acted on.
let expectPred = null;
let expectWaitMs = EXPECT_MS;

// Opt-in wrong-tab guard: with --expect-url <substr>, die BEFORE acting if the resolved tab's url doesn't
// contain <substr> — a fail-STOP (like the blank-capture guard), not a passive echo that an agent ignores.
const expectOk = (url) => {
  // NOTE: matched against the REAL url (flags.expectUrl must see the actual page) — only the printed die
  // message, below, is redacted; a substring match against a redacted "<redacted>" would never match a real token.
  if (flags.expectUrl && !String(url || '').includes(flags.expectUrl))
    die(verb + ': tab is on "' + (redactUrl(url) || '') + '", expected url to contain "' + flags.expectUrl + '" — refusing to act on the wrong tab');
};

// ---- URL redaction (credential-leak guard) ---------------------------------------------------------------
// Several verbs report tab URLs so a caller can identify/verify a tab (browser-status, list-tabs,
// dismiss-dialog, restart-browser, open-url). A URL's QUERY VALUES can carry a live credential — a signed
// share-link passcode, a pre-authenticated link, a session token — and printing it verbatim puts the secret
// straight into the transcript. Redact every query value by default; keep the PARAMETER NAMES (so a caller
// can still tell what kind of link a tab holds) plus scheme/host/path, so the tab stays identifiable without
// the secret. --raw-urls opts back into the unredacted URL for a caller who genuinely needs it (accepted only
// on the verbs above — see RAW_URL_OK). Params named in the allowlist pass through UNREDACTED — for a
// parameter that is not a credential and keeps a tab identifiable at a glance. Empty by default; kept as one
// named constant so it is trivially editable.
const URL_REDACT_ALLOWLIST = new Set([]);
const RAW_URL_OK = new Set(['browser-status', 'list-tabs', 'dismiss-dialog', 'restart-browser', 'open-url', 'save-page']);
// Verbs that address the BROWSER, not one tab — so every tab-scoped flag (--expect-url) is a
// contract error on them rather than a silently-ignored no-op. One list, so a new browser-wide verb cannot be
// added to some rejection messages and forgotten in others.
const BROWSER_ONLY = new Set(['browser-status', 'list-tabs', 'close-tabs', 'dismiss-dialog', 'restart-browser',
                              'native-browser-prompts-view', 'native-browser-prompts-dismiss']);
// The userinfo strip for the UNPARSEABLE path, where there is no URL object to clear fields on. Text-level and
// deliberately blunt: within the AUTHORITY only — after `://`, up to the first `/`, `?` or `#` — everything
// before the last '@' goes. Stopping at that boundary is what leaves an '@' in a path or query alone (a bare
// email in a path segment is not a credential). It never needs to be reversible; this output is display-only.
// SCHEME-AGNOSTIC ON PURPOSE. An earlier version anchored on a well-formed scheme, and a string with a MALFORMED
// one ("ht tp://user:pass@h/x") therefore sailed through with the password intact — which is precisely backwards,
// since this path only ever runs on input `new URL()` has ALREADY REJECTED, i.e. the input we understand least.
// With no `://` at all the whole leading segment is treated as authority, so a scheme-less "user:pass@host/x" is
// caught too; the cost is over-redacting an odd scheme-less string, which is the direction this function is
// documented to fail in.
const stripUserinfo = (s) => {
  const str = String(s);
  const sep = str.indexOf('://');
  const start = sep >= 0 ? sep + 3 : 0;
  const rest = str.slice(start);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const at = authority.lastIndexOf('@');
  if (at < 0) return str;
  return str.slice(0, start) + '<redacted-credential>@' + authority.slice(at + 1) + (end < 0 ? '' : rest.slice(end));
};
// THE FRAGMENT CARRIES TOKENS TOO, and it used to walk out verbatim on both of redactUrl's return paths. An
// OAuth IMPLICIT flow, several SSO returns and some 3-D-Secure step-ups put the credential AFTER the '#'
// (`#access_token=…`, `#id_token=…`) precisely because a fragment is never sent to a server — which makes it
// safer on the wire and no safer at all in a transcript that is kept and synced. `--frame` is what made
// this reachable where it matters: a payment/OAuth frame's own url is exactly the one being redacted.
// SAME PRINCIPLE AS THE QUERY, not a blanket delete: mask the VALUE of every `k=v` pair and keep the names and
// the structure, so `#/dashboard`, `#section-3` and `#/route?tab=2` — legitimate SPA routes, no secret in them
// — survive intact and the tab stays identifiable. A segment with no '=' is a route, not a value, and is left
// alone. The allowlist is the query's, applied to the key after any '?' so `#/r?<key>=…` still reads.
const redactFragment = (hash) => {
  if (!hash || hash === '#') return hash || '';
  return '#' + hash.slice(1).split('&').map((seg) => {
    const eq = seg.indexOf('=');
    if (eq < 0) return seg;
    const k = seg.slice(0, eq);
    return k + '=' + (URL_REDACT_ALLOWLIST.has(k.slice(k.lastIndexOf('?') + 1)) ? seg.slice(eq + 1) : '<redacted>');
  }).join('&');
};
// --raw-urls is the CALLER's opt-out for what it reads; it is not an opt-out for what we WRITE TO DISK (see
// takeSnapshot), so the redactor proper is reachable on its own.
function redactUrl(url) {
  if (flags.rawUrls || url == null) return url;
  return redactUrlAlways(url);
}
function redactUrlAlways(url) {
  if (url == null) return url;
  const s = String(url);
  let u;
  try { u = new URL(s); }
  catch (_) {
    // FAIL CLOSED, not open. An unparseable string is the moment we know LEAST about it — that is the moment
    // to be MOST conservative, not the moment to assume "no query, safe to print". A real CDP-reported tab url
    // is always parseable (about:blank included), so this path is a defensive backstop, not an expected case —
    // but a backstop that echoes the input verbatim on failure is not a backstop at all. No character after
    // the first '?' or '#' may reach the caller, and the output must look OBVIOUSLY redacted, never like a clean url.
    // The cut is at the first '?' OR '#': an unparseable string is no place to start trusting that a fragment
    // holds a route rather than an access token. The delimiter itself is kept, so the marker still reads as the
    // shape it replaced.
    const q = s.search(/[?#]/);
    return stripUserinfo(q < 0 ? s : s.slice(0, q + 1) + '<redacted-unparseable>');
  }
  // USERINFO — `http://user:pass@host/…` — is a CREDENTIAL IN A URL, and it is stripped BEFORE the query check
  // below, which returns early on a url that has no query string at all. That early return is exactly the shape
  // a basic-auth url has, so without this the whole redactor was a no-op on the one url form that carries a
  // password in plaintext — and `open-url http://user:pass@host/path` is the way to satisfy a basic-auth dialog
  // (nothing can type into that dialog). DEFENSIVE: Chromium strips the credentials from the tab url once the
  // navigation commits, so what CDP reports back is already clean — but that is Chromium's behavior rather than
  // ours, it is one refactor away from being untrue, and an error path that echoes the url AS GIVEN would not be
  // covered by it in the first place.
  // MARKED, not silently cleaned, for the same reason the unparseable branch above is: a url that quietly loses
  // its credential reads as an ordinary url, and "why did this 200 when I expected a 401?" is then unanswerable.
  // The marker is spliced in at the end rather than assigned to u.username, because the URL setters
  // percent-encode '<' and '>' (→ %3Credacted-credential%3E) — the same reason the query parts below are built
  // by hand. Note the query branch was never the leak: it returns u.origin + u.pathname, and origin carries no
  // userinfo. It is the NO-QUERY early return, which is exactly the shape a basic-auth url has.
  let cred = '';
  if (u.username || u.password) { u.username = ''; u.password = ''; cred = '<redacted-credential>@'; }
  const mark = (out) => (cred ? out.replace('://', '://' + cred) : out);
  // The fragment is redacted once, here, and cleared off the URL object so NEITHER return path can hand back
  // the raw one — the no-query early return below is the shape an implicit-flow callback has.
  const frag = redactFragment(u.hash);
  u.hash = '';
  if (![...u.searchParams.keys()].length) return mark(u.toString()) + frag;  // no query string → nothing more to touch
  // Built by hand rather than via searchParams.set()/u.search=: the URL setters percent-encode '<'/'>'
  // (→ ...passcode=%3Credacted%3E...), which is spec-correct but unreadable in a JSON diagnostic. This
  // output is for DISPLAY ONLY — never re-parsed as a URL — so a literal, greppable placeholder wins.
  // Iterating searchParams directly (not its deduped .keys()) also handles a repeated param correctly:
  // each occurrence gets its own redacted/real value instead of collapsing into one.
  const parts = [];
  for (const [k, v] of u.searchParams)
    parts.push(encodeURIComponent(k) + '=' + (URL_REDACT_ALLOWLIST.has(k) ? encodeURIComponent(v) : '<redacted>'));
  return mark(u.origin + u.pathname + '?' + parts.join('&')) + frag;
}

// ---- a never-loaded tab has NO TITLE, and Chromium hands out a url in its place -----------------------------
// A session-restored tab Chromium never loaded reports, as its CDP `title`, a DISPLAY FORM of its own url:
// scheme dropped, a bare trailing slash dropped, and everything else — query string included — verbatim and
// NOT elided (all measured in the lab: "http://h:40079/p/24" → "h:40079/p/24"; "https://h:9/p/1" → "h:9/p/1";
// "http://h:40079/" → "h:40079"; a 200-char query came back in full).
// TWO REASONS THIS MUST NOT BE PRINTED AS A TITLE:
//   1. It is WRONG, and wrong in the dangerous direction. A caller picking a tab by title gets a string that
//      is not the page's title, so it silently fails to match the tab it wanted — or matches a different one.
//      An ABSENT title is honest; a plausible-looking wrong one is not.
//   2. It BYPASSES redactUrl. The url goes through the redactor and comes out with every non-allowlisted
//      query value masked; the same query string then walks out unredacted in the `title` field beside it.
// So: detect the substitution and report title:null + lazy:true. Detection is a string comparison because
// nothing structural distinguishes a lazy target (see ensureRenderer) — deliberately conservative, matching
// only the exact display forms above. The one false positive it can have is a real page whose <title> IS its
// own url, which loses that title; that is the safe direction and the reason the rule is written this way.
// NOT probed, NOT woken: list-tabs is the cheap browser-wide inventory and must stay side-effect-free.
const urlDisplayForms = (u) => {
  const s = String(u == null ? '' : u);
  const bare = s.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return [s, bare, bare.replace(/^www\./, '')];          // www-stripped too: Chromium elides trivial subdomains in some display paths
};
const isUrlPlaceholderTitle = (title, url) => !!title && urlDisplayForms(url).includes(title);
// One tab's {title, lazy} for the inventory verbs. lazy:true is emitted ONLY when the title was suppressed,
// so an ordinary tab's shape is unchanged.
const tabTitle = (t) => (isUrlPlaceholderTitle(t.title, t.url)
  ? { title: null, lazy: true }
  : { title: t.title != null ? t.title : null });

// Every verb that ran inside a frame SAYS SO — in one place rather than at each of the five out() sites, so it
// cannot be forgotten by the next verb that learns --frame. A reader of the transcript must be able to tell a
// click that went into the frame from one that went into the top document, and `oopif` names which of the two
// mechanisms carried it (see FRAME REACH). Set by resolveFrameSurface; null — and every existing output
// byte-for-byte unchanged — on every call without --frame. The value is the caller's OWN selector, never the
// frame's url: a payment/OAuth frame's url can carry a token.
let frameReport = null;
const out = (obj) => {
  let s;
  try { s = JSON.stringify(frameReport ? { ...obj, ...frameReport } : obj); }
  catch (_) { s = JSON.stringify({ result_unserializable: true, preview: String(obj && obj.result).slice(0, 500) }); }
  process.stdout.write(s + '\n');
};
const finish = (code = 0) => process.stdout.write('', () => process.exit(code)); // flush stdout then exit
const streamExit = (buf) => process.stdout.write(buf, () => process.exit(0));    // flush full binary then exit

// ---- session→tab map (on disk; mutated only under the per-invocation lock the wrapper holds) ----
const loadMap = () => { try { return JSON.parse(fs.readFileSync(SESS_MAP, 'utf8')); } catch (_) { return {}; } };
const saveMap = (m) => {                                   // atomic: write temp on same fs, rename over
  const tmp = SESS_MAP + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(tmp, SESS_MAP);
};

// ======================================================================================
// RAW CDP — no Playwright. Talk to ONE target (or the browser endpoint) over a
// single websocket so a wedged SIBLING tab can't freeze us (connectOverCDP attaches to ALL
// tabs and waits for every one to initialize — that was the heavy-tab-wedge root cause).
// ======================================================================================

// Fetch JSON from the CDP HTTP endpoint (e.g. /json/version for the browser ws URL). timeoutMs caps THIS
// fetch: restart-browser's readiness polls pass a short one so a single hung poll can't eat their whole gate.
function cdpHttpJSON(p, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    http.get('http://' + CDP_HOSTPORT + p, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject).setTimeout(timeoutMs, function () { this.destroy(new Error('CDP HTTP timeout')); });
  });
}

// A minimal CDP client over ONE websocket. send(method,params) → Promise(result); matches responses by
// message id, rejects on a CDP-level error; on(event, cb) subscribes to events; close() tears the ws down.
// ALWAYS close() in a finally — one ws per call, no leaks.
class CDPClient {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    // Reject every in-flight send() and clear the map — used when the socket dies under us so a
    // pending call can NEVER hang forever (holding the flock). Each entry carries its own timer.
    const failAll = (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const { reject, timer } of this.pending.values()) { if (timer) clearTimeout(timer); try { reject(e); } catch (_) {} }
      this.pending.clear();
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id); this.pending.delete(m.id);
        if (timer) clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const cb of this.handlers.get(m.method)) { try { cb(m.params); } catch (_) {} }
      }
    });
    // a closed/errored socket must reject all pending sends (else they hang); the 'error' listener
    // also swallows the event so an otherwise-unhandled 'error' can't abort the process.
    ws.on('close', () => failAll(new Error('CDP socket closed')));
    ws.on('error', (e) => failAll(e instanceof Error ? e : new Error(String(e))));
  }
  // timeoutMs caps THIS call. Callers working to a wall-clock budget (rawEnterText) pass their remaining time so
  // a blocked renderer can't stack several 90s waits and hold the global flock far longer than the old path did.
  send(method, params = {}, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP ' + method + ' timed out')); }
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }
  on(event, cb) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(cb); }
  close() { try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {} }
}

// Open a raw ws to a URL and wrap it in a CDPClient (rejects on connect refusal/timeout — funnels to die()).
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 60000, maxPayload: 256 * 1024 * 1024 });
    const onErr = (e) => { try { ws.terminate(); } catch (_) {} reject(e); };
    ws.once('open', () => { ws.removeListener('error', onErr); resolve(new CDPClient(ws)); });
    ws.once('error', onErr);
  });
}
// Connect straight to ONE page target — the flat form, constructed deterministically (NO /json scan for it).
const connectTarget = (targetId) => cdpConnect('ws://' + CDP_HOSTPORT + '/devtools/page/' + targetId);
// Connect to the browser-level endpoint (Target.* domain). ws URL = webSocketDebuggerUrl from /json/version.
async function connectBrowser() {
  const v = await cdpHttpJSON('/json/version');
  if (!v || !v.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl from CDP ' + CDP);
  return cdpConnect(v.webSocketDebuggerUrl);
}

// All live page-type targets, via the browser ws (browser-routed metadata — never touches a renderer, so a
// wedged tab still shows up). Returns [{targetId,url,title,...}].
async function listPageTargets(browser) {
  const { targetInfos } = await browser.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page');
}

// ---- FOREGROUND RESTORE ------------------------------------------------------------------------------------
// Four paths in this file Target.activateTarget a tab of their own (the lazy-tab wake, dismiss-dialog's X
// press, SingleFile's save-selected-tabs shortcut, and the screenshot capture). Every one of them is
// load-bearing and stays. But the browser may be one a HUMAN watches while agent sessions act on it, so each
// of those activations takes their screen away and leaves it taken. These two helpers turn that into a
// sub-second flicker: note who was in front, do the work, put them back.
//
// THE SIGNAL: the FIRST page entry of the CDP HTTP endpoint /json/list. Chromium orders that list
// most-recently-USED, so entry 0 is the foreground tab. Measured headful under Xvfb:
//   * it tracked four consecutive CDP activations, 4/4 — and Target.getTargets, whose order is creation
//     order, got 1/4 on the same runs, which is the negative control proving the ordering is a real signal
//     and not an artifact of the tabs happening to be listed in the order we activated them.
//   * it tracked four REAL ctrl+Tab switches driven at the X layer, which is the case that actually matters:
//     a human switching tabs never goes through CDP at all, and a signal that only saw our own activations
//     would restore them to a tab they had already left.
//   * agreement with the ground truth (per-page document.visibilityState==='visible' && document.hasFocus(),
//     itself verified to flip under the same negative control) was exact on every settled reading.
// TWO OTHER SIGNALS WERE MEASURED AND REJECTED:
//   Target.getTargets carries NO visibility field at all — the TargetInfo keys are targetId, type, title,
//     url, attached, canAccessOpener, browserContextId, and nothing there answers "is this one in front".
//   The per-page visibilityState/hasFocus sweep IS ground truth, but it needs a renderer in every tab and one
//     websocket per tab: hundreds of ms across a few dozen tabs at a 250ms cap versus roughly a millisecond for one HTTP GET,
//     and — worse — it returns NOTHING when the foreground tab is wedged or was never loaded, which is
//     precisely when a human is most likely to be looking at it. /json/list answers those from the browser
//     process, so it is both cheaper and correct on more of the range.
// FAIL SAFE, ALWAYS. Both helpers swallow every error and return null: doing nothing restores exactly
// the no-restore behavior, and a restore is a convenience that must never be able to fail a verb that worked.
const frontmostTargetId = async () => {
  try {
    const list = await cdpHttpJSON('/json/list', 2000);
    const p = (Array.isArray(list) ? list : []).find((t) => t && t.type === 'page');
    return p ? p.id || null : null;
  } catch (_) { return null; }
};

// Put `prev` back in front after we stole the foreground. Skipped — deliberately, not as a failure — when
// there was no reading to restore, when the human was already looking at OUR tab (restoring would be a second
// pointless flicker), or when that tab has since been closed (activating a dead targetId is an error, and
// picking some other tab instead would be inventing a foreground nobody asked for).
// WHEN to call this is per-site and is NOT interchangeable: it must come after the activation has finished
// doing whatever it was for — the wake's readiness poll, the keystroke, the file write — because on three of
// the four paths the activation is not a preliminary, it IS the mechanism.
async function restoreForeground(browser, prev, ours) {
  if (!prev || prev === ours) return null;
  try {
    const list = await cdpHttpJSON('/json/list', 2000);
    if (!(Array.isArray(list) ? list : []).some((t) => t && t.type === 'page' && t.id === prev)) return null;
    await browser.send('Target.activateTarget', { targetId: prev }, 5000);
    return prev;
  } catch (_) { return null; }
}

// Resolve THIS session's targetId (creating the tab if absent), with sessionPage()-parity GC:
//   - ONE Target.getTargets for liveness; prune dead map entries.
//   - forceNew (ephemeral) ⇒ a throwaway tab (about:blank), temp:true, NOT registered to the session.
//   - else resolve session's targetId from the map IF still live; create via Target.createTarget when absent
//     and persist. Connect straight to it (skip page-iteration) but confirm liveness first.
// Returns { targetId, temp, created }.  temp tabs MUST be Target.closeTarget'd by the caller in a finally.
//   created=true means a non-ephemeral session's mapped tab was GONE and we minted a fresh about:blank —
//   the dispatch BLOCKS read/capture verbs on that (a vanished tab must NOT yield a blank PDF).
async function resolveTarget(browser, forceNew, key) {
  if (forceNew) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    return { targetId, temp: true, created: false, url: 'about:blank' };
  }
  const targets = await listPageTargets(browser);
  const live = new Set(targets.map((t) => t.targetId));
  const map = loadMap();
  let changed = false;
  for (const k of Object.keys(map)) if (!live.has(map[k])) { delete map[k]; changed = true; } // GC dead tabs
  if (map[key] && live.has(map[key])) {
    if (changed) { try { saveMap(map); } catch (_) {} }
    const t = targets.find((x) => x.targetId === map[key]);
    return { targetId: map[key], temp: false, created: false, url: t ? t.url : null };
  }
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  map[key] = targetId; changed = true;
  if (changed) { try { saveMap(map); } catch (_) {} }
  return { targetId, temp: false, created: true, url: 'about:blank' };
}

// Evaluate `code` in a target (raw Runtime.evaluate). Shared by run-js/get-text/get-html/highlight-text.
//   - "last expression is the value" semantics preserved: expression:code yields the completion value (like eval).
//   - awaitPromise:true so a returned Promise resolves.
//   - page throw (exceptionDetails) is FAIL-STOP → die(verb+': '+desc): exit 1, empty stdout.
//   - non-serializable values (DOM node, function — CDP's returnByValue can't round-trip these; it would
//     return a misleading {}) ⇒ emit out()'s {result_unserializable, preview} from the by-handle RemoteObject.
// CRITICAL: the source `code` is evaluated EXACTLY ONCE (returnByValue:false → a result HANDLE). A
// side-effecting run-js (a click, a keystroke) must NOT run twice. We then serialize the existing
// RESULT HANDLE via callFunctionOn — never by re-evaluating the source string. Primitives/null/undefined
// come back inline on the probe; only real object/array handles need the (read-only) serialize step.
// Returns { value } on success, or { unserializable: true, payload } when the value can't be serialized.
async function evalInTarget(tcdp, code, timeoutMs) {
  timeoutMs = timeoutMs || EVAL_TIMEOUT_MS;
  await tcdp.send('Runtime.enable', {}, timeoutMs).catch(() => {});
  // THE ONE AND ONLY run of `code`. returnByValue:false so side-effecting code runs once and we keep a handle.
  const probe = await tcdp.send('Runtime.evaluate', { expression: code, returnByValue: false, awaitPromise: true }, timeoutMs);
  if (probe.exceptionDetails) throw new Error(exceptionMessage(probe.exceptionDetails));
  const ro = probe.result || {};
  const preview = () => ({ unserializable: true, payload: { result_unserializable: true,
    preview: String(ro.description || ro.className || ro.subtype || ro.type || '').slice(0, 500) } });
  if (ro.type === 'undefined') return { value: undefined };
  // primitives + null arrive inline on the handle (value present); no serialize step, no re-eval.
  if (Object.prototype.hasOwnProperty.call(ro, 'value')) return { value: ro.value };
  // a DOM/other node or a function can't deep-serialize to JSON → preview from the handle metadata.
  if (ro.subtype === 'node' || ro.type === 'function') return preview();
  if (!ro.objectId) return preview(); // no handle to serialize (shouldn't happen) → degrade to preview
  // object/array handle: serialize the EXISTING handle (read-only, no source re-run). Any failure
  // (circular, throws, returns no value) degrades to the preview shape — never throws past die.
  let ser;
  try { ser = await tcdp.send('Runtime.callFunctionOn',
    { objectId: ro.objectId, functionDeclaration: 'function(){return this}', returnByValue: true }); }
  catch (_) { return preview(); }
  if (!ser || ser.exceptionDetails || !ser.result ||
      !Object.prototype.hasOwnProperty.call(ser.result, 'value')) return preview();
  return { value: ser.result.value };
}
// Human-readable message from a CDP exceptionDetails (mirrors a thrown-error message).
function exceptionMessage(ed) {
  if (ed.exception) return ed.exception.description || ed.exception.value || ed.text || 'uncaught exception';
  return ed.text || 'uncaught exception';
}

// ---- native-dialog probe + dismiss (the dismiss-dialog verb) ---------------------------------------------
// A native JS dialog ("Leave site? Changes you made may not be saved", alert, confirm) BLOCKS its tab's
// renderer, so Runtime.evaluate on that target never answers — that silence IS the probe, and it is the only
// thing that tells a frozen tab apart from the heavy-tab wedge (both surface as "timed out").
// A dialog belongs to the CDP CLIENT that triggered it: when that client hangs or is killed the dialog is
// ORPHANED — still on screen, but every new connection is told "No dialog is showing" and
// Page.handleJavaScriptDialog is powerless. Only a real keystroke at the X layer clears an orphan.
const PROBE_MS = Number(process.env.BROWSE_PROBE_MS) || 5000;  // renderer silent this long ⇒ frozen (tests override low)
// WINDOWS: there is no X display. Edge runs on the interactive desktop, and the OS-keystroke layer below
// reaches it through the same PowerShell helper that reads native prompts (see OS_HELPER).
const XDISPLAY = 'desktop';                                   // kept as a label only, so log lines still read sensibly

// Is this target's renderer answering? Its OWN ws, always closed, so probes run in PARALLEL and one frozen tab
// can't delay the healthy ones. Deliberately NO Runtime.enable first (an enable can itself hang on a jammed
// renderer, and a bare evaluate needs none). Returns {frozen, title} or {frozen, error}.
async function probeTarget(targetId) {
  let tcdp;
  try { tcdp = await connectTarget(targetId); }
  catch (e) { return { frozen: false, error: 'cannot attach (' + (e.message || e) + ')' }; } // no ws ≠ a dialog
  try {
    const r = await tcdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, PROBE_MS);
    return { frozen: false, title: (r.result && r.result.value) || '' };
  } catch (e) {
    const msg = String(e.message || e);
    return { frozen: /timed out/i.test(msg), error: msg }; // only SILENCE means frozen; a dead socket doesn't
  } finally { tcdp.close(); }
}

// ---- LAZY (never-loaded) TABS: wake one on demand ----------------------------------------------------------
// WHAT A LAZY TAB IS. Chromium's session restore brings every tab back as a TARGET but loads only some of
// them: its TabLoader gives up partway (measured in a lab restore — most of the restored tabs left unloaded
// indefinitely, stable past t+60s), and the rest sit there with NO RENDERER PROCESS AT ALL. The CDP target
// exists, /json/list shows it, a per-target websocket connects fine — and then every renderer-served call
// sent down it is QUEUED, not refused. That is the whole bug: the call is not lost and not rejected, it waits
// for a renderer that is never going to start. get-text/get-html/run-js/click/enter-text hung forever;
// open-url hung 90s inside rawGoto's very first `Page.enable`; screenshot activated the tab and then failed
// "Cannot take screenshot with 0 width" because it captured before the fresh renderer had laid anything out.
//
// DETECTION — MEASURED, not guessed, because the obvious candidates do not work:
//   Target.getTargetInfo  every STRUCTURAL field is identical for a lazy and an awake tab (attached:false
//                         either way, no lifecycle/discarded field on this Chromium). The one field that
//                         differs is `title`, and only because Chromium substitutes a url for the title a
//                         never-loaded tab does not have.
//   SystemInfo.getProcessInfo  lists renderer pids but carries NO target→pid mapping, so it cannot answer the
//                         question "does THIS target have a renderer" at all.
//   a renderer-served call  never answers on a lazy tab — decisive, but ALSO never answers on a WEDGED one,
//                         so silence alone cannot tell the two apart (see ensureRenderer step 1).
// Hence TWO signals in a fixed order: the browser-side title (free, unblockable, and the only thing that
// separates never-loaded from jammed), then — only for a target that looks never-loaded — a bounded
// Page.getFrameTree, the CHEAPEST renderer-served call measured (3.7ms awake vs 7.1ms for Runtime.evaluate),
// needing no Page.enable/Runtime.enable, running no page JS and mutating nothing.
//
// WAKING. Target.activateTarget is the wake: handled in the BROWSER process, so it works on a target with no
// renderer at all (the same property the screenshot path already relies on). Measured on genuinely lazy
// tabs: the call returns in ~65ms, the renderer answers at ~210-240ms, a non-zero layout viewport appears
// ~5ms later, and the first screenshot succeeds at ~375ms.
// TWO OTHER WAKES WERE MEASURED AND REJECTED:
//   Page.setWebLifecycleState{state:'active'} returns {} in 3.7ms and does NOTHING — still no renderer at 20s.
//   Page.navigate to the tab's own url DOES wake it, faster (renderer 144ms) and WITHOUT stealing the
//     foreground — strictly better on that axis, and genuinely tempting for read verbs. Rejected anyway: it
//     is a NAVIGATION on a shared browser, and a tab a human left open can hold state a reload throws away. A
//     wrong activate costs a foreground change; a wrong navigate costs somebody's work. This file fails safe,
//     so: activate.
//
// BOUNDED, ALWAYS. A browser-level title read, then (only for a target that looks never-loaded) one probe
// capped at LAZY_PROBE_MS, then ONE wall-clock deadline (LAZY_WAKE_MS) covering the activate and every
// readiness poll. On expiry it THROWS a named error — never a hang, never a silent
// empty result — and marks it `noRenderer` so the wedged-tab reaper leaves the tab alone: the reaper closes
// tabs whose renderer stopped answering, and a tab that never HAD a renderer is not that (before this, a
// get-text on a lazy tab hung for minutes and then CLOSED the tab).
const LAZY_PROBE_MS = Number(process.env.BROWSE_LAZY_PROBE_MS) || 2000;  // renderer silent this long ⇒ suspect no renderer
const LAZY_WAKE_MS = Number(process.env.BROWSE_LAZY_WAKE_MS) || 20000;   // whole-wake budget once we do suspect it

// Is the page usable yet? Renderer answering AND laid out AND past 'loading'. The viewport half is what makes
// the screenshot's FIRST call succeed instead of its second; the readyState half is what stops a woken tab
// from handing get-text an empty body it would report as the page's content.
async function pageUsable(tcdp, capMs) {
  const cap = Math.max(1, Math.min(capMs, 1500));
  await tcdp.send('Page.getFrameTree', {}, cap);                       // renderer exists and is answering
  const m = await tcdp.send('Page.getLayoutMetrics', {}, cap);
  const vp = m.cssLayoutViewport || m.layoutViewport || {};
  if (!(vp.clientWidth > 0 && vp.clientHeight > 0)) return false;      // laid out (screenshot needs a surface)
  const rs = await tcdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, cap);
  return rs.result && rs.result.value !== 'loading';                   // DOM parsed → a read returns real content
}

// Returns { woke:false } for any target this must not touch — one that has rendered (the ordinary path, and
// the WEDGED case, both settled by the title read alone) or one that looks never-loaded but answers — or
// { woke:true, ms, activate } after waking a genuinely rendererless tab. Throws (e.noRenderer = true) if a
// tab that looks never-loaded, and is silent, still does not wake inside the budget.
async function ensureRenderer(browser, tcdp, targetId) {
  // STEP 1 — THE TITLE, and it comes FIRST for two reasons.
  // (a) SILENCE IS AMBIGUOUS. A WEDGED renderer — one spinning inside the page's own JS — is exactly as silent
  //     as a target with no renderer at all, so "the probe timed out" cannot mean lazy on its own. The first
  //     version of this got that wrong, and testing caught it: the wedged-renderer cases went green→red
  //     because the wedge was activated, waited out, and reported as a SUCCESS on a call that must fail — and
  //     on a wedge that never finishes it would have failed as noRenderer, which SUPPRESSES the reaper that
  //     exists because a wedged renderer can grow to many GB and pin the whole box. Disarming that guard is
  //     the worst outcome available here.
  // (b) ORDER MATTERS TO EVERY OTHER VERB. Probing first would put a renderer-served call, and its timeout, in
  //     front of every ordinary verb — which both slows the wedged path and (measured) shifts the timing the
  //     reaper's own regression test depends on. Asking the BROWSER first costs one browser-process round trip
  //     that no renderer can block, and a normal tab never reaches the probe at all.
  // The signal: a tab that has ever rendered keeps its REAL title in the browser-side target info, even after
  // its renderer jams; a tab that never loaded carries the url placeholder Chromium substitutes (see
  // isUrlPlaceholderTitle). Same rule dismiss-dialog uses — one place to be wrong. Pointed the safe way:
  // anything that does not look never-loaded is left entirely alone, on the pre-existing path (its own
  // timeout, then the reaper), so a misread costs a hang we already had and never a disarmed guard.
  let info = null;
  try { info = (await browser.send('Target.getTargetInfo', { targetId }, 10000)).targetInfo; } catch (_) {}
  if (!info || !isUrlPlaceholderTitle(info.title, info.url)) return { woke: false };
  // STEP 2 — PROVE IT. The title is a hint; only the renderer's own silence is evidence. Capped at the verb's
  // eval timeout when that is shorter (detecting must never cost more than failing would). A tab that looks
  // never-loaded but answers is a real page whose title happens to equal its url — it is left untouched, at
  // the price of this one probe.
  try {
    await tcdp.send('Page.getFrameTree', {}, Math.min(LAZY_PROBE_MS, EVAL_TIMEOUT_MS));
    return { woke: false };
  } catch (e) {
    // ONLY silence means "no renderer". A dead socket, a protocol error, a closed target — anything that came
    // back with an answer — is the caller's problem to report, not something to activate a tab over.
    if (!/timed out/i.test(String(e.message || e))) throw e;
  }
  const t0 = Date.now();
  const deadline = t0 + LAZY_WAKE_MS;
  let activateErr = null;
  // Whose screen we are about to take. Read BEFORE the activate, restored only once the poll below has
  // settled — see the restore note on the exits, and restoreForeground for how "frontmost" is decided.
  const prevFront = await frontmostTargetId();
  try { await browser.send('Target.activateTarget', { targetId }, Math.max(1000, Math.min(10000, deadline - Date.now()))); }
  catch (e) { activateErr = String(e.message || e); }   // not fatal on its own — the poll below is the verdict
  // RESTORING EARLY WOULD BE A BUG HERE, and this is the one path where that is true: on the other three the
  // activation is a preliminary, but here it IS the wake — the whole reason this function activates is that
  // Target.activateTarget is what makes Chromium start a renderer for a session-restored tab it never loaded.
  // So the restore happens only after the readiness poll has succeeded (or given up), never between.
  // MEASURED, because "backgrounding it again might just undo the wake" is the obvious worry and it is worth
  // more than a guess (a real session-restore cycle producing genuinely rendererless tabs): woken in
  // 68ms, foreground handed straight back to the previous tab, and 1.5s later the new renderer was still
  // answering and still captured a valid PNG — the same outcome on every property checked as the control run
  // that did no restore at all. Chromium does not discard a renderer for losing the foreground, so putting
  // the human back costs the woken tab nothing.
  const wakeDone = async () => { await restoreForeground(browser, prevFront, targetId); };
  for (;;) {
    // Deadline FIRST, every lap: a poll is only started while budget remains, so the loop cannot talk itself
    // into one more attempt past the bound.
    const left = deadline - Date.now();
    if (left > 0) {
      // withTimeout, not just the per-send cap: CDPClient.send() floors its timeout at 1000ms, so on the last
      // lap a poll could outlive the budget it was issued under. The race makes the deadline the real bound.
      try {
        if (await withTimeout(pageUsable(tcdp, left), left, 'wake poll')) {
          await wakeDone();                             // page is usable — the activate has served its purpose
          return { woke: true, ms: Date.now() - t0, activate: activateErr };
        }
      }
      catch (_) {}                                      // still silent / still laying out → keep waiting
    }
    if (Date.now() >= deadline) {
      // Restored on the failure path too, and for a stronger reason than on the success path: the tab did not
      // wake, so the foreground was taken for nothing at all. Leaving a human parked on a tab that is still
      // blank is the worst version of the theft this whole mechanism exists to undo.
      await wakeDone();
      const e = new Error('target had no renderer and did not wake within ' + LAZY_WAKE_MS + 'ms'
        + (activateErr ? ' (Target.activateTarget failed: ' + activateErr + ')' : ' (activated, still silent)')
        + ' — a session-restored tab Chromium never loaded, which then refused to start a renderer when '
        + 'activated. Bring it up by hand with `browse open-url ' + redactUrl(info.url) + '`, or look at the '
        + 'browser on this machine\'s own screen. The tab was left OPEN.');
      e.noRenderer = true;                              // the wedged-tab reaper must NOT close this tab
      throw e;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
}

// Clear the dialog over CDP. Works only while it is still owned by a LIVE session; an orphan answers
// "No dialog is showing". Every send is short-capped: on a jammed renderer Page.enable can hang, and this
// step must never eat the budget the X fallback needs.
async function cdpAcceptDialog(targetId) {
  let tcdp;
  try { tcdp = await connectTarget(targetId); } catch (e) { return { ok: false, error: String(e.message || e) }; }
  try {
    await tcdp.send('Page.enable', {}, PROBE_MS).catch(() => {}); // best effort — not fatal, see above
    await tcdp.send('Page.handleJavaScriptDialog', { accept: true }, PROBE_MS);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { tcdp.close(); }
}

// Press the focused default button (Leave/OK) at the X layer — below the browser, where nothing can intercept,
// and the ONLY thing that clears an ORPHANED dialog. The caller MUST Target.activateTarget the frozen tab
// first: that raises the window holding it and makes it the ACTIVE X window, which is how a tab maps to a
// window at all (CDP exposes no such mapping).
//
// OWNERSHIP PROOF. The OS tells you which window is in front; it does not tell you which BROWSER owns it, so
// "bring the one visible window up and press Return" sends the keystroke into whatever happens to be there.
// Without the proof, a test aimed at a throwaway browser on another port can press Return into a live browser's
// foreground tab; on a desktop a person also uses, the window in front can be any application.
// So the press happens ONLY when the foreground window's owning process is one of the processes whose command
// line carries THIS invocation's --remote-debugging-port=. A headless or test browser has no window at all, so
// the check simply fails and nothing is pressed.
// Returns {pressed,…} on a real press, {skipped:<why>} when the proof fails; throws only on a helper fault,
// so the caller can record the reason per tab and still report the rest.
// Takes the keyspec so save-page can reuse the ownership proof for SingleFile's ctrl+shift+y — that proof is
// the whole value here, and a second copy of it would be a second place to get it wrong.
//
// `targeted` DELIVERS THE KEY TO THE PROVEN WINDOW ITSELF (a posted message addressed to that window handle)
// instead of to whatever is in front, and it also skips raising the window — so there is no focus change and
// NO CHECK-TO-PRESS GAP at all: even if something else takes focus in the microsecond after the proof, the key
// still goes to the window we proved. On a machine with a person at it that gap is the risk that matters, and
// this closes it.
// OPT-IN RATHER THAN THE DEFAULT, deliberately, and the reason is the same one upstream gives: a posted key is
// a synthetic message, which applications are free to ignore, and many do as a security measure. The browser's
// print preview accepts it. The other two callers are not that — dismiss-dialog's Return answers a JS dialog,
// and save-page's ctrl+shift+y must fire an EXTENSION COMMAND, which needs a real OS-level keystroke. Neither
// has been measured against a synthetic one here, so neither is switched over on a guess.
// WINDOWS: upstream shells out to xdotool here and proves ownership with pgrep. Neither exists on Windows, so
// BOTH the ownership proof and the keystroke live in the PowerShell helper (OS_HELPER, `press` mode), which
// reproduces the contract above exactly: it finds the browser processes whose command line carries this
// invocation's --remote-debugging-port=, reads the FOREGROUND window's owning pid, refuses to type unless the
// two agree, and only then sends the key. The refusal is the whole point and it is kept verbatim in spirit: a
// mis-aimed keystroke lands in whatever application the person at the keyboard is using.
// Returns the SAME shapes as upstream — {pressed,…} or {skipped:<why>} — so every caller is untouched.
function xPressKey(key, { targeted = false } = {}) {
  const port = CDP_URL.port || '9222';
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OS_HELPER,
     '-Mode', 'press', '-Port', String(port), '-Key', key, ...(targeted ? ['-Targeted'] : [])],
    { encoding: 'utf8', timeout: 10000 });
  if (r.error) throw r.error;                                    // helper missing (ENOENT) / killed on timeout
  const out = String(r.stdout || '').trim();
  if (r.status !== 0 && !out) throw new Error('OS keystroke helper → ' + String(r.stderr || 'exit ' + r.status).trim());
  let j; try { j = JSON.parse(out); }
  catch (_) { throw new Error('OS keystroke helper printed unparseable output: ' + out.slice(0, 200)); }
  if (j.skipped) return { skipped: j.skipped };
  return { pressed: key, display: XDISPLAY, window: j.window, windowName: j.windowName, ...(targeted ? { targeted: true } : {}) };
}
const xPressReturn = () => xPressKey('Return');

// ---- SingleFile page capture (the save-page verb) -----------------------------------------------------------
// Saves the tab as ONE self-contained .html with CSS/images/fonts inlined — the fidelity "save page complete"
// that screenshot (pixels, unsearchable) and print2pdf (paginated, layout re-flowed) do not give you. Used
// where the caller wants to keep a capture of the page itself, which may change or vanish later.
//
// WHY AN X11 KEYSTROKE AND NOT AN INJECTED LIBRARY. SingleFile here is the REAL unpacked extension
// (id mpiodijhokgodhhofbcjdecpffjipkle). Its background service worker fetches sub-resources CORS-exempt, so a
// page whose layout CSS lives on a cross-origin CDN saves STYLED. Driving the in-page engine
// (lib/single-file.js via CDP) instead puts the fetcher INSIDE the page, where same-origin policy blocks
// reading and re-fetching those stylesheets — it saves flat and UNSTYLED, silently, with exit 0. And a CDP
// synthetic key does not fire an extension command, so the real extension can only be reached with a real
// OS-level keystroke. Hence the PowerShell helper, and hence the ownership proof in xPressKey: a mis-aimed
// ctrl+shift+y is a keystroke into whatever application happens to be focused.
//
// WHY THE FILE IS FOUND BY DIFFING THE DIRECTORY. The shortcut is save-SELECTED-tabs: the extension picks the
// tab, names the file itself ("<title> (M_D_YYYY h_mm_ss AM).html", ':' → full-width '：'), and writes it
// through Chromium's own download path. Nothing reports the name back over CDP, so the only way to learn it is
// to snapshot the download dir before the press and look for what appeared. Two consequences the caller
// inherits: the save is browser-WIDE (whatever tab is selected gets saved, so the tab is activated first and
// the entry point's lock must hold for the whole save), and the capture is SLOW — 15-30s typical, longer on a heavy
// page — which is why this verb sits near the entry point's 240s cap rather than the usual sub-second budget.
const SAVEPAGE_MS    = Number(process.env.BROWSE_SAVEPAGE_MS || 150000);  // whole poll, well under the entry point's 240s kill
const SAVEPAGE_SETTLE_MS = Number(process.env.BROWSE_SAVEPAGE_SETTLE_MS || 2000); // a beat for the page to settle
const SAVEPAGE_STABLE_MS = 1500;                                          // size unchanged this long ⇒ write finished
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const htmlInDownloads = () => {
  try { return new Set(fs.readdirSync(DOWNLOADS).filter((f) => /\.html$/i.test(f))); } catch (_) { return new Set(); }
};

// Press the shortcut, then wait for the file. Returns the absolute path of the NEW .html.
// Both failure modes are loud by design: no new file at all (extension never fired / not loaded) throws, and
// so does a press that could not be proven to land in this browser — a silent "capture" that produced nothing
// is exactly the outcome a caller would keep without noticing.
async function singleFileCapture(browser, targetId) {
  const before = htmlInDownloads();
  // Bring the tab to the front IN THE BROWSER first: the shortcut saves the SELECTED tab, so this is what
  // decides which page gets captured. Target.activateTarget (not Page.bringToFront) is handled in the browser
  // process, so a busy renderer cannot block it — the same property the screenshot path relies on.
  // The foreground is given back in the finally at the bottom, and NOWHERE EARLIER. This is the longest-held
  // theft of the four (15-30s typical) and so the most tempting to cut short, but the selected tab is not
  // just what the keystroke aims at — it is what the extension reads FROM while it streams the file out.
  // Selecting another tab mid-save would change the subject of a capture that is already in flight, and the
  // failure would be silent: a well-formed .html of the WRONG PAGE, kept as the caller's capture. So the restore waits
  // for the write to finish, and on the throw paths it runs anyway (the foreground was still taken).
  const prevFront = await frontmostTargetId();
  try {
    try { await browser.send('Target.activateTarget', { targetId }, 10000); } catch (_) {}
    await sleep(300);
    const press = xPressKey('ctrl+shift+y');   // SingleFile's built-in default (manifest command save-selected-tabs)
    if (press.skipped) throw new Error('SingleFile keystroke not sent — ' + press.skipped);

    const deadline = Date.now() + SAVEPAGE_MS;
    let file = null;
    while (Date.now() < deadline) {
      await sleep(500);
      const fresh = [...htmlInDownloads()].filter((f) => !before.has(f));
      if (fresh.length) {                       // newest, in case a concurrent save also landed
        file = fresh.map((f) => path.join(DOWNLOADS, f))
                    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
        break;
      }
    }
    if (!file)
      throw new Error('SingleFile wrote no .html to ' + DOWNLOADS + ' within ' + Math.round(SAVEPAGE_MS / 1000)
        + 's — the extension may not be loaded in this browser, or the keystroke did not reach it. Pressed: '
        + JSON.stringify(press));

    // The extension streams the file out; a size read mid-write would report a truncated capture as a good one.
    let last = -1, since = Date.now();
    while (Date.now() < deadline) {
      let size = 0; try { size = fs.statSync(file).size; } catch (_) {}
      if (size > 0 && size === last) { if (Date.now() - since >= SAVEPAGE_STABLE_MS) break; }
      else { last = size; since = Date.now(); }
      await sleep(400);
    }
    return file;
  } finally {
    await restoreForeground(browser, prevFront, targetId);
  }
}

// ---- native BROWSER-CHROME prompts, via UI Automation (the native-browser-prompts-view / -dismiss verbs) -
// A different animal from the native JS dialog above: a permission bubble ("… wants to: Download multiple
// files"), the saved-password chooser ("Sign in to <site>"), an infobar or the download bubble is painted in
// BROWSER UI, so it does NOT freeze the renderer — every CDP call keeps answering and the verb returns exit 0
// with plausible JSON while the thing the page was trying to do is silently blocked. CDP has no event or
// query for these, page JS cannot see them, and enumerating top-level windows cannot either (the browser
// paints its whole UI inside ONE window). On Windows, UI Automation is the only structured reader that exists
// — hence the shell-out to browse-drive-native-browser-prompts.ps1, which carries the same two traps
// upstream's AT-SPI probe carries (a machine-wide tree ⇒ filter by process; every prompt exposed at more than
// one path ⇒ dedupe) and their reasoning.
// __dirname, so the deploy's STAGED copy is what the gate tests. OVERRIDABLE FOR ONE REASON — testability,
// exactly like BROWSE_CDP / BROWSE_RESTART_CMD: a throwaway headless browser has NO a11y
// tree, so the real probe can only ever answer "cannot see" there and a test could not exercise a single
// prompt-shaped answer. That gap is not theoretical — a caller reading `r.json.prompts` when this probe
// returns a BARE ARRAY passes every hermetic case while the live browser has a credential dialog on screen and
// the verb reports none. A stub a test can point at is what makes that class of bug fail in the gate
// instead of in production.
// WINDOWS: one PowerShell helper serves both the native-prompt probe (UI Automation, replacing AT-SPI, which
// does not exist on Windows) and the OS keystroke above. They share it because they share the hard part — the
// proof that the window being read or typed into really belongs to THIS invocation's browser.
const OS_HELPER = process.env.BROWSE_OS_HELPER || path.join(__dirname, 'browse-drive-native-browser-prompts.ps1');
const ATSPI_PROBE = OS_HELPER;   // upstream's name, kept so the code below and its reasoning read unchanged
const ATSPI_MS = 15000;                                       // cap on one probe/press — a11y calls are 24-207ms measured
// How long to wait for a pressed prompt to actually GO AWAY. Env-overridable in the same spirit as PROBE_MS.
const PROMPT_VERIFY_MS = Number(process.env.BROWSE_PROMPT_VERIFY_MS) || 4000;

// Run browse-drive-native-browser-prompts.py against THIS invocation's browser (the CDP port picks the process — see the probe).
// Never throws: every failure comes back as {code, err} so each verb decides whether it is fatal
// (native-browser-prompts-dismiss: always — you cannot press what you cannot see) or a reported condition
// (native-browser-prompts-view).
// Probe exit codes: 0 ok · 2 no such button · 3 no a11y tree for that browser · 4 usage/environment.
function atspiProbe(extra = []) {
  const port = CDP_URL.port || '9222';
  // WINDOWS: upstream's probe takes GNU-style long flags; PowerShell takes named parameters. The mapping
  // lives HERE, at the single boundary, so every call site above stays byte-identical to upstream's.
  const PS_FLAG = { '--press': '-Press', '--press-entry': '-PressEntry', '--press-entry-card': '-PressEntryCard' };
  const ps = [];
  for (let i = 0; i < extra.length; i++) {
    const f = PS_FLAG[extra[i]];
    if (!f) return { code: 4, err: 'internal: no PowerShell parameter for probe flag ' + extra[i] };
    ps.push(f, String(extra[++i]));
  }
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ATSPI_PROBE, '-Mode', 'prompts', '-Port', port, ...ps],
    { encoding: 'utf8', timeout: ATSPI_MS });
  if (r.error) return { code: 4, err: 'cannot run ' + ATSPI_PROBE + ' (' + (r.error.message || r.error) + ')' };
  const err = String(r.stderr || '').trim();
  if (r.status !== 0) return { code: r.status == null ? 4 : r.status, err: err || 'browse-native-browser-prompts exited ' + r.status };
  try { return { code: 0, json: JSON.parse(String(r.stdout || '')) }; }
  catch (_) { return { code: 4, err: 'browse-native-browser-prompts printed unparseable output: ' + String(r.stdout || '').slice(0, 200) }; }
}

// Raw-CDP key press: auto-wait for the target element, focus it, then dispatch a REAL keyDown/keyUp
// for a NAMED control key over the wedge-immune per-target ws. It emits the SAME key events as Playwright
// page.press(sel,key) for these keys. press-key handles the control keys in KEY_MAP and ONLY those — a single
// character or a modifier chord (Shift+Enter) is refused by name in the dispatcher, so this function only ever
// sees a control key. Residual difference vs Playwright: presence+focus auto-wait only, no
// visibility/enabled/stability checks — fine for its use (committing a field you just typed into, which is
// already visible + enabled).
const KEY_MAP = { // key name → { CDP code, virtual-key code, optional text for text-producing keys }
  Enter:      { code: 'Enter',      vk: 13, text: '\r' },
  Tab:        { code: 'Tab',        vk: 9 },
  Escape:     { code: 'Escape',     vk: 27 },
  Backspace:  { code: 'Backspace',  vk: 8 },
  Delete:     { code: 'Delete',     vk: 46 },
  ArrowLeft:  { code: 'ArrowLeft',  vk: 37 },
  ArrowUp:    { code: 'ArrowUp',    vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown:  { code: 'ArrowDown',  vk: 40 },
  Home:       { code: 'Home',       vk: 36 },
  End:        { code: 'End',        vk: 35 },
  PageUp:     { code: 'PageUp',     vk: 33 },
  PageDown:   { code: 'PageDown',   vk: 34 },
  Space:      { code: 'Space',      vk: 32, text: ' ' },
};
// Poll for the selector to be present and focusable — Playwright page.press's auto-wait, so raw press-key isn't
// more brittle than the old default on a slow/dynamic page (a search box that re-renders as you type, an AJAX
// field that mounts late/disabled). Bounded by PRESS_TIMEOUT_MS; each poll's eval runs its source once, and
// focus() is a harmless no-op until the element is actually focusable, so it "lands" exactly once.
// Returns { ok:true } once the element is present AND focus actually LANDS on it, else { ok:false, state } on
// timeout. Requiring document.activeElement===el is the actionability check: focus() is a NO-OP on a hidden or
// disabled element, so without this the key would dispatch to whatever WAS focused (a silent mis-fire on the
// wrong target). 'absent' = not in the DOM yet; 'unfocusable' = present but hidden/disabled/not focusable.
// Shared element resolver injected into every act-verb eval. Plain document.querySelector would silently
// NARROW what the act verbs can reach: this (a) pierces OPEN shadow roots — common on web-component checkouts
// — and (b) retargets a <label> to the control it labels. SELECTORS ARE CSS ONLY. A text=/xpath/>> selector
// (Playwright's own engine syntax, which nothing here speaks) throws a DOMException; we name it so the caller
// aims a different way rather than reading it as a broken page. What to reach for instead: `browse snapshot`
// prints every interactable element with its visible label and a stable `ref`, and `--ref <n>` aims at the
// element's IDENTITY, which is what a text= selector was reaching for. For an element inside an iframe, name
// the frame with `--frame <iframe selector>` — cross-origin included.
const RESOLVE_JS = `function __bq(sel){
  function dq(root){
    var el;
    try { el = root.querySelector(sel); }
    catch(e){ throw new Error('invalid selector (CSS only — text=/xpath/>> are not supported; to target by identity run \`browse snapshot\` and pass --ref <n>): '+sel); }
    if (el) return el;
    var all = root.querySelectorAll('*');
    for (var i=0;i<all.length;i++){ var sr = all[i].shadowRoot; if (sr){ var f = dq(sr); if (f) return f; } }
    return null;
  }
  var el = dq(document);
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  return el;
}`;

// Every raw act verb aims at a TARGET, which is either a CSS selector (the original and still-default form) or
// a stable ref pinned into the page by resolveRef (see STABLE ELEMENT REFS below). These two helpers are the
// whole of the difference: elJS() is the expression that yields the element, targetName() the label that goes
// into every error message. A plain string is accepted everywhere a target is, so all the existing call sites
// — and every existing caller of the verbs — are untouched.
const asTarget = (t) => (typeof t === 'string' ? { sel: t } : t);
const elJS = (t) => (t.ref
  // Two properties, both load-bearing. (1) The pin is re-checked on EVERY read, not just at resolve time: a
  // page can detach the node between the actionability poll and the dispatch, and a null here lands in the
  // same 'absent' branch a vanished selector does, so the verb fails loud rather than dispatching at a stale
  // box. (2) A <label> retargets to the control it labels, exactly as __bq does — the ref path must not be a
  // second set of semantics for the same verbs, or `enter-text` would type into a selector's control and fail
  // on the identical element named by a ref.
  ? '(function(){var e=window[' + JSON.stringify(REF_PIN) + ']; if(!e||!e.isConnected) return null;'
    + ' if(e.tagName==="LABEL"&&e.control) e=e.control; return e;})()'
  : '__bq(' + JSON.stringify(t.sel) + ')');
const targetName = (t) => (t.ref ? t.label || ('ref ' + t.ref) : t.sel);

// ---- STABLE ELEMENT REFS: the `snapshot` verb and `--ref <n>` ----------------------------------------------
// THE PROBLEM. Every act verb above resolves a CSS SELECTOR at the moment it runs, so a multi-step flow
// re-resolves it on each call — and between two calls the page reflows. A selector that named the right button
// in step 1 can name a DIFFERENT element in step 2 (a row inserted above it, a list re-ordered, a banner
// mounting), and nothing in the selector path can tell the two apart: it finds AN element, clicks it, exits 0.
// A ref is an identity, not a query: it names the node itself, so it either hits the SAME element or fails.
//
// THE ANCHOR IS CDP's backendNodeId, and it was measured rather than assumed (throwaway Chromium):
//   · a node MOVED to a different parent, with a new sibling inserted before it, still resolves through its
//     backendNodeId to the SAME element — over a SECOND, FRESH CDP connection, which is the shape that matters
//     here because every `browse` call is its own process with its own websocket. Nothing survives per-session
//     state, so an anchor that lived in a CDP session would be useless the moment the process exited.
//   · the same reflow moves `:nth-of-type(2)` (and index 1 of a querySelectorAll) onto a DIFFERENT element.
//     That is the negative control: refs are not "another way to click", they are the way to NOT click the
//     wrong thing.
//   · DOM.describeNode works with no prior DOM.enable/DOM.getDocument, so a snapshot costs no extra domain.
// WHY NOT A Runtime REMOTE OBJECT ID: it also survived a fresh connection in the measurement, so that is not
// the discriminator — the cost is. A remote object RETAINS its node, so a 100-element snapshot would pin 100
// nodes (detached ones included) inside a shared browser whose tabs can stay open a long time, and it carries no
// signal a backendNodeId does not.
// FAILING LOUD IS THE WHOLE POINT, and it needs THREE checks, because the failures look nothing alike:
//   · node REMOVED, or re-rendered by a framework into a fresh node with the same id/markup → DOM.resolveNode
//     SUCCEEDS and hands back the old, detached node (measured, and still so after a forced GC). Only
//     `isConnected` tells you, so the resolve below refuses on it. Without that check a ref would quietly act
//     on a node that is no longer in the page — a worse silent-wrong-target than the selector it replaces.
//   · page NAVIGATED → usually DOM.resolveNode throws "Node with given id does not belong to the document"…
//   · …BUT NOT ALWAYS, AND THIS IS THE DANGEROUS ONE. Found by a live smoke test, NOT by
//     the fixture: after clicking a link on example.com through to iana.org, the dead document's backendNodeId
//     RESOLVED — to a different node in the new document (it reached getBoundingClientRect on something that
//     had none, so it was not even an element). backendNodeIds are freed when their document is destroyed and
//     the numbers come back round; the hermetic fixture never showed it because its ids had not wrapped yet.
//     A recycled id landing on an ELEMENT is precisely the silent wrong-target this feature exists to prevent,
//     so identity is NOT left to the id alone: each snapshot stamps the DOCUMENT with a random token, records
//     it beside the refs, and a ref is refused unless the live main-frame document still carries that exact
//     token — plus the resolved node must be an Element, in THIS document, with the tagName it was recorded
//     with. A navigation destroys the token with the document, so a whole generation dies at once, by name.
// REFS ARE MONOTONIC PER SESSION, never restarting at 1. Each snapshot allocates the NEXT block of numbers
// (gen 1 → 1..12, gen 2 → 13..25) and only the latest snapshot's numbers are live, so a ref copied out of an
// earlier snapshot's output is ABSENT from the map and dies by name — it can never silently mean whatever
// element now happens to hold that number. That is the same failure the whole feature exists to prevent, so
// the numbering is chosen to make it impossible rather than to be caught by a check.
const REF_MAP = process.env.BROWSE_REF_MAP || path.join(STATE_DIR, 'browse-refs.json');   // {key: {gen,next,targetId,url,ts,refs}}
const REF_MAX = Number(process.env.BROWSE_REF_MAX) || 200;              // per-snapshot element cap (tests lower it)
const REF_TTL_MS = 24 * 3600 * 1000;                                    // prune entries older than this on write
const REF_PIN = '__browseRefEl';        // where a resolved ref is pinned in the page, for the length of ONE call
const REF_TMP = '__browseSnapNodes';    // the snapshot's element array; deleted again before the verb returns
// The DOCUMENT STAMP. It stays on the page between calls BY DESIGN — it is the only thing that can tell "the
// document these refs were taken from" from "a document that inherited their id numbers", and a navigation
// must be able to destroy it. One string property on window, overwritten by the next snapshot.
const REF_TOK = '__browseSnapToken';
const loadRefs = () => { try { return JSON.parse(fs.readFileSync(REF_MAP, 'utf8')); } catch (_) { return {}; } };
const saveRefs = (m) => {                                  // atomic + self-pruning, like saveMap
  const cut = Date.now() - REF_TTL_MS;
  for (const [k, v] of Object.entries(m)) if (!v || !(Date.parse(v.ts) >= cut)) delete m[k];
  const tmp = REF_MAP + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(tmp, REF_MAP);
};
// Which tab's refs are these? A ref is only ever valid on the tab it was taken on (enforced against the stored
// targetId), and the KEY is what lets a second call find the map again: this session's key.
// An anon/--new caller has no key BY DESIGN — its tab is closed at the end of the call, so a ref into it could
// only ever be dead. That is refused at the argument boundary rather than stored and later mourned.
const refKey = () => sessionKey;

// The in-page collector. Interactables + anything carrying an explicit role, shadow roots included (the same
// reach the act verbs have through __bq). It stashes the ELEMENTS in window[REF_TMP] so the caller can convert
// each one to a backendNodeId, and returns only metadata.
// NO FIELD VALUE EVER CROSSES THIS BOUNDARY. The label falls back through aria-label / associated <label> /
// placeholder / alt / title / innerText and STOPS — deliberately not el.value, which the older __label helper
// does include: on a login form that would print the saved username, and on a mis-typed field the password.
// `filled` (a boolean, never a length) is the whole of what a snapshot says about a field's contents, matching
// the line get-values and click-and-await-fill settled on.
const SNAPSHOT_JS = `function __snap(scopeSel, MAX, tok){
  var SEL = 'a[href],button,input,select,textarea,summary,label,[role],[onclick],[contenteditable=""],[contenteditable="true"],[tabindex]';
  var root = document;
  if (scopeSel) { var r = document.querySelector(scopeSel); if (!r) return {noScope:true}; root = r; }
  var seen = [], out = [];
  (function walk(node, depth){
    if (depth > 8) return;
    var all;
    try { all = node.querySelectorAll(SEL); } catch(e){ return; }
    for (var i=0;i<all.length;i++) if (seen.indexOf(all[i])<0) seen.push(all[i]);
    var every = node.querySelectorAll('*');
    for (var j=0;j<every.length;j++) if (every[j].shadowRoot) walk(every[j].shadowRoot, depth+1);
  })(root, 0);
  function vis(el){
    var b = el.getBoundingClientRect();
    if (!b.width || !b.height) return false;
    var cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function role(el){
    var explicit = el.getAttribute('role'); if (explicit) return explicit;
    var tag = el.tagName.toLowerCase(), ty = String(el.type||'').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || (tag==='input' && (ty==='submit'||ty==='button'||ty==='reset'||ty==='image'))) return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'disclosure';
    if (tag === 'label') return 'label';
    if (tag === 'input') {
      if (ty==='checkbox') return 'checkbox';
      if (ty==='radio') return 'radio';
      if (ty==='file') return 'file';
      if (ty==='password') return 'password';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }
  function labelOf(el){
    var t = el.getAttribute('aria-label');
    if (!t && el.labels && el.labels.length) t = el.labels[0].textContent;
    if (!t) t = el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title');
    if (!t) t = el.innerText || el.textContent || '';
    return String(t).trim().replace(/\\s+/g,' ').slice(0,80);        // NEVER el.value — see the comment above
  }
  function selOf(el){
    var tag = el.tagName.toLowerCase(), cands = [];
    var uniq = function(c){ try { return document.querySelectorAll(c).length===1 && document.querySelector(c)===el; } catch(e){ return false; } };
    var q = function(v){ return '"' + String(v).replace(/["\\\\]/g,'\\\\$&') + '"'; };
    if (el.id) cands.push('#'+CSS.escape(el.id));
    if (el.getAttribute('name')) cands.push(tag+'[name='+q(el.getAttribute('name'))+']');
    if (el.getAttribute('aria-label')) cands.push(tag+'[aria-label='+q(el.getAttribute('aria-label'))+']');
    if (el.getAttribute('data-testid')) cands.push('[data-testid='+q(el.getAttribute('data-testid'))+']');
    for (var i=0;i<cands.length;i++) if (uniq(cands[i])) return cands[i];
    // positional fallback: a short nth-of-type path. Reported precisely BECAUSE it is the fragile kind — it is
    // what a caller would otherwise have hand-written, and the ref beside it is the stable alternative.
    var parts = [], n = el, hops = 0;
    while (n && n.nodeType === 1 && hops++ < 5) {
      var t = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#'+CSS.escape(n.id)); break; }
      var k = 1, s = n;
      while ((s = s.previousElementSibling)) if (s.tagName === n.tagName) k++;
      parts.unshift(t + ':nth-of-type(' + k + ')');
      n = n.parentElement;
    }
    var p = parts.join(' > ');
    return uniq(p) ? p : null;                       // null = not addressable by a document-level CSS selector
  }                                                  //        (a shadow-root element, typically) — the ref is the ONLY handle
  var nodes = [], items = [], truncated = false;
  for (var k=0;k<seen.length;k++){
    var el = seen[k];
    if (!vis(el)) continue;
    if (nodes.length >= MAX) { truncated = true; break; }
    var it = { i: nodes.length, tag: el.tagName.toLowerCase(), role: role(el), name: labelOf(el), selector: selOf(el) };
    var ty = String(el.type||'').toLowerCase();
    if (ty) it.type = ty;
    if (el.disabled) it.disabled = true;
    if (typeof el.value === 'string' && el.tagName !== 'BUTTON') it.filled = el.value.length > 0;   // boolean only, never the value or its length
    if (el.checked === true) it.checked = true;
    nodes.push(el); items.push(it);
  }
  window[${JSON.stringify(REF_TMP)}] = nodes;
  window[${JSON.stringify(REF_TOK)}] = tok;      // the document stamp — see REF_TOK; a navigation takes it with the document
  return { url: location.href, title: document.title, truncated: truncated, items: items };
}`;

// Take a snapshot: run the collector, turn each collected element into a backendNodeId, and write the numbered
// map to disk. The element→backendNodeId conversion is ONE Runtime.getProperties over the stashed array (so a
// single round trip yields every handle) plus a DOM.describeNode per handle fired in PARALLEL — a per-element
// serial round trip made a 100-element page cost a visible pause while holding the global flock.
async function takeSnapshot(tcdp, targetId, key, scopeSel) {
  const tok = crypto.randomBytes(8).toString('hex');
  const ev = await evalInTarget(tcdp, `(function(){${SNAPSHOT_JS}
    return __snap(${JSON.stringify(scopeSel || null)}, ${REF_MAX}, ${JSON.stringify(tok)});})()`);
  const v = ev.value || {};
  if (v.noScope) throw new Error('scope selector matched nothing: ' + scopeSel);   // runRaw's catch adds the 'snapshot: ' prefix
  // The stashed array, as a handle we can enumerate. releaseObject at the end so the page is left holding
  // nothing of ours — the same reason the pin is deleted after a ref act verb.
  const arr = await tcdp.send('Runtime.evaluate', { expression: 'window[' + JSON.stringify(REF_TMP) + ']', returnByValue: false });
  const arrId = arr.result && arr.result.objectId;
  const refs = {};
  let entry = null;
  try {
    if (!arrId) throw new Error('the page did not return an element array (it may have navigated mid-snapshot)');
    const props = await tcdp.send('Runtime.getProperties', { objectId: arrId, ownProperties: true });
    const byIndex = new Map();
    for (const p of props.result || []) {
      if (!/^\d+$/.test(p.name) || !p.value || !p.value.objectId) continue;
      byIndex.set(Number(p.name), p.value.objectId);
    }
    const ids = await Promise.all(v.items.map(async (it) => {
      const oid = byIndex.get(it.i);
      if (!oid) return null;
      try { const d = await tcdp.send('DOM.describeNode', { objectId: oid }); return d.node.backendNodeId; }
      catch (_) { return null; }
    }));
    const all = loadRefs();
    const prev = all[key] || { gen: 0, next: 1 };
    let n = prev.next;
    const listed = [];
    v.items.forEach((it, idx) => {
      if (ids[idx] == null) return;               // a node that vanished between the walk and the describe
      const ref = n++;
      refs[ref] = { b: ids[idx], r: it.role, n: it.name, s: it.selector, g: it.tag };   // g = tagName witness, checked on resolve
      listed.push({ ref, role: it.role, tag: it.tag, ...(it.type ? { type: it.type } : {}), name: it.name,
                    selector: it.selector, ...(it.disabled ? { disabled: true } : {}),
                    ...(it.filled !== undefined ? { filled: it.filled } : {}),
                    ...(it.checked ? { checked: true } : {}) });
    });
    // THE URL A SNAPSHOT REPORTS AND STORES, and the two rules it obeys:
    //   · A FRAME'S URL IS NEVER EMITTED AT ALL — not printed, not written to the refs file. That is
    //     the same rule frameReport keeps (it carries the caller's own selector, never the frame's url),
    //     applied here because a snapshot is the one --frame verb that had a url to hand: an OAuth or 3-D-Secure
    //     frame's own url is exactly where a token lives. `frame:` below already records WHICH document the
    //     refs belong to, so nothing needs the url to do its job.
    //   · THE TOP DOCUMENT'S URL IS STORED REDACTED. It used to be stored RAW while the printed copy was
    //     redacted — a redactor that only cleans stdout leaves the secret in the refs file for the
    //     entry's whole 24h life, on a box every session shares. It goes through the redactor PROPER rather
    //     than redactUrl because --raw-urls is the caller's opt-out for what it READS BACK, never a license to
    //     write somebody's passcode into a file that outlives the call; `snapshot` is not in RAW_URL_OK today,
    //     so the two cannot currently disagree, and this does not rest on that staying true. The only reader
    //     (resolveRef's "the page navigated" message) re-redacts on display, so it costs that message nothing.
    entry = { gen: prev.gen + 1, next: n, targetId, tok, ts: new Date().toISOString(),
              ...(flags.frame ? { frame: flags.frame } : { url: redactUrlAlways(v.url) }), refs };
    all[key] = entry;
    saveRefs(all);
    return { gen: entry.gen, ...(flags.frame ? {} : { url: redactUrl(v.url) }), title: v.title, count: listed.length,
             ...(v.truncated ? { truncated: true, cap: REF_MAX } : {}), elements: listed };
  } finally {
    if (arrId) { try { await tcdp.send('Runtime.releaseObject', { objectId: arrId }); } catch (_) {} }
    try { await evalInTarget(tcdp, 'delete window[' + JSON.stringify(REF_TMP) + ']; true'); } catch (_) {}
  }
}

// Resolve `--ref <n>` to a live element and PIN it into the page for the length of this call, or die loudly.
// Everything downstream then aims at window[REF_PIN] instead of a selector — the same trusted-event dispatch,
// the same actionability polling, a different way of naming the target. Returns the target descriptor the raw
// act verbs take.
// Pinned rather than passed as an objectId because every raw verb already speaks Runtime.evaluate against the
// main frame; a global the eval can read is a one-line change at each site, where threading an objectId through
// would mean re-resolving it inside every poll iteration of rawClick's convergence loop.
async function resolveRef(tcdp, targetId, key, n) {
  const all = loadRefs();
  const st = all[key];
  if (!st) die('--ref ' + n + ': no snapshot for this tab — run `browse snapshot` first, then use the refs it prints');
  if (st.targetId !== targetId)
    die('--ref ' + n + ': that snapshot was taken on a DIFFERENT tab (the tab was replaced since) — re-run `browse snapshot`');
  // A ref names a node in ONE document. The tab check above cannot tell the top document from a frame inside
  // it, and the two carry INDEPENDENT backendNodeId number lines — so spending a frame's ref against the top
  // document is the same recycled-id wrong-target the document stamp exists to refuse, just by another route.
  // Refused as a pair, in both directions.
  if ((st.frame || null) !== (flags.frame || null))
    die('--ref ' + n + ': that snapshot was taken ' + (st.frame ? 'INSIDE the frame --frame ' + st.frame : 'on the TOP document')
      + ', but this call is aimed at ' + (flags.frame ? 'the frame --frame ' + flags.frame : 'the top document')
      + '. A ref belongs to the document it was taken in — repeat the same --frame (or drop it), or re-run '
      + '`browse snapshot` for the document you mean');
  const e = st.refs[String(n)];
  if (!e) {
    const live = Object.keys(st.refs).map(Number).sort((a, b) => a - b);
    die('--ref ' + n + ' is not in the current snapshot (generation ' + st.gen + ' covers '
      + (live.length ? live[0] + '-' + live[live.length - 1] : 'nothing') + '). Refs from an EARLIER snapshot are '
      + 'retired on purpose — they are never re-used, so this cannot have silently meant a different element. '
      + 'Re-run `browse snapshot` and use the numbers it prints');
  }
  const what = 'ref ' + n + ' (' + e.r + ' "' + e.n + '")';
  const stale = ' Re-run `browse snapshot` and use the numbers it prints.';
  // (1) THE DOCUMENT STAMP, checked FIRST and before any node is touched. A backendNodeId is only unique
  // within the life of its document: once the document is destroyed the numbers are freed and REISSUED, so on
  // a page that has navigated the id can resolve to an unrelated node in the new document (measured live, see
  // REF_TOK). The stamp is the only thing that distinguishes "the document these refs describe" from
  // "a document that inherited their numbers", so nothing else here is trustworthy until it matches.
  const t = await evalInTarget(tcdp, 'window[' + JSON.stringify(REF_TOK) + '] || null');
  if (t.value !== st.tok)
    die('--ref ' + n + ': the snapshotted DOCUMENT is gone — this tab has navigated since (it was on '
      + (redactUrl(st.url) || 'another url') + '), so every ref from generation ' + st.gen + ' is dead. They are '
      + 'refused as a GROUP rather than resolved one by one, because a destroyed document\'s node ids get '
      + 'reissued to the new page and would otherwise point at unrelated nodes.' + stale);
  let resolved;
  try { resolved = await tcdp.send('DOM.resolveNode', { backendNodeId: e.b }); }
  catch (err) { die(what + ' no longer exists: ' + (err.message || err) + '.' + stale); }
  const oid = resolved.object && resolved.object.objectId;
  if (!oid) die(what + ' could not be resolved to a live node.' + stale);
  // (2) Pin it, then (3) prove from the MAIN FRAME that what got pinned is an Element, still in the document,
  // in THIS document, and still the tag it was recorded as. Two failures need this, not one: a REMOVED or
  // re-rendered node still resolves and hands back a detached node (measured, and still so after a forced GC),
  // and a resolve into a bfcached document would set the pin on that document's window, where the main frame
  // cannot see it — which reads here as "gone" rather than as a click on an invisible page.
  await tcdp.send('Runtime.callFunctionOn', { objectId: oid, returnByValue: true,
    functionDeclaration: 'function(){ window[' + JSON.stringify(REF_PIN) + '] = this; }' });
  try { await tcdp.send('Runtime.releaseObject', { objectId: oid }); } catch (_) {}
  const chk = await evalInTarget(tcdp, '(function(){var e=window[' + JSON.stringify(REF_PIN) + '];'
    + ' if(!e) return "gone"; if(e.nodeType!==1) return "notElement"; if(e.ownerDocument!==document) return "otherDoc";'
    + ' if(!e.isConnected) return "detached"; return String(e.tagName||"").toLowerCase();})()');
  const state = chk.value;
  if (state === 'detached' || state === 'gone' || state === 'otherDoc')
    die(what + ' is no longer in the document — the element was removed, or the page re-rendered it into a new '
      + 'node (same markup, different node). NOTHING was done to the page.' + stale);
  if (state === 'notElement' || (e.g && state !== e.g))
    die(what + ' resolved to the WRONG NODE — it was a <' + (e.g || '?') + '> when the snapshot was taken and the '
      + 'id now names ' + (state === 'notElement' ? 'something that is not an element' : 'a <' + state + '>')
      + '. NOTHING was done to the page: acting on it is exactly the wrong-target this verb exists to refuse.' + stale);
  return { ref: n, label: what, sel: e.s };
}
// Best-effort un-pin: leave nothing of ours in a page other sessions and a human share.
const unpinRef = async (tcdp) => { try { await evalInTarget(tcdp, 'delete window[' + JSON.stringify(REF_PIN) + ']; true', 5000); } catch (_) {} };

// ---- FRAME REACH: `--frame <iframe selector>` ---------------------------------------------------------------
// THE GAP. Every act verb resolves its selector with __bq against ONE document — the top one. An <iframe> is a
// different document whatever its origin, so a control inside one is simply unreachable without this (and
// Playwright's plain page.click() is main-frame only too). That puts the payment field, the OAuth form and the
// captcha challenge — the three things most worth driving — outside the toolset.
//
// "CROSS-ORIGIN IFRAME" IS TWO DIFFERENT THINGS, and this is the fact the whole design turns on. Chromium
// isolates by SITE (scheme + eTLD+1), not by origin. Measured against a hermetic fixture
// (--host-resolver-rules=MAP *.test 127.0.0.1, so the site boundary is real and no external network is touched):
//   IN-PROCESS  — same-origin, and cross-origin-but-SAME-site (sub.a.test in a.test; a different PORT counts as
//     same-site too). NOT a separate CDP target, and it IS listed in Page.getFrameTree. Reached with
//     Page.createIsolatedWorld({frameId}) on the page session we already hold → an executionContextId →
//     Runtime.evaluate{contextId}. NOTHING is attached to. Chromium REUSES an isolated world by worldName
//     (three calls returned the same contextId), so repeated calls on a long-lived tab cannot accumulate worlds.
//   OOPIF       — cross-SITE (b.test in a.test). A separate renderer AND a separate type:"iframe" target, and
//     it is NOT listed in Page.getFrameTree at all (measured: the top session reports an empty child list), so
//     it can only be found through Target.getTargets. Reached over a plain ws to /devtools/page/<targetId> —
//     the SAME per-target shape every raw verb already uses. No Target.attachToTarget, no flatten, no sessionId.
// WHY THAT IS NOT THE connectOverCDP WEDGE. connectOverCDP attaches to EVERY target and waits for each to
// initialize, so one heavy tab froze all sessions. This attaches to exactly ONE more target — the one the
// caller named. Measured with the frame ws open: every other target still reads attached:false, an unrelated
// tab answered in 1ms, and a FRESH ws to that unrelated tab connected and evaluated in 4ms. The extra hop costs
// 3ms to connect and 1ms for the first eval, and the ws is closed in a finally (a leaked frame session on this
// shared box IS the wedge risk realized).
//
// THE DISPATCH SINK DIFFERS BY CASE, and this was the surprise. Input.dispatchMouseEvent on the TOP session at
// correctly translated coordinates LANDS in an in-process frame but does NOT land in an OOPIF — measured with
// the top's own elementFromPoint returning the IFRAME at that exact point and the in-frame hit test true, and
// the frame's DOM never changed. An OOPIF must be dispatched to through its OWN session in FRAME-LOCAL
// coordinates, which does land. Keystrokes (insertText / dispatchKeyEvent) follow focus and work either way, so
// they go to whichever session owns the frame.
//
// THE GUARD THE IN-FRAME HIT TEST CANNOT PROVIDE. rawClick's nine-point elementFromPoint check runs INSIDE the
// frame once the surface is swapped in, so it sees in-frame overlays. It is blind to the TOP document: a modal
// covering the whole page leaves the in-frame test perfectly happy. So every mouse dispatch is preceded by ONE
// eval on the top session that re-reads the owner <iframe>'s content-box origin AND hit-tests the exact
// translated point — read FRESH at dispatch time, never snapshotted, because the offset is what makes the
// coordinates right. Measured: with a full-viewport modal, that test correctly refused for all three frame
// kinds while the in-frame test still said "clear". --force skips it, exactly as it does for rawClick.
const FRAME_WORLD = 'browse';                 // isolated-world name; reused by name, so at most one per frame
const FRAME_VERBS = ['click', 'enter-text', 'press-key', 'get-text', 'snapshot', 'native-browser-prompts-choose'];
// get-html is deliberately NOT in that list. A cross-origin frame is where card numbers and passcodes are
// typed, and serialized HTML carries whatever a page has written into a value attribute — get-text gives a
// caller what they need to verify a step without that risk.

// Bind `sel` (a CSS selector for an <iframe> in the TOP document) to exactly one frame of THIS tab, and return
// a stand-in for tcdp that the act verbs can be handed unchanged.
// The binding is by NODE IDENTITY, not by url or name: resolve the element, take its backendNodeId, then ask
// DOM.getFrameOwner for every candidate frame until one names the same node. getFrameOwner is also the
// OWNERSHIP test — measured, it refuses with "Frame with the given id was not found" both for a frame belonging
// to another tab and for a foreign iframe target (Chromium's own new-tab-page frame), so a Target.getTargets
// list that spans the whole browser can never select somebody else's frame.
async function resolveFrameSurface(browser, tcdp, sel) {
  const handle = await tcdp.send('Runtime.evaluate',
    { expression: `(function(){${RESOLVE_JS} return __bq(${JSON.stringify(sel)});})()`, returnByValue: false });
  if (handle.exceptionDetails) throw new Error('--frame ' + sel + ': ' + exceptionMessage(handle.exceptionDetails));
  const ownerId = handle.result && handle.result.objectId;
  if (!ownerId) throw new Error('--frame: no element matches "' + sel + '" in the top document');
  const kind = await tcdp.send('Runtime.callFunctionOn', { objectId: ownerId, returnByValue: true,
    functionDeclaration: 'function(){return this.tagName;}' });
  const tag = String((kind.result && kind.result.value) || '');
  if (tag !== 'IFRAME' && tag !== 'FRAME')
    throw new Error('--frame ' + sel + ' names a <' + tag.toLowerCase() + '>, not an <iframe> — the value must select '
      + 'the FRAME ELEMENT in the top document, and the target selector then names an element inside it');
  const want = (await tcdp.send('DOM.describeNode', { objectId: ownerId })).node.backendNodeId;

  // Candidates: the in-process children the page knows about, then every iframe TARGET in the browser (the
  // OOPIF case, which the page's own frame tree does not list). getFrameOwner filters the foreign ones out.
  const kids = ((await tcdp.send('Page.getFrameTree')).frameTree.childFrames || []).map((c) => c.frame.id);
  const oopifIds = (await browser.send('Target.getTargets')).targetInfos
    .filter((t) => t.type === 'iframe').map((t) => t.targetId);
  let frameId = null, oopif = false;
  for (const id of [...kids, ...oopifIds]) {
    let owner; try { owner = await tcdp.send('DOM.getFrameOwner', { frameId: id }); } catch (_) { continue; }
    if (owner.backendNodeId === want) { frameId = id; oopif = oopifIds.includes(id); break; }
  }
  if (!frameId) {
    try { await tcdp.send('Runtime.releaseObject', { objectId: ownerId }); } catch (_) {}
    throw new Error('--frame ' + sel + ': that <iframe> element exists but holds no loaded frame — it has no src '
      + 'yet, or its document has not committed. Wait for it to load, then retry');
  }

  // MAKE THE FRAME REACHABLE AND VISIBLE. The scroll happens ONCE, here, and converges the way rawClick's does
  // (a read whose own scroll moved the box is not trusted); the per-dispatch guard below only READS, so a click
  // sequence never scrolls the page out from under itself between the press and the release.
  let vis = null;
  for (let i = 0; i < 5; i++) {
    vis = (await tcdp.send('Runtime.callFunctionOn', { objectId: ownerId, returnByValue: true,
      functionDeclaration: `function(){ var b0=this.getBoundingClientRect();
        this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        var r=this.getBoundingClientRect();
        return { w:r.width, h:r.height, moved: Math.abs(r.top-b0.top)>=0.5||Math.abs(r.left-b0.left)>=0.5 }; }` })).result.value;
    if (!vis.moved) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  if (!vis || !vis.w || !vis.h) {
    try { await tcdp.send('Runtime.releaseObject', { objectId: ownerId }); } catch (_) {}
    throw new Error('--frame ' + sel + ' has no size (' + (vis ? vis.w + 'x' + vis.h : 'unreadable') + ') — a hidden '
      + 'or collapsed frame cannot be clicked into');
  }

  let ctx = null, fcdp = null;
  if (oopif) fcdp = await connectTarget(frameId);   // the OOPIF's targetId IS its frameId
  else ctx = (await tcdp.send('Page.createIsolatedWorld', { frameId, worldName: FRAME_WORLD })).executionContextId;

  const cdp = new FrameCDP(tcdp, ownerId, ctx, fcdp, sel);
  frameReport = { frame: sel, ...(oopif ? { oopif: true } : {}) };   // every out() from here on says where it acted
  return { cdp, oopif,
    close: async () => {
      if (fcdp) { try { fcdp.close(); } catch (_) {} }
      try { await tcdp.send('Runtime.releaseObject', { objectId: ownerId }); } catch (_) {}
    } };
}

// A stand-in for CDPClient that speaks the two things the act verbs use — Runtime/DOM against the FRAME, and
// Input at the widget that will actually receive it. Everything above it (rawClick, rawEnterText, rawPressKey,
// focusWithWait, clickWithEffect's observer, resolveRef's pin) is handed this instead of tcdp and needs no
// change at all: the nine-point hit test, the pre-press recheck and the effect signal simply run inside the
// frame, so the effect a click is judged by becomes the FRAME's own DOM rather than the top page's.
// TWO TEST-ONLY SEAMS, for the same reason BROWSE_TEST_REDACT_URL exists. The coordinate translation and
// the top-level hit test in guard() below are each a line of arithmetic whose failure is SILENT — the click
// still exits 0, it just lands somewhere else, or on the modal covering a payment frame. A negative control
// can only prove a fixture still catches that by BREAKING it on purpose and watching the suite go red; a
// one-time manual measurement rots the moment it is taken. NEVER set these anywhere but a test. Both fail in
// the visible direction if abused: NO_BOX_OFFSET makes every in-process frame click miss by the frame's
// border+padding, and NO_TOP_GUARD dispatches into a frame that something is sitting on top of, which is what
// --frame was written to refuse.
const FRAME_NO_BOX_OFFSET = process.env.BROWSE_TEST_FRAME_NO_BOX_OFFSET === '1';
const FRAME_NO_TOP_GUARD = process.env.BROWSE_TEST_FRAME_NO_TOP_GUARD === '1';
class FrameCDP {
  constructor(top, ownerId, ctx, fcdp, sel) {
    this.top = top; this.ownerId = ownerId; this.ctx = ctx; this.fcdp = fcdp; this.sel = sel;
    this.geom = null;                    // {ox,oy} from the last guard; press/release reuse the move's reading
  }
  // ONE top-session eval: current content-box origin of the owner <iframe>, plus a hit test at the exact point
  // this dispatch is aimed at. No scroll (see resolveFrameSurface) — a dispatch must never move the page.
  async guard(fx, fy) {
    const r = await this.top.send('Runtime.callFunctionOn', { objectId: this.ownerId, returnByValue: true,
      arguments: [{ value: fx }, { value: fy }, { value: FRAME_NO_BOX_OFFSET }],
      functionDeclaration: `function(fx,fy,noBox){ ${DESCRIBE_JS}
        if(!this.isConnected) return {s:'gone'};
        var r=this.getBoundingClientRect(), st=getComputedStyle(this);
        if(!r.width||!r.height) return {s:'nosize'};
        // A frame's coordinates are its CONTENT box, so the border and the padding are part of the translation
        // — dropping them misses by exactly that much, which is small enough to still land inside the frame and
        // report success. noBox is the test seam that drops them on purpose (FRAME_NO_BOX_OFFSET).
        var ox=r.left+(noBox?0:(parseFloat(st.borderLeftWidth)||0)+(parseFloat(st.paddingLeft)||0));
        var oy=r.top+(noBox?0:(parseFloat(st.borderTopWidth)||0)+(parseFloat(st.paddingTop)||0));
        var hitEl=document.elementFromPoint(ox+fx,oy+fy);
        return {s:'ok', ox:ox, oy:oy, hit:hitEl===this, by: hitEl===this?null:__brDescribe(hitEl)}; }` });
    const g = (r.result && r.result.value) || {};
    if (g.s === 'gone') throw new Error('the <iframe> named by --frame ' + this.sel + ' was removed from the page mid-call');
    if (g.s === 'nosize') throw new Error('the <iframe> named by --frame ' + this.sel + ' collapsed to zero size mid-call');
    if (!g.hit && !flags.force && !FRAME_NO_TOP_GUARD)
      throw new Error('the <iframe> named by --frame ' + this.sel + ' is covered at that point by ' + g.by
        + ' — the event would have gone to the coverer, not into the frame. NOTHING was dispatched. Dismiss it '
        + '(`browse snapshot` finds its close control), or --force to dispatch anyway. Note the in-frame hit '
        + 'test cannot see this: it only ever looks inside the frame\'s own document');
    this.geom = g;
    return g;
  }
  async send(method, params = {}, timeoutMs) {
    if (method === 'Input.dispatchMouseEvent') {
      // Recompute on the MOVE (rawClick always leads with one); press/release reuse that same reading, exactly
      // as rawClick reuses the coordinates it settled on.
      const g = (params.type === 'mouseMoved' || !this.geom) ? await this.guard(params.x, params.y) : this.geom;
      return this.fcdp
        ? this.fcdp.send(method, params, timeoutMs)                                     // OOPIF: frame-local, own widget
        : this.top.send(method, { ...params, x: params.x + g.ox, y: params.y + g.oy }, timeoutMs);
    }
    if (this.fcdp) return this.fcdp.send(method, params, timeoutMs);                    // OOPIF: everything on its own ws
    // In-process: the DOM and Input domains are the page's, but every script must run in OUR isolated world —
    // and a node resolved WITHOUT executionContextId lands in a world this one cannot see (measured; that is
    // what would silently break --ref inside a frame).
    if (method === 'Runtime.evaluate') return this.top.send(method, { ...params, contextId: this.ctx }, timeoutMs);
    if (method === 'DOM.resolveNode') return this.top.send(method, { ...params, executionContextId: this.ctx }, timeoutMs);
    return this.top.send(method, params, timeoutMs);
  }
  close() {}                             // the ws (if any) is owned by resolveFrameSurface's close()
}

// ---- the autofill marker: shared by get-values' withholding guard and click-and-await-fill's pre-gesture proof
// Chromium sets :autofill on a field IT filled from the saved-password store, and it sets it AT PAGE LOAD —
// BEFORE any user gesture, while el.value still reads as the empty string to page JS (measured). That gap is
// the whole point: the marker proves the browser filled the field WITHOUT the value ever becoming readable, so
// it is both a stronger fill proof than a non-empty read AND the signal that a field's contents are a
// credential we must not hand back.
// OVERRIDABLE FOR ONE REASON — testability, exactly like BROWSE_CDP / BROWSE_RESTART_CMD. A hermetic test runs
// a THROWAWAY profile with no saved passwords, so nothing in it can ever match a real :autofill; it points this
// at a class its fixture controls. Abusing it in production FAILS SAFE: a selector that matches nothing leaves
// get-values still withholding every type="password" field on type alone, and leaves click-and-await-fill on
// its existing click-then-poll path.
const AUTOFILL_SELECTOR = process.env.BROWSE_AUTOFILL_SELECTOR || ':autofill, :-webkit-autofill';
// Returns true / false / null. NULL IS LOAD-BEARING and must never be collapsed to false: it means the
// pseudo-class could not be evaluated on this engine, i.e. we do not KNOW whether autofill fired. Reporting
// that as "not autofilled" is precisely the false negative that sends an agent to fetch a credential by hand.
const AUTOFILL_JS = `function __af(el){
  try { return !!el.matches(${JSON.stringify(AUTOFILL_SELECTOR)}); }
  catch(e){ return null; }
}`;

// ---- `login <site>`: the registry, its schema, and the cause codes ----------------------------------------
// The ONE sanctioned way an agent signs into a site: it takes NO password, accepts none, and calls no
// credential oracle. It navigates to a registry ENTRY url, proves Chromium already filled the password field
// from ITS OWN saved store (the pre-gesture triple — see AUTOFILL_JS and rawClickAndAwaitFill), clicks SUBMIT,
// and verifies a registry-declared post-login DOM signal. The browser sends the credential from its own side;
// the value is never readable by page JS, never crosses the CDP boundary, and never reaches a transcript.
// WHY THE ENTRY URL IS NOT THE SAVED origin_url: Chromium saves the url the form was submitted from, which for
// an Auth0/SAML flow is a MID-FLOW endpoint carrying live state — navigating to it directly returns "Expired
// Link" (measured). The registry stores the url a HUMAN would start at.
// WHY THE REGISTRY IS A FILE AND NOT A CONSTANT: adding a site must be a few lines of data, reviewed as data,
// with no code change and no redeploy of logic. It is __dirname-relative (or BROWSE_LOGIN_REGISTRY), so a
// staged copy can be tested, never the live one.
const LOGIN_REGISTRY = process.env.BROWSE_LOGIN_REGISTRY || path.join(__dirname, 'browse-site-login-recipes.json');
// The closed set of cause codes. A failure is ALWAYS one of these, and the caller's correct response to every
// one of them is to report it and stop — never to fetch a credential and type it, which is the behavior this
// verb exists to eliminate.
//   NO_FORM             no login form on the entry page. With the post-login signal already satisfied this is
//                       SUCCESS (the session is still live).
//   NO_FILL             a password field is there but the pre-gesture triple does not hold: Chromium did not
//                       fill it, or the value is already JS-readable (a gesture was spent, or the SITE
//                       populated the field, which suppresses Chromium's own fill — measured).
//   TEXT_TYPE_PASSWORD  the password field is type="text" — Chromium refuses to autofill it.
//   TWO_STEP            username-first login: no password field on the entry page.
//   CHOOSER             the realm has MORE THAN ONE saved credential, so Chromium may show its native account
//                       picker instead of filling. That picker is browser UI, invisible to CDP, so this cause
//                       is DECLARED in the registry from the saved-store metadata, never detected. It is NOT
//                       a dead end, and `login` not driving it is a gap in THIS verb rather than a
//                       limit: the picker is drivable, by `native-browser-prompts-choose --username <account>`.
//                       Until `login` grows a way
//                       to say WHICH account it means, the caller runs that sequence by hand. Note also that
//                       two saved rows do not reliably produce a picker at all — Chromium often fills the
//                       preferred row silently, so a site declared CHOOSER may log in as the WRONG account.
//   BLOCKED_403         the site refused the automated browser before any form rendered (a CAPTCHA wall).
//   NOT_VERIFIED        the gate PASSED and the submit landed, but the post-login signal never appeared. This
//                       is the one code the original design did not name, and IT IS NOT A GATE FAILURE AT ALL:
//                       it is a stale credential, a second factor, or a wrong signal in the registry. Do NOT
//                       merge it into NO_FILL. NO_FILL means the browser did not fill the field; NOT_VERIFIED
//                       means it demonstrably DID, and a tool that reports a proven fill as "no fill" is
//                       telling a false negative — which is the precise mechanism that sends an agent off to
//                       fetch the credential by hand. click-and-await-fill already had that bug once.
//   DO_NOT_OPEN         DIFFERENT IN KIND from every code above. The others
//                       describe what was learned BY ATTEMPTING a login. This one says DO NOT ATTEMPT: the
//                       site is known to harm the browser, so attempting IS the harm and a code you could
//                       only discover by paying for it would be the wrong encoding. Declared in the registry,
//                       never detected, and — the load-bearing property — it must NEVER TOUCH THE NETWORK.
//                       "Absent from the registry" was considered and rejected: absent is indistinguishable
//                       from "nobody has got to it yet", and the next agent to find a hazardous site missing would reach
//                       for `browse open-url` and reproduce the harm by hand.
const LOGIN_CAUSES = new Set(['NO_FORM', 'NO_FILL', 'TEXT_TYPE_PASSWORD', 'TWO_STEP', 'CHOOSER', 'BLOCKED_403',
                              'NOT_VERIFIED', 'DO_NOT_OPEN']);
// Key allowlists, enforced at load. This is not tidiness: a registry that accepts unknown keys is a registry
// someone later adds a `username` (or worse) to, and the whole point of this file is that it holds SELECTORS
// AND URLS ONLY — never an identity, never a secret, never a pointer to one. An unknown key is a hard failure.
const LOGIN_SITE_KEYS = new Set(['entry', 'password', 'submit', 'signal', 'blocked', 'note', 'settleMs', 'verifyMs',
                                 'rounds', 'session', 'username']);
// `username` — the CSS SELECTOR of the username field, and it is a selector in exactly the sense `password`
// already is: never a value, never an identity. Declaring it marks a site as CHOOSER-DRIVEN — a realm holding
// two or more saved rows, where Chromium shows its native account picker instead of filling, so the caller has
// to NAME which account it means with `--account <email>`. That account arrives at call time and is never
// written here; a default recorded in this file is exactly the identity the allowlist exists to keep out.
// VALIDATED AGAINST '@' below. A key named `username` is the one place someone would plausibly paste an email
// years from now, and the allowlist alone cannot tell a selector from an address — so the validator does.
// `session` — the SERVER-side session-truth probe `session-state` asks (see that section for why the server is
// the only witness worth having). It is a PATH and a set of expected status codes, so it holds no more than the
// rest of this file does: a url and some numbers, never an identity and never a secret.
//   probe          same-origin path of an endpoint that requires the session. GET, side-effect free.
//   ok / no        the status codes that MEAN authenticated / MEAN not-authenticated. Anything outside BOTH
//                  lists is CANNOT_TELL, never a guess — that is the whole anti-false-negative property.
//   okContentType  optional substring the `ok` response's content-type must contain. Guards the one way a
//                  server probe can lie in the dangerous direction: a probe path that has since MOVED gets the
//                  SPA's own html shell back with a 200, which would read as authenticated forever.
const SESSION_KEYS = new Set(['probe', 'ok', 'no', 'okContentType']);
const SESSION_OK_DEFAULT = [200];
const SESSION_NO_DEFAULT = [401, 403];
const LOGIN_SIGNAL_KEYS = new Set(['urlContains', 'titleContains', 'selector', 'noPasswordFields']);
const LOGIN_SETTLE_MS = 2500;    // default CEILING on the adaptive settle — SPA login forms render late
const LOGIN_SETTLE_POLL_MS = 250; // how often the adaptive settle re-reads the gate's own condition
const LOGIN_VERIFY_MS = 25000;   // default window for the post-login signal to appear (a real sign-in redirects)
const LOGIN_ROUNDS_MAX = 3;      // hard ceiling on gate-and-submit rounds — see `rounds` in the validator below
// How long the --account path waits for the ACCOUNT PICKER to appear after it clicks the username field. The
// click raises it, but Chromium publishes it over AT-SPI a beat later, and the standalone
// native-browser-prompts-choose verb never had to wait because its caller had already SEEN the picker with
// native-browser-prompts-view before naming a row. Inside `login` nothing has looked, so a single probe races
// the widget and loses ("no saved-password chooser is showing" about a picker that was one poll away). 12s is
// the budget measured as adequate for the same widget.
const LOGIN_PICKER_MS = 12000;
// …split across this many clear-click-wait attempts. More than one because the clear can LOSE A RACE with
// Chromium's own load-time autofill on a realm that has saved rows: the field is empty when cleared and full
// again by the time the click lands, and a field holding a value shows no suggestion list. A second attempt
// runs after that fill has finished, which is the whole fix.
const LOGIN_PICKER_TRIES = 3;

// Load + VALIDATE the registry. Fails CLOSED and loudly: a missing, unparseable or malformed registry must stop
// the verb, never degrade it into "no sites are enrolled" (which reads to a caller as "so fetch the credential").
function loadLoginRegistry() {
  let raw;
  try { raw = fs.readFileSync(LOGIN_REGISTRY, 'utf8'); }
  catch (e) { die('login: cannot read the site registry ' + LOGIN_REGISTRY + ' (' + (e.message || e) + ')'); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { die('login: ' + LOGIN_REGISTRY + ' is not valid JSON (' + (e.message || e) + ')'); }
  if (!doc || typeof doc !== 'object' || !doc.sites || typeof doc.sites !== 'object' || Array.isArray(doc.sites))
    die('login: ' + LOGIN_REGISTRY + ' must be an object with a "sites" object');
  const bad = (site, msg) => die('login: registry entry "' + site + '" is invalid — ' + msg + ' (' + LOGIN_REGISTRY + ')');
  for (const [site, e] of Object.entries(doc.sites)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(site)) bad(site, 'site names are lowercase letters, digits and hyphens');
    if (!e || typeof e !== 'object' || Array.isArray(e)) bad(site, 'must be an object');
    for (const k of Object.keys(e))
      if (!LOGIN_SITE_KEYS.has(k)) bad(site, 'unknown key "' + k + '" (allowed: ' + [...LOGIN_SITE_KEYS].join(', ')
        + ') — the registry holds selectors and urls ONLY, never a username, a label or a secret');
    // `session` is validated ABOVE the blocked short-circuit, and that placement is the point: the site that
    // most needs a session probe is a BLOCKED one. A blocked site cannot be logged into by `login` at all, so
    // "can I still use the session I have?" is the only question left about it — and a validator that skipped
    // blocked entries would have silently accepted a malformed probe on exactly that site.
    if (e.session !== undefined) {
      const s = e.session;
      if (!s || typeof s !== 'object' || Array.isArray(s)) bad(site, '"session" must be an object {probe, ok, no}');
      for (const k of Object.keys(s))
        if (!SESSION_KEYS.has(k)) bad(site, 'unknown session key "' + k + '" (allowed: ' + [...SESSION_KEYS].join(', ') + ')');
      if (typeof s.probe !== 'string' || !s.probe.startsWith('/'))
        bad(site, '"session.probe" must be a SAME-ORIGIN path starting with "/" — an absolute url would let the '
          + "probe answer about some other origin's cookies, which is not the question");
      for (const [k, d] of [['ok', SESSION_OK_DEFAULT], ['no', SESSION_NO_DEFAULT]]) {
        if (s[k] === undefined) { s[k] = d.slice(); continue; }
        if (!Array.isArray(s[k]) || !s[k].length || !s[k].every((n) => Number.isInteger(n) && n >= 100 && n <= 599))
          bad(site, '"session.' + k + '" must be a non-empty array of HTTP status codes');
      }
      // An overlap would make one status mean both things, and the tie-break would decide a session by
      // whichever branch happened to be written first. Refuse it at load rather than resolve it at runtime.
      const clash = s.ok.filter((n) => s.no.includes(n));
      if (clash.length) bad(site, '"session.ok" and "session.no" both list ' + clash.join(', ')
        + ' — one status cannot mean both authenticated and not');
      if (s.okContentType !== undefined && (typeof s.okContentType !== 'string' || !s.okContentType))
        bad(site, '"session.okContentType" must be a non-empty substring of the expected content-type');
      // The probe is a PATH, so the ORIGIN has to come from somewhere: `entry`. On a non-blocked entry that is
      // already required below; a blocked one would otherwise be allowed to declare a probe with nowhere to
      // send it, and session-state would only find out at the tab.
      if (typeof e.entry !== 'string' || !/^https?:\/\//.test(e.entry))
        bad(site, 'a "session" probe needs "entry" to be an http(s) url — the probe path is resolved against '
          + "that origin, so without it there is no origin to ask");
    }
    if (e.blocked !== undefined) {                       // known-blocked: short-circuits before any navigation
      if (!LOGIN_CAUSES.has(e.blocked)) bad(site, '"blocked" must be one of ' + [...LOGIN_CAUSES].join('/'));
      continue;                                          // entry/password/submit/signal are optional on a blocked site
    }
    for (const k of ['entry', 'password', 'submit'])
      if (typeof e[k] !== 'string' || !e[k]) bad(site, 'needs a non-empty string "' + k + '"');
    if (!/^https?:\/\//.test(e.entry)) bad(site, '"entry" must be an http(s) url');
    for (const [k, d] of [['settleMs', LOGIN_SETTLE_MS], ['verifyMs', LOGIN_VERIFY_MS]]) {
      if (e[k] === undefined) { e[k] = d; continue; }
      if (!Number.isInteger(e[k]) || e[k] < 0) bad(site, '"' + k + '" must be a non-negative integer');
    }
    // `rounds` is OPT-IN PER SITE and defaults to 1 (today's behavior exactly, so no existing entry changes).
    // A verb that decided BY ITSELF to click twice would hand every single-step entry a second trusted click it
    // was never measured for; making the extra round a thing someone WROTE DOWN after measuring the second page
    // holds it to the same standard as every other key here. Capped at LOGIN_ROUNDS_MAX so total clicks stay
    // bounded by the registry rather than by whatever a page happens to do.
    if (e.rounds === undefined) e.rounds = 1;
    else if (!Number.isInteger(e.rounds) || e.rounds < 1 || e.rounds > LOGIN_ROUNDS_MAX)
      bad(site, '"rounds" must be an integer 1-' + LOGIN_ROUNDS_MAX + ' — it is the number of gate-and-submit '
        + 'rounds a two-step login needs, and each round gates independently on its own document');
    const s = e.signal;
    if (!s || typeof s !== 'object' || Array.isArray(s)) bad(site, 'needs a "signal" object (how to VERIFY the login landed)');
    for (const k of Object.keys(s))
      if (!LOGIN_SIGNAL_KEYS.has(k)) bad(site, 'unknown signal key "' + k + '" (allowed: ' + [...LOGIN_SIGNAL_KEYS].join(', ') + ')');
    if (!Object.keys(s).length) bad(site, '"signal" declares no condition — an unverifiable login is not a login');
    for (const k of ['urlContains', 'titleContains'])
      if (s[k] !== undefined && !(typeof s[k] === 'string' || (Array.isArray(s[k]) && s[k].length && s[k].every((x) => typeof x === 'string' && x))))
        bad(site, '"signal.' + k + '" must be a non-empty string or a non-empty array of them');
    if (s.selector !== undefined && (typeof s.selector !== 'string' || !s.selector)) bad(site, '"signal.selector" must be a non-empty string');
    if (s.noPasswordFields !== undefined && typeof s.noPasswordFields !== 'boolean') bad(site, '"signal.noPasswordFields" must be a boolean');
    // `username` is a SELECTOR, and this is the check that keeps it one. The allowlist can only say the key is
    // permitted; it cannot see that someone pasted an address into it, and this is the single key in the file
    // where that mistake is plausible. An '@' is the tell, so it is a hard load failure — the same failure
    // shape an unknown key gets, for the same reason.
    if (e.username !== undefined) {
      if (typeof e.username !== 'string' || !e.username)
        bad(site, '"username" must be a non-empty CSS selector for the username FIELD');
      if (e.username.includes('@'))
        bad(site, '"username" looks like an ADDRESS, not a selector ("' + e.username + '") — this key holds the '
          + 'CSS selector of the username field and NOTHING else. The account itself arrives from the caller as '
          + '`--account <email>`: the registry never holds an identity, and never a pointer to one');
    }
  }
  return doc.sites;
}

const remaining = (deadline) => Math.max(1000, deadline - Date.now());
async function focusWithWait(tcdp, target, deadline) {
  const T = asTarget(target);
  const dl = deadline ?? (Date.now() + WAIT_MS);   // ?? not ||: --no-wait makes WAIT_MS 0, and 0 is a real budget
  for (;;) {
    const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}
      var el=${elJS(T)};
      if(!el) return 'absent';
      el.focus();
      // Must pierce shadow roots: for an element INSIDE one, document.activeElement is the HOST, so a plain
      // activeElement===el can never be true and a perfectly focusable field reads 'unfocusable'. Walk down
      // through each shadowRoot.activeElement to the real innermost focused node.
      var ae=document.activeElement;
      while(ae && ae.shadowRoot && ae.shadowRoot.activeElement) ae=ae.shadowRoot.activeElement;
      return ae===el?'ok':'unfocusable';})()`, remaining(dl));
    if (r.value === 'ok') return { ok: true };
    if (Date.now() >= dl) return { ok: false, state: r.value };
    await new Promise((res) => setTimeout(res, 100));
  }
}
async function rawPressKey(tcdp, target, keyName) {
  const T = asTarget(target);
  // hasOwn, NOT KEY_MAP[keyName]: inherited proto members (toString/constructor/…) are truthy and would slip a
  // malformed key event through. (The dispatcher already filters, but this is the load-bearing safety net.)
  // THROW, never die(): die() is a synchronous process.exit, so the caller's catch never runs and an
  // ephemeral/--new tab is stranded — and stray blank tabs are what wedge this shared box. The runRaw catch
  // adds the 'press-key: ' prefix, so these messages must NOT repeat it. (Siblings rawEnterText/rawClick/
  // rawUploadFile already throw; this was the last die() left inside the raw path.)
  if (!Object.hasOwn(KEY_MAP, keyName)) throw new Error('unsupported raw key "' + keyName + '" (control keys only: ' + Object.keys(KEY_MAP).join(', ') + ')');
  const kf = KEY_MAP[keyName];
  const deadline = Date.now() + WAIT_MS;            // one budget for the whole call, like the sibling verbs
  const f = await focusWithWait(tcdp, T, deadline);
  if (!f.ok) throw new Error((f.state === 'unfocusable'
    ? 'element present but not focusable (hidden/disabled?) after '
    : (T.ref ? 'ref no longer resolves after ' : 'selector not found after ')) + WAIT_MS + 'ms: ' + targetName(T));
  const base = { key: keyName === 'Space' ? ' ' : keyName, code: kf.code, windowsVirtualKeyCode: kf.vk, nativeVirtualKeyCode: kf.vk };
  // text-producing keys (Enter/Space) use type 'keyDown' + text (fires keydown/keypress/input like a real
  // key); non-text control keys use 'rawKeyDown' (keydown only) — this is precisely what Playwright emits.
  const down = kf.text ? { type: 'keyDown', ...base, text: kf.text, unmodifiedText: kf.text } : { type: 'rawKeyDown', ...base };
  await tcdp.send('Input.dispatchKeyEvent', down, remaining(deadline));
  await tcdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, remaining(deadline));
}

// Type text as REAL per-character keystrokes (keydown/keypress/input/keyup each), the way a human's keys
// arrive. This exists because ONE trusted input event is not always enough: a key-handler widget (e.g.
// an autoNumeric-style currency field) keeps its OWN state fed by key events, ignores what insertText wrote into the DOM,
// and commits EMPTY — a form then submits silently empty while the same values typed by hand go through. Used
// when the field itself listens for keys (see fieldWantsKeystrokes) and as the retry when insertText
// demonstrably did not land. Slower than insertText by a few ms per character; only fields that need it pay.
async function typeAsKeystrokes(tcdp, text, deadline) {
  for (const ch of String(text)) {
    const vk = /^[a-z0-9 ]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0;
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await tcdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: ch }, remaining(deadline));
    await tcdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, remaining(deadline));
  }
}

// Does the field ITSELF handle key events? An element-level keydown/keypress listener is the signature of an
// autoNumeric-style widget; ordinary framework inputs (React, Vue) delegate at the document root and do not
// match, so the common case stays on the single-event insertText path. Fail-soft by design: any error —
// DOMDebugger unavailable, element gone, whatever — reads as "no", and the caller types the way it always
// did. Detection can only upgrade a picky field to keystrokes, never break an ordinary one.
async function fieldWantsKeystrokes(tcdp, T, deadline) {
  try {
    const ev = await tcdp.send('Runtime.evaluate',
      { expression: `(function(){${RESOLVE_JS} return ${elJS(T)};})()`, returnByValue: false }, remaining(deadline));
    const objectId = ev && ev.result && ev.result.objectId;
    if (!objectId) return false;
    let listeners;
    try { listeners = await tcdp.send('DOMDebugger.getEventListeners', { objectId }, remaining(deadline)); }
    finally { tcdp.send('Runtime.releaseObject', { objectId }, 2000).catch(() => {}); }
    return (listeners.listeners || []).some((l) => l.type === 'keydown' || l.type === 'keypress');
  } catch (_) { return false; }
}

// Raw-CDP text entry — the wedge-immune counterpart of Playwright page.fill(). It MIRRORS what
// fill() actually does, and that detail is load-bearing: fill() does NOT just set .value and dispatch a
// synthetic event — it clears the field, then types the content through the browser's real input pipeline, so
// the resulting `input` event is isTrusted:TRUE. Autofill triggers and hardened (PCI/payment) framework
// handlers REJECT synthetic isTrusted:false events, so a native-setter-only re-implementation would be a
// silent behavior DOWNGRADE on exactly the checkout pages a raw-CDP tool most needs to drive.
// Hence: auto-wait+focus -> SELECT the existing content -> Input.insertText, which replaces the selection and
// fires exactly ONE trusted input event (empty text instead sends a real Delete keystroke, so clearing a
// controlled/React field is also a genuine event it can see). Selecting rather than blanking .value is what
// makes this byte-parity with fill(): an earlier draft cleared via the native value setter + a hand-dispatched
// input event, which a test caught emitting a SPURIOUS isTrusted:false event Playwright never fires
// (React's onChange would run twice, once with an empty value) — and which fired NO event at all when clearing.
//
// TWO MEASURED FAILURE MODES moved pre-filled and key-handler fields OFF that single-event fast path (an empty
// ordinary field — the common case — keeps it byte-for-byte):
//   (1) DOUBLING. A page handler can collapse the selection in the gap between the prep eval and the Input
//       call, and insertText then APPENDS at the caret — a pre-filled value appeared twice, reported as
//       success. So a
//       PRE-FILLED field is WIPED FIRST (real Delete over the selection) and the wipe is PROVEN by readback
//       before any text is sent; a field that will not come clean is a loud error, never a fill attempt.
//   (2) COMMIT-EMPTY. A key-handler widget feeds its own state from key events, ignores insertText's DOM
//       write, and commits EMPTY (see typeAsKeystrokes). A field carrying its own keydown/keypress listener is
//       typed as real per-character keystrokes instead (fieldWantsKeystrokes), and a readback failure on the
//       insertText path retries once the same way.
// Reports the value that actually landed; fail-STOPs only when NOTHING landed (see the readback note below).
// The whole call runs to ONE wall-clock budget (PRESS_TIMEOUT_MS) so a blocked renderer can't hold the global
// flock for minutes — the exact failure shape of the connectOverCDP wedge. Throws (never die()s) so the caller's
// catch closes an ephemeral/--new tab instead of leaking it.
//
// Input types split three ways, exactly as fill() does:
//   SET_VALUE (color/date/time/…)  — no text pipeline exists; fill() assigns .value + fires synthetic
//                                     input+change. Reproduced here, or these types become unfillable.
//   TYPE_INTO (text/email/number/…) — select + insertText (trusted).
//   anything else (checkbox/radio/file/submit) — refused BY NAME, like Playwright's "cannot be filled".
const SET_VALUE_TYPES = ['color', 'date', 'datetime-local', 'month', 'range', 'time', 'week'];
const TYPE_INTO_TYPES = ['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url'];
async function rawEnterText(tcdp, target, text) {
  const T = asTarget(target), NAME = targetName(T);
  const deadline = Date.now() + WAIT_MS;
  const f = await focusWithWait(tcdp, T, deadline);
  if (!f.ok) throw new Error((f.state === 'unfocusable'
    ? 'element present but not focusable (hidden/disabled?) after '
    : (T.ref ? 'ref no longer resolves after ' : 'selector not found after ')) + WAIT_MS + 'ms: ' + NAME);
  // Classify, record the pre-existing value, and either SELECT the content (text path — no value mutation, so
  // no synthetic event) or assign it outright (set-value path). One eval, so no extra round trip.
  const prep = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}${AUTOFILL_JS}
    var el=${elJS(T)};
    if(!el) return {kind:'gone'};
    if(el.disabled||el.readOnly) return {kind:'readonly'};
    var tag=el.tagName, ty=String((el.type||'')).toLowerCase();   // String(): el.type is an ELEMENT on a form whose control is named "type" — see __ty
    var sec=ty==='password'||__af(el)===true;   // a credential field: report true/false about it, never its value or length
    if(tag==='INPUT'&&${JSON.stringify(SET_VALUE_TYPES)}.indexOf(ty)>=0){
      var before=el.value;
      var d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
      if(d&&d.set) d.set.call(el,${JSON.stringify(text)}); else el.value=${JSON.stringify(text)};
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return {kind:'done', before:before, type:ty, secret:sec};
    }
    if(tag==='INPUT'&&${JSON.stringify(TYPE_INTO_TYPES)}.indexOf(ty)<0) return {kind:'badtype', type:ty};
    if(tag==='INPUT'||tag==='TEXTAREA'){ var b=el.value; try{ el.select(); }catch(_){} return {kind:'value', before:b, type:ty, secret:sec}; }
    if(el.isContentEditable){
      var b2=el.textContent;
      var r=document.createRange(); r.selectNodeContents(el);
      var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
      return {kind:'contenteditable', before:b2, secret:sec};
    }
    return {kind:'unfillable'};
  })()`, remaining(deadline));
  const p = prep.value || {};
  if (p.kind === 'gone') throw new Error('element vanished after focus: ' + NAME);
  if (p.kind === 'readonly') throw new Error('element is disabled or readonly: ' + NAME);
  if (p.kind === 'badtype') throw new Error('input of type "' + p.type + '" cannot be filled: ' + NAME);
  if (p.kind === 'unfillable') throw new Error('not a fillable element (need input/textarea/contenteditable): ' + NAME
    + ' — check what the selector actually resolved to with `browse snapshot`, which reports each element\'s role '
    + 'and tag; a wrapper <div> around the real input is the usual cause. To type into a control that is not an '
    + 'input at all, focus it and send the characters as keystrokes with press-key');

  const readValue = async () => (await evalInTarget(tcdp, `(function(){${RESOLVE_JS}
    var el=${elJS(T)};
    if(!el) return null;
    return ${JSON.stringify(p.kind)}==='contenteditable' ? el.textContent : el.value;
  })()`, remaining(deadline))).value;
  const selectAll = () => evalInTarget(tcdp, `(function(){${RESOLVE_JS}
    var el=${elJS(T)}; if(!el) return 'gone';
    if(el.tagName==='INPUT'||el.tagName==='TEXTAREA'){ try{el.select();}catch(_){try{el.setSelectionRange(0,String(el.value).length);}catch(__){}} }
    else { var r=document.createRange(); r.selectNodeContents(el); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); }
    return 'ok';
  })()`, remaining(deadline));
  const sendDelete = async () => {
    const d = KEY_MAP.Delete, kb = { key: 'Delete', code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
    await tcdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...kb }, remaining(deadline));
    await tcdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...kb }, remaining(deadline));
  };

  let typedAs = p.kind === 'done' ? 'set-value' : 'insert-text';
  let cleared = false;
  if (p.kind !== 'done') {                                  // set-value types already have their value
    if (text) {
      // WIPE FIRST, AND PROVE THE WIPE — failure mode (1) in the header comment. The prep eval selected the
      // content, but only a verified-empty field cannot double.
      if (p.before) {
        cleared = true;
        let leftover = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (attempt > 1) await selectAll();
          await sendDelete();
          leftover = await readValue();
          if (!leftover) break;
        }
        if (leftover) throw new Error('could not clear the pre-filled field before typing — after select-all + '
          + 'Delete (twice) it still holds '
          + (p.secret ? 'a value (password/autofilled field: not shown)' : JSON.stringify(String(leftover).slice(0, 80)))
          + ': ' + NAME
          + ' (a page handler is rewriting the value; typing into it would append, not replace)');
      }
      if (await fieldWantsKeystrokes(tcdp, T, deadline)) {  // failure (2): key-handler widgets get real keys
        typedAs = 'keystrokes';
        await typeAsKeystrokes(tcdp, text, deadline);
      } else {
        await tcdp.send('Input.insertText', { text }, remaining(deadline)); // TRUSTED, replaces the selection, like fill()
      }
    } else {
      // Empty text = clear. A real Delete keystroke over the selection, NOT a silent .value='' — a controlled
      // (React) field must receive a genuine event or it re-renders the stale value.
      await sendDelete();
    }
  }

  // READBACK — report, don't over-police. A field may LEGITIMATELY hold something other than what was typed:
  // a phone/date mask reformats (2125551234 -> 212-555-1234), type=number trims, an uppercasing handler rewrites.
  // Playwright's fill() succeeded in all of those, and this verb replaced it, so failing here would be a
  // REGRESSION that breaks working flows. So: fail only when NOTHING landed — after one automatic retry as real
  // keystrokes (failure mode (2)) — and always return the actual value so the caller can see any reformatting. For
  // a strict assertion use the purpose-built `get-values '#sel==expected'`.
  let after = await readValue();
  const landedNothing = (v) => text ? (v == null || v === '' || (v === p.before && v !== text))
                                    : (v != null && v !== '');
  if (landedNothing(after) && text && typedAs === 'insert-text') {
    typedAs = 'keystrokes-retry';
    if (after) { await selectAll(); await sendDelete(); }
    await typeAsKeystrokes(tcdp, text, deadline);
    after = await readValue();
  }
  if (landedNothing(after))
    throw new Error('value did not land — field '
      + (p.secret ? (after ? 'holds a value' : 'is empty') + ' (password/autofilled field: values not shown)'
                  : 'holds ' + JSON.stringify(after) + ' after typing ' + JSON.stringify(text))
      + (typedAs === 'insert-text' || !text ? '' : ' (insertText and per-character keystrokes both tried)')
      + ' (an autocomplete/validation handler is probably swallowing it — click the field first so its handler '
      + 'arms, then re-enter)');
  return { value: after, differs: after !== text, typed: typedAs, cleared, secret: !!p.secret };
}

// ---- THE HIT TEST, as one in-page definition with TWO readers ---------------------------------------------
// rawClick's actionability read CHOOSES the click point with it, and the pre-press recheck RE-VALIDATES that
// same point with it (see PRE-PRESS RECHECK below). It is deliberately one definition rather than two copies:
// a recheck even slightly stricter than the read that picked the point would refuse clicks the read had just
// vouched for, and one slightly looser would vouch for a point it never really tested — either way the guard
// would be answering a different question from the one that chose the coordinates.
// __brProbe takes `el` as an argument rather than closing over it, which is the only change from the version
// that lived inline; the retargeting-chain semantics below are unchanged.
//
// THE RETARGETING CHAIN. document.elementFromPoint reports the SHADOW HOST for a point inside an open shadow
// tree, and Node.contains does not cross a shadow boundary — so a target inside a web component could never
// satisfy the hit test and every click on one was refused as 'obscured', while __bq resolved it perfectly
// well. The asymmetry was measured when the stable-ref work needed a shadow-root element to be clickable.
// Fix: descend through each open shadow root at the same point and test EVERY level of the chain. It is a
// strict SUPERSET of the old test (chain[0] is exactly what the old code looked at), so it can only turn a
// false 'obscured' into a hit and never the reverse — a genuine overlay, whose own shadow content covers the
// target, matches at no level and is still refused. Both directions matter: el may be the HOST whose inner
// content the point lands on, or the inner element itself.
const PROBE_JS = `function __brProbe(el,x,y){
  var top=document.elementFromPoint(x,y);
  if(!top) return null;                                  // outside the viewport: no answer, not a miss
  var chain=[], c=top;
  while(c){ chain.push(c); if(!c.shadowRoot) break; var inner=c.shadowRoot.elementFromPoint(x,y); if(!inner||inner===c) break; c=inner; }
  // hit is fine if the point lands on the element, a descendant of it, or an ancestor wrapping it
  return {top:chain[chain.length-1],
          hit:chain.some(function(n){ return n===el || el.contains(n) || n.contains(el); })};
}`;
// NAME WHAT IS THERE INSTEAD so the caller can act on it. 'DIV' told nobody anything — a cookie banner is
// usually class-only, and its TEXT is what identifies it to a human reading the transcript. Tag, id, up to
// three classes, role/aria-label, a 60-char text snippet, fixed/sticky + z-index, and whether it covers the
// whole viewport (which is what separates "a modal is up" from "a badge sits on this button").
// VALUE-FREE: textContent only, never el.value — the same line the snapshot collector holds.
const DESCRIBE_JS = `function __brDescribe(n){
  if(!n) return 'nothing (the point is outside the viewport)';
  var s=(n.tagName||'?').toLowerCase();
  if(n.id) s+='#'+n.id;
  var cn=(typeof n.className==='string'?n.className:'').trim().split(/\\s+/).filter(Boolean).slice(0,3);
  if(cn.length) s+='.'+cn.join('.');
  var lbl=n.getAttribute&&(n.getAttribute('aria-label')||n.getAttribute('role'));
  if(lbl) s+=' ['+String(lbl).slice(0,40)+']';
  var t=String(n.textContent||'').slice(0,400).replace(/\\s+/g,' ').trim();
  if(t) s+=' "'+t.slice(0,60)+(t.length>60?'\\u2026':'')+'"';
  try{ var cs=getComputedStyle(n);
       if(cs.position==='fixed'||cs.position==='sticky') s+=' ('+cs.position+(cs.zIndex&&cs.zIndex!=='auto'?' z'+cs.zIndex:'')+')'; }catch(e){}
  try{ var r=n.getBoundingClientRect();
       if(r.width*r.height >= innerWidth*innerHeight*0.9) s+=' \\u2014 COVERS THE WHOLE VIEWPORT'; }catch(e){}
  return s;
}`;

// ---- PRE-PRESS RECHECK: the click point is re-validated in the round trip before the press ------------------
// THE HAZARD, measured on a throwaway Chromium with a hermetic fixture. rawClick's actionability read returns {x,y}
// and the press then goes out in SEPARATE CDP round trips. Nothing revalidated the point in between, so the
// hit test was a SNAPSHOT OF LAYOUT and the press acted on that snapshot:
//   fixture: spacer(60px) / #target(60px) / #decoy(60px) stacked, with a `mousemove` listener that removes
//   the spacer once. rawClick dispatches mouseMoved FIRST (deliberately — hover menus arm on it), the page
//   shifts up exactly one button height, and the press at the target's old center lands on #decoy.
//   Result before this guard: `{"clicked":"#target","raw":true,"at":{"x":150,"y":90}}`, exit 0, DECOY clicked.
// TWO further findings from that measurement, both of which decided the design:
//   · `--ref` IS NOT IMMUNE. A ref pins WHICH element resolves; the press is still coordinate-based, so a
//     pinned element that moves is clicked around exactly the same (measured: `click --ref 1` also hit DECOY).
//     Stable refs and this guard answer different questions — identity vs. coordinates — and neither replaces
//     the other.
//   · CLICK EFFECT MASKS IT. The reflow that causes the miss is itself a DOM mutation, so the effect signal
//     read `changed` — the one thing a caller would trust to catch a no-op click reported the miss as success.
// THE GUARD: after the settled read and after the mouseMoved, re-run the SAME hit test at exactly the
// coordinates about to be pressed. The mouseMoved goes out BEFORE the recheck on purpose — it is itself a
// reflow trigger, so validating after it is what makes the whole hover-driven class deterministic instead of
// lucky. A failed recheck does NOT fail the verb: it falls back into the existing actionability poll, which
// re-reads the now-current layout and re-aims, so an opening menu or a settling banner converges on the second
// pass. Only a page that never stops moving runs out of re-aims (see the cap below), and then it fails BY NAME.
// WHAT IS COMPARED, and why it is not just the hit test again: the recheck checks the point AND the element's
// IDENTITY against the node the coordinates were chosen for, because on a selector target a re-query can
// return a different match — see the identity note inside recheckJS.
// UNDER --force the recheck degrades to "the point is still inside the target's box": --force already means
// "let the coverer take the click", so a hit-chain test there would refuse every forced click by definition.
// THE HONEST LIMIT, stated because a guard that oversells itself is worse than none: this closes everything
// that reflows before the recheck. A mutation landing in the one remaining round trip (recheck → press) is
// still possible. The window goes from three round trips to one; it does not vanish.
// COST: one extra eval per click. --no-recheck skips it.
// A RECHECK THAT CANNOT BE EVALUATED IS A FAILED RECHECK, NOT A FAILED CLICK. The eval throws on a destroyed
// execution context and on a CDP timeout, and this is the FIRST eval after a synthetic mouseMoved — the event
// most likely to have left the renderer doing heavy synchronous work. Both outcomes therefore fall into the
// same poll a returned {ok:false} does (rawClick's catch below), which is what the paragraph above
// promises. The deadline still ends a page that never answers at all, so nothing hangs.
// A CAP ON RE-AIMING, separate from the wait budget. `--wait` buys time for an element that has not MOUNTED
// yet; it cannot help a page whose reflow is CAUSED BY the mouse move, which re-aims forever and holds the
// global flock for the whole budget (30s by default) while doing it. Twenty re-aims is far beyond what any
// converging page needs — an opening menu or a settling banner is done in one or two — so the cap only ever
// ends the pathological case, and it says so by name rather than blaming the clock.
const RECHECK_MAX_REPOSITIONS = Number(process.env.BROWSE_RECHECK_MAX_REPOSITIONS) || 20;
// WHERE THE AIMED-AT ELEMENT IS REMEMBERED, so the recheck can compare IDENTITY instead of trusting a second
// query. The actionability eval stashes what it aimed at; the recheck reads it back and clears it. A WeakRef
// (where the engine has one) so a stash left behind by a click that never reached its recheck retains nothing.
const AIM_PIN = '__browseAimEl';
const recheckJS = (T, x, y, forced) => `(function(){${RESOLVE_JS}
  ${PROBE_JS}
  ${DESCRIBE_JS}
  var el=${elJS(T)};
  var aim=window[${JSON.stringify(AIM_PIN)}];
  if(aim&&typeof aim.deref==='function') aim=aim.deref();
  try{ delete window[${JSON.stringify(AIM_PIN)}]; }catch(e){ window[${JSON.stringify(AIM_PIN)}]=undefined; }
  // The click-effect counter, read HERE because this is now the last round trip before the mouse events go
  // out. Reading it in the actionability eval instead would count every mutation the mouseMoved provoked as
  // an EFFECT OF THE CLICK — on the fixture above, precisely the reflow that caused the miss. See CLICK EFFECT.
  var fx = (window.__brFx && window.__brFx.tok) ? window.__brFx.n : -1;
  if(!el) return {ok:false, fx:fx, why:'the element is gone'};
  // IDENTITY, not a second query. On a --ref target elJS reads the pin, so this is always the same node; on a
  // SELECTOR it is a fresh __bq(), and a DOM reorder — the very hazard being guarded against — can hand back a
  // DIFFERENT matching element. Validating "is the point inside THIS element?" about coordinates chosen for
  // another one is a false pass wearing a green light, so a mismatch re-aims instead.
  // ONLY when the aimed-at node is STILL CONNECTED, which is what separates the two cases: a reorder leaves it
  // in the page (a genuine wrong-element hazard), whereas a framework re-render DETACHES it and the fresh node
  // is its legitimate successor — refusing that one would make a re-rendering page permanently unclickable.
  if(aim && aim!==el && aim.isConnected)
    return {ok:false, fx:fx, why:'a DIFFERENT element now matches this selector (' + __brDescribe(el)
      + ') — the one the coordinates were chosen for is still on the page, so the DOM re-ordered under us'};
  var b=el.getBoundingClientRect();
  if(!b.width||!b.height) return {ok:false, fx:fx, why:'the element lost its box'};
  var inBox = ${x}>=b.left && ${x}<=b.right && ${y}>=b.top && ${y}<=b.bottom;
  ${forced
    ? `return inBox ? {ok:true, fx:fx}
         : {ok:false, fx:fx, why:'the target MOVED — the forced click point is now outside its box'};`
    : `var p=__brProbe(el,${x},${y});
       if(p&&p.hit) return {ok:true, fx:fx};
       return {ok:false, fx:fx, why:(p ? 'the point now lands on ' + __brDescribe(p.top)
                                        + (inBox ? ' (still inside the target box — something covered it)'
                                                 : ' (the target MOVED away from this point)')
                                      : 'the point is now outside the viewport')};`}
})()`;

// Raw click — the wedge-immune counterpart of Playwright page.click().
// TRUSTED EVENTS ARE THE POINT: this dispatches real Input.dispatchMouseEvent at coordinates, NOT el.click().
// A synthetic el.click() produces isTrusted:false events, which Chromium's saved-password autofill ignores and
// hardened/PCI handlers reject — i.e. exactly the payment pages a raw-CDP tool most needs would silently fail.
// Reproduces the load-bearing half of Playwright's actionability check, polled to the same PRESS_TIMEOUT_MS:
//   present (via __bq, so shadow roots + <label> retargeting match the other raw verbs) → not disabled →
//   scrolled into view → non-zero box → AND the topmost element at the click point is the target (or inside it).
// That last hit test is what stops a cookie banner / modal overlay from eating the click and reporting success —
// the failure mode that reads as "click worked but nothing happened". 'obscured' names it explicitly.
// THE COORDINATES MUST COME FROM A SETTLED LAYOUT — the scroll is therefore 'instant', and a read whose own
// scroll MOVED the box is never dispatched from. On a page carrying CSS `scroll-behavior: smooth`
// (increasingly common) a plain scrollIntoView is ASYNCHRONOUS: the rect read in the
// same eval is the PRE-scroll one, so the mouse events land wherever that stale point ends up once the page
// settles — the click hits empty space and the verb still reports exit 0 / raw:true / an {x,y}. The obscured
// hit test is BLIND to it: document.elementFromPoint runs inside that same synchronous block, before the scroll
// executes, so it validates the stale point. Measured on a live smooth-scroll site: dispatched y=787 while the
// settled center was y=453 (settled scrollY=334) — the first click silently missed, the second only "worked"
// because the element was by then already centered, making scrollIntoView a no-op. Two halves, both load-bearing:
//   behavior:'instant' — OVERRIDES the page's CSS scroll-behavior, verified on this Chromium rather than
//     assumed (headless, smooth page: scrollY 0 → 429 SYNCHRONOUSLY with 'instant'; 0 → …async… → 429
//     without), so the rect and the hit test both see the post-scroll layout.
//   the 'moved' flag — each eval reports whether ITS OWN scrollIntoView shifted the box, and only a read that
//     moved NOTHING may be dispatched from. Such a read started no scroll, so nothing is in flight behind it,
//     and the hit test ran at exactly the point about to be clicked. It doubles as a convergence loop for a
//     page that keeps shifting content under us (sticky header, lazy rows loading in above the target): each
//     poll re-centers until a poll has nothing left to do. It costs an extra eval ONLY when a scroll actually
//     happened — an element already in view (the common case) still takes one round trip.
//   Fixture measurement (smooth-scroll page, busy main thread): 0/5 clicks landed before, 5/5 after.
// A frame's document is not this page target's, so a selector alone cannot reach into one: name the frame with
// `--frame <iframe selector>` and the verb resolves inside it (see FRAME REACH), cross-origin included.
// WHICH HIT TEST, and why NOT the two CDP ones (measured headless=new AND headful-on-Xvfb, on a
// tab held in the background with document.visibilityState==='hidden' asserted — the condition every `browse`
// tab is in). Three techniques were run against one fixture in five states (clear · below the fold · inside a
// nested scroll container · under a full-viewport modal · under a sticky banner):
//   document.elementFromPoint, COMPARED IN THE PAGE  — 6/6 correct. This is the one, and it is what runs below.
//   DOM.getNodeForLocation                            — 5/6. It hit-tests the last COMPOSITED frame, which a
//     background tab never repaints, so after scrollIntoView moved the page ~1200px it named DIV#spacer — the
//     element that USED to be at those coordinates. It would invent an overlay on any off-screen target.
//   DOM.getBoxModel / DOM.getContentQuads             — 0/6. Geometry, not occlusion: under the full-viewport
//     modal it still returns the target's 200x40 box and one content quad. It cannot see a coverer at all.
// NOTE elementFromPoint is NOT useless on a background tab, though it can look that way: returning the ELEMENT
// itself over CDP with returnByValue serializes a DOM node to `{}` — an object with no tagName. That is a CDP
// SERIALIZATION artifact, not a fact about the browser: elementFromPoint reads LAYOUT, and a background tab
// still lays out; only paint/compositing is skipped. Do the comparison IN THE PAGE so a boolean crosses the
// boundary and it is correct every time. No foregrounding, so no view flicker.
// NINE PROBE POINTS, CENTER FIRST. A sticky header over the top half of a button used to be a hard refusal
// even though the bottom half was clickable, so the eval walks the center, then the four edge-midpoints, then
// the four corners (each inset from the edge), and dispatches at the FIRST point whose hit chain still
// resolves to the target. The predicate is identical at every point, so this cannot click something else: a
// genuine overlay fails all nine and is still refused. The center is probed FIRST and ALONE — the other eight
// are consulted only once it is known to be covered — so a target with a clear center, the overwhelming
// common case, costs the one probe it always cost and dispatches at the coordinates it always used.
// budgetMs (optional) caps the whole call for a caller working to a wall-clock budget of its own (rawDownload
// passes what is left of the trigger half), so a serial worst case can't stack full PRESS_TIMEOUT_MS waits.
// force (click --force) dispatches at the CENTER even when every probe point is covered — i.e. it knowingly
// lets the coverer receive the click. For the one case the test gets wrong: a decorative layer that forwards
// the event on. It is never the default, and the coverer is still named in the output.
async function rawClick(tcdp, target, budgetMs, force) {
  const T = asTarget(target), NAME = targetName(T);
  const cap = budgetMs ?? WAIT_MS;   // ?? not ||: --no-wait makes WAIT_MS 0, and `0 || 30000` would silently restore the default
  const deadline = Date.now() + cap;
  let pt = null, settling = false, last = 'absent', lastObscured = null, repositioned = 0, hovered = false;
  for (;;) {
    const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}
      var el=${elJS(T)};
      if(!el) return {s:'absent'};
      if(el.disabled) return {s:'disabled'};
      ${RECHECK ? `try{ window[${JSON.stringify(AIM_PIN)}] = (typeof WeakRef==='function') ? new WeakRef(el) : el; }catch(e){}   // the recheck compares against THIS node — see recheckJS` : ''}
      var b0=el.getBoundingClientRect();
      el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});   // 'instant' beats the page's CSS scroll-behavior:smooth, so the rect below is POST-scroll
      var b=el.getBoundingClientRect();
      if(!b.width||!b.height) return {s:'nosize'};
      // The hit test and the coverer description are SHARED with the pre-press recheck — see PROBE_JS /
      // DESCRIBE_JS above, which is where the retargeting-chain reasoning now lives.
      ${PROBE_JS}
      var probe=function(x,y){ return __brProbe(el,x,y); };
      ${DESCRIBE_JS}
      var describe=__brDescribe;
      var cx=b.left+b.width/2, cy=b.top+b.height/2;
      // THE CENTER IS TRIED FIRST AND ALONE. A clear center — the overwhelming common case — costs exactly the
      // one probe it always cost, at the coordinates it always used; the other eight are consulted only once
      // the center is known to be covered, so nothing about the ordinary click changed.
      var centre=probe(cx,cy);
      if(!centre) return {s:'offscreen'};                          // scrolling failed; alternates would be guesses
      var by = centre.hit ? null : describe(centre.top);
      var at = centre.hit ? {x:cx,y:cy,alt:false} : null;
      var ix=Math.min(b.width/4, 8), iy=Math.min(b.height/4, 8);   // inset, so a 1px border never decides it
      var pts=[[cx,b.bottom-iy],[cx,b.top+iy],[b.right-ix,cy],[b.left+ix,cy],
               [b.left+ix,b.bottom-iy],[b.right-ix,b.bottom-iy],[b.left+ix,b.top+iy],[b.right-ix,b.top+iy]];
      for(var i=0;i<pts.length && !at;i++){ var p=probe(pts[i][0],pts[i][1]); if(p&&p.hit) at={x:pts[i][0],y:pts[i][1],alt:true}; }
      // did THIS eval's scroll move the box? if so the caller re-reads instead of dispatching at a point the
      // page may still be traveling away from (0.5px = sub-pixel layout jitter, not motion)
      var moved = Math.abs(b.top-b0.top)>=0.5 || Math.abs(b.left-b0.left)>=0.5;
      // CLICK EFFECT (see clickWithEffect): the mutation counter. With the pre-press recheck armed (the
      // default) the RECHECK's reading supersedes this one, because that eval is then the last round trip
      // before the mouse events — see recheckJS. This reading is what --no-recheck falls back to, and it is
      // exactly where the counter has always been read, so that path is unchanged.
      var fx = (window.__brFx && window.__brFx.tok) ? window.__brFx.n : -1;
      return at ? {s:'ok', x:at.x, y:at.y, alt:at.alt, by:by, moved:moved, fx:fx}
                : {s:'obscured', by:by, x:cx, y:cy, moved:moved, fx:fx};   // x/y so --force has somewhere to aim
    })()`, remaining(deadline));
    const v = r.value || {};
    // A CANDIDATE, not yet a decision: a settled read (this eval scrolled nothing, so x/y and the hit test
    // agree with each other) — or, with --force, a settled read whose every probe point is covered. --force
    // does not wait an overlay out: the caller has already said it does not want the refusal. `moved` is still
    // honored either way, since forcing a click at coordinates the page is scrolling away from would miss for
    // the ordinary reason and blame the overlay.
    const cand = (v.s === 'ok' && !v.moved) ? v
               : (force && v.s === 'obscured' && !v.moved) ? { ...v, forced: true }
               : null;
    if (cand) {
      // The mouse MOVE goes out here, before the press and before the recheck: hover handlers/menus that only
      // arm on mouseover need it, it matches a real pointer, and it is itself the commonest reflow trigger —
      // so the recheck must see the page as the move left it. See PRE-PRESS RECHECK.
      await tcdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cand.x, y: cand.y, buttons: 0 });
      hovered = true;
      if (!RECHECK) { pt = cand; break; }
      let gv;
      // A throw is the SAME answer as {ok:false} — see the note above recheckJS. Never an aborted click.
      try { gv = (await evalInTarget(tcdp, recheckJS(T, cand.x, cand.y, !!cand.forced), remaining(deadline))).value || {}; }
      catch (e) { gv = { ok: false, why: 'the recheck could not be evaluated (' + errText(e).replace(/\s+/g, ' ').slice(0, 120) + ')' }; }
      if (gv.ok) { pt = { ...cand, fx: gv.fx, ...(repositioned ? { repositioned } : {}) }; break; }
      // The page moved under the click point. Do NOT press — fall back into the poll, which re-reads the
      // now-current layout and re-aims. An opening menu or a settling banner converges on the next pass.
      repositioned++;
      lastObscured = null;                             // this is a movement failure, not an overlay one
      last = 'the target moved out from under the click point between the hit test and the press — '
           + (gv.why || 'the recheck could not be evaluated');
      if (repositioned >= RECHECK_MAX_REPOSITIONS || Date.now() >= deadline) break;   // the cap is the pathological page's exit, the deadline everyone else's
      await new Promise((res) => setTimeout(res, 50));  // 50ms: a page mid-reflow, same cadence as a moved box
      continue;
    }
    settling = v.s === 'ok';
    lastObscured = v.s === 'obscured' ? v.by : null;   // cleared, so the LAST read decides which hint is printed
    last = settling ? 'position never settled — the page kept scrolling under the click point'
      : (v.s === 'obscured' ? 'obscured by ' + v.by : v.s);
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, settling ? 50 : 100)); // 50ms to re-read a box that just moved, 100ms for the ordinary actionability retry
  }
  if (!pt) {
    // PARK THE POINTER BEFORE FAILING. Every candidate iteration hovers the target (the mouseMoved above), so a
    // click that dies here leaves the synthetic pointer sitting on the control with whatever menu or tooltip it
    // opened still up — for the NEXT verb, and the next session, to trip over on a shared browser. The corner is
    // the one point on any page we drive that is not a control. Best effort: a verb that is already failing must
    // not fail differently because the reset threw.
    if (hovered) try { await tcdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0, buttons: 0 }, 2000); } catch (_) {}
    throw new Error('click: element not clickable after ' + cap + 'ms (' + last + '): ' + NAME
    + (lastObscured
        ? ' — something COVERS the target at all nine probe points across its box, so the click would have '
          + 'landed on the coverer and reported success. Dismiss it (`browse snapshot` finds its close control), '
          + 'or `--force` to dispatch at the center anyway and let the coverer take the click'
        : repositioned
        ? ' — the page never held still long enough to press: NOTHING was clicked, rather than the wrong thing '
          + 'being clicked and reported as success. Re-aimed ' + repositioned
          + (repositioned >= RECHECK_MAX_REPOSITIONS
              ? ' times, which is the cap: this page moves the target on EVERY mouse move, so a longer `--wait` '
                + 'cannot help. `--no-recheck` presses at the coordinates the hit test chose and accepts whatever '
                + 'is there by then'
              : ' times before the budget ran out. Give it longer (`--wait <ms>`), or `--no-recheck` to press '
                + 'at the coordinates the hit test chose and accept whatever is there by then')
        : T.ref ? ' — the ref resolved but the element never became clickable; `browse snapshot` to re-read the page'
                : ' — `browse snapshot` shows what the page is actually offering right now, and --ref <n> aims at '
                  + 'the element itself rather than re-running this selector; if it simply has not mounted yet, '
                  + 'give it longer with `--wait <ms>`'));
  }
  const at = { x: pt.x, y: pt.y };
  await tcdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 });
  await tcdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 });
  // `by` rides along ONLY when the center was covered — so a clear target's output is byte-for-byte what it
  // was before the probe points existed, and a caller that sees `centerObscuredBy` learns a banner is sitting
  // on the control it just clicked without the click having failed. `repositioned` is the same shape of
  // signal for the recheck: absent on an ordinary click, and on a page that shifted it says how many times
  // the verb had to re-aim before it was willing to press.
  return { x: Math.round(pt.x), y: Math.round(pt.y), fx: pt.fx,
           ...(pt.alt ? { alt: true } : {}), ...(pt.forced ? { forced: true } : {}), ...(pt.by ? { by: pt.by } : {}),
           ...(pt.repositioned ? { repositioned: pt.repositioned } : {}) };
}

// ---------------------------------------------------------------------------------------
// CLICK EFFECT — "did the click DO anything?", not "did the click dispatch?"
// ---------------------------------------------------------------------------------------
// THE FAILURE THIS EXISTS FOR: a trusted click can land on the right element at the right coordinates and
// still be a semantic NO-OP, because the SITE's own handler ignored it. Measured on a live site: three clicks
// on a submit button, three exit-0 `{clicked,raw:true,at:{x,y}}` results, and nothing happened server-side. Every guard rawClick
// already carries — actionability, the settled coordinates, the obscured hit test — answers a question one step
// earlier than the one the caller actually has. They prove the click was DELIVERED. Nothing proved it was
// RECEIVED.
//
// THE SIGNAL, and why this one. A MutationObserver over the whole document (childList + attributes +
// characterData + subtree) is the most SENSITIVE cheap thing available: a coarse fingerprint (node count,
// title, a hash of some region) is blind to the changes a click most often makes — a class toggled, a
// textContent rewritten, an attribute flipped — all of which keep the node count identical. Sensitivity is
// the property that matters here, because the expensive error is a FALSE "unchanged" (an agent re-clicks, or
// worse, reports a real action as failed), while a false "changed" only costs a caller one look.
// Navigation is covered separately: the observer dies with its document, so a document stamp (`tok`) turns
// "my observer is gone" into positive evidence rather than a hole — that catches both a cross-document
// navigation and a same-url reload, neither of which a mutation count can see.
//
// AMBIENT CHURN, split off WITHOUT clock arithmetic. A page with a ticking clock or a spinner mutates whether
// or not you click it, so a bare "any mutation ⇒ changed" would go green on anything. The counter is therefore
// read TWICE: once in the LAST ROUND TRIP BEFORE THE MOUSE PRESS, and once after. Anything counted before the
// dispatch is ambient BY CONSTRUCTION, no timestamps compared across two processes.
// WHICH round trip that is moves with the pre-press recheck: with the recheck armed (the default) it is the
// recheck's own eval, which runs AFTER the mouseMoved — so a page that reflows on hover has those mutations
// counted as AMBIENT, where before they were credited to the click. That is the honest attribution: the
// mouseMoved provoked them, not the press. With --no-recheck the reading stays in the actionability eval,
// exactly where it always was. Either way it costs no extra eval of its own. A non-zero pre-count is reported as `effectAmbient:true`: the verb still answers, and the
// caller is told the answer is weak evidence on this page rather than being handed a confident lie.
//
// WHAT IT CANNOT CATCH, stated because a signal that lies is worse than no signal:
//   • a purely SERVER-SIDE effect with no page change — a form POST whose page never re-renders reads
//     `unchanged` while the server did the work. `--expect` cannot help either; only the server can answer.
//   • an effect slower than the wait window (EFFECT_MS, default 400ms) — that is `--expect` with its own
//     multi-second budget, or a follow-up read.
//   • a change made by something OTHER than this click that lands inside the window ⇒ a false `changed`.
// So: `changed` is evidence, `unchanged` is a WARNING, and neither is a verdict. The verb exits 0 either way
// (a click whose effect is genuinely invisible is not an error), and only an explicit --expect is fatal.
const EFFECT_KINDS = ['url-contains', 'appears', 'disappears', 'text', 'value-changes'];
// Parsed once in the dispatcher so a typo costs neither a CDP connect nor a minted tab. Split at the FIRST
// colon only: every kind name is colon-free, while the VALUE routinely is not ("https://", "button:hover").
function parseExpect(raw) {
  const i = String(raw).indexOf(':');
  const kind = i < 0 ? String(raw) : String(raw).slice(0, i);
  if (i < 0 || !EFFECT_KINDS.includes(kind))
    die('--expect takes <kind>:<value>, one of ' + EFFECT_KINDS.join(' · ') + ' — got "' + raw + '".'
      + '\n  e.g. --expect url-contains:/inbox · --expect appears:.toast-success · --expect disappears:#spinner'
      + '\n       --expect text:"Message sent" · --expect value-changes:#total'
      + '\n  (NOT --expect-url, which is a different flag: that one guards which tab you are on BEFORE the verb '
      + 'acts. This one asserts a page change AFTER the click.)');
  const value = String(raw).slice(i + 1);
  if (!value) die('--expect ' + kind + ': needs a value after the colon');
  return { kind, value, raw: String(raw) };
}

// The predicate, as an in-page expression. ONE definition, used at BOTH ends — armed reading and post-click
// reading — so "already true" and "true now" can never drift apart into two subtly different tests. Nothing
// but a boolean ever comes out of it: `text:` and `value-changes:` do their comparison IN THE PAGE, so neither
// page text nor a field value crosses the CDP boundary.
const predJS = (pred) => (!pred ? 'false' : `(function(){
  ${pred.kind === 'url-contains' ? `return location.href.indexOf(${JSON.stringify(pred.value)})>=0;` : ''}
  ${pred.kind === 'appears' ? `return !!__bq(${JSON.stringify(pred.value)});` : ''}
  ${pred.kind === 'disappears' ? `return !__bq(${JSON.stringify(pred.value)});` : ''}
  ${pred.kind === 'text' ? `var t=(document.body&&(document.body.innerText||document.body.textContent))||'';
                            return t.indexOf(${JSON.stringify(pred.value)})>=0;` : ''}
  ${pred.kind === 'value-changes' ? `var s=window.__brFx; if(!s) return false;
                            var e=__bq(${JSON.stringify(pred.value)});
                            return !!e && String(e.value==null?'':e.value)!==s.v0;` : ''}
})()`);

// Arm the observer + take the before-reading. `tok` stamps the document so a REPLACED document is detectable.
// value-changes is the only kind needing a before-VALUE, and it is the only one that can touch a credential:
// a password/autofill-marked field is refused outright, because "did this value change" on a value you do not
// know is a comparison oracle on a credential — the same line get-values and login-state already hold. For an
// ordinary field the value stays in the page (where it already was) and only a boolean ever crosses out.
// `met0` — WAS THE PREDICATE ALREADY TRUE BEFORE THE CLICK? Without it --expect reproduces the exact false
// confidence it exists to remove: `--expect appears:.toast` on a page where a toast is already standing is
// met the instant the click lands, and proves nothing about the click. Reported as `expectAlready`.
const effectArmJS = (tok, pred) => `(function(){${RESOLVE_JS}
  try{
    var w=window;
    if(w.__brFx&&w.__brFx.obs){try{w.__brFx.obs.disconnect()}catch(e){}}
    var st={tok:${JSON.stringify(tok)},n:0,obs:null,v0:null};
    ${pred && pred.kind === 'value-changes' ? `
    var ve=__bq(${JSON.stringify(pred.value)});
    if(!ve) return {ok:false,why:'no-such-field'};
    if(!('value' in ve)) return {ok:false,why:'not-a-field'};
    if((ve.type||'').toLowerCase()==='password') return {ok:false,why:'credential-field'};
    try{ if(ve.matches(${JSON.stringify(AUTOFILL_SELECTOR)})) return {ok:false,why:'credential-field'}; }catch(e){}
    st.v0=String(ve.value==null?'':ve.value);` : ''}
    st.obs=new MutationObserver(function(recs){ st.n+=recs.length; });
    st.obs.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
    w.__brFx=st;
    var met0=false; ${pred ? `try{ met0=!!${predJS(pred)}; }catch(e){}` : ''}
    return {ok:true,url:location.href,met0:met0};
  }catch(e){ return {ok:false,why:String((e&&e.message)||e)} }
})()`;

// One post-click reading: the automatic signal AND (when asked) the predicate, in a single round trip so a
// poll costs one eval rather than two.
// `vis` rides along for free and is what the ACTIVATION RECOVERY below decides on. It is read HERE rather
// than in an eval of its own precisely so that the common path — a click that worked — never pays for it.
const effectReadJS = (tok, pred) => `(function(){${RESOLVE_JS}
  var w=window,s=w.__brFx;
  var o={url:location.href, vis:(function(){try{return document.visibilityState}catch(e){return null}})(),
         gone:!(s&&s.tok===${JSON.stringify(tok)}), n:(s&&s.tok===${JSON.stringify(tok)})?s.n:-1};
  ${pred ? `try{ o.met=!!${predJS(pred)}; }catch(e){ o.met=false; o.metErr=String((e&&e.message)||e); }` : ''}
  return o;
})()`;

const effectDisarmJS = `(function(){try{var s=window.__brFx; if(s&&s.obs) s.obs.disconnect();
  try{delete window.__brFx}catch(e){window.__brFx=undefined} }catch(e){} return 1;})()`;

// ---- ACTIVATION RECOVERY -----------------------------------------------------------------------------------
// A BACKGROUNDED TAB CAN SWALLOW A PERFECTLY DELIVERED INTERACTION, AND NOTHING BUT THE EFFECT SIGNAL SHOWS IT.
// Chromium reports document.visibilityState === 'hidden' for every tab that is not the foreground tab of its
// window, and a page whose handler is gated on that value simply does not run. Measured on a sign-in
// identifier page — which carries NO <form> element at all, so submission is pure JS and a plain Enter has
// nothing to submit either. Four attempts on one tab (click by CSS selector, click --ref from a snapshot,
// press-key Enter in the field) were each dispatched correctly and each did nothing, on a page whose every
// other reading was healthy: readyState complete, hasFocus true, the field holding its value, the button not
// disabled, the hit test clear, exit 0. Target.activateTarget flipped it to 'visible' and the very next
// IDENTICAL click advanced to the password page, first try.
// That is the worst shape a bug can have: it wears the costume of a broken selector, and sends the caller off
// debugging the wrong thing.
//
// WHY NOT SIMPLY ACTIVATE BEFORE EVERY INTERACTION — the obvious fix, and it is wrong here. This browser is
// MULTIPLAYER: several agent sessions drive their own tabs concurrently and a human may be watching the screen.
// Activation is GLOBAL — one foreground tab per window — so an unconditional activate would have sessions
// yanking the screen away from each other all day, and from the human. The cost has to be paid only by the
// pages that actually need it.
// SO: RECOVER, DO NOT PREVENT. The detection already exists (effect:"unchanged"); what was missing was a
// remedy. On a measured no-effect the tab is activated and the interaction is tried once more. Costs nothing
// on the common path — a click that works never reaches this code — and disturbs the foreground only after
// something has already failed.
//
// THREE CONDITIONS, ALL REQUIRED, and the third is the one that makes the "does not steal the foreground"
// property provable rather than asserted:
//   1. the effect signal was actually taken (armed, not stalled, not --no-effect),
//   2. it read `unchanged` — NOTHING happened, not "something happened but not what --expect asked for". A
//      page that reacted to the click has already proved it is listening, and re-pressing it would be a
//      second real interaction on a page that took the first one.
//   3. document.visibilityState === 'hidden'. Activating a tab that is ALREADY in front cannot possibly help,
//      so a page that ignores clicks for any other reason gets no second press and costs nobody the screen.
//
// SETTLE FIRST, PRESS SECOND — the step that is not in the obvious design, and it earns its place. Chromium
// FREEZES requestAnimationFrame and throttles timers in a background tab, so a handler may genuinely have RUN
// while the DOM write it queued never executed. Activating alone can therefore flush the effect with no second
// press at all. The already-armed observer is re-read for one short window before anything is pressed again,
// which is both faster on that class of page and, more importantly, halves the exposure to the hazard below.
//
// THE HAZARD, NAMED RATHER THAN PAPERED OVER: a click whose effect is purely SERVER-SIDE reads `unchanged`
// while the server did the work (limit (1) of the effect signal, and no browser can answer it). Retrying such
// a click FIRES IT TWICE. That is the price of this feature, it is real, and `--no-activate-retry` is the
// answer for a non-idempotent action. It is nonetheless the right default: the class it recovers is silent and
// sends the caller off debugging the wrong thing, while the class it can double-fire is rare (a working submit
// almost always navigates or moves something) and is already flagged in the docs as the case where a caller
// must state `--expect` or read the server themselves.
//
// THE FOREGROUND IS LEFT ACTIVATED on a session tab — deliberately, and against the reflex to tidy up. A page
// that needed visibility for THIS step needs it for the next one too (a multi-step sign-in needs it at every step),
// so restoring would buy one flicker back and pay five more, one per step, each with a wasted failed
// interaction in front of it. Restoring is itself a foreground change, so it does not restore quiet, it
// DOUBLES the disturbance. The exception is an EPHEMERAL --new/anon tab, which is closed at the end of this
// very call and therefore has no next step to need it: there the foreground IS handed back, through the same
// restoreForeground helper the screenshot and save-page paths use.
// It is always RECORDED — `activated:true`, plus `recoveredBy` naming which half worked. A page that needs its
// tab in front is a durable fact about that page, worth learning once; silently papering over it teaches
// nobody, and the caller cannot see the foreground move.
const ACTIVATE_RETRY = !flags.noActivateRetry;

// Activate `targetId` and hand the foreground back only for a throwaway tab (see above). Returns true if the
// activation itself succeeded — everything else is fail-soft, because a recovery that cannot be attempted must
// leave the verb exactly as it was, never turn a landed interaction into an error.
async function activateForRecovery(browser, targetId, ephem) {
  const prevFront = ephem ? await frontmostTargetId() : null;
  try { await browser.send('Target.activateTarget', { targetId }, 5000); }
  catch (_) { return { ok: false, restore: null }; }
  return { ok: true, restore: prevFront };
}

// ONE measurement window over an ALREADY-ARMED observer. A top-level function rather than straight-line code
// inside the click verb for two reasons: the activation recovery re-runs THIS ALONE first (the settle step,
// before it is willing to press anything a second time), and press-key's Enter recovery reads the same signal
// off the same observer, so the two verbs cannot drift into two subtly different ideas of "nothing happened".
async function watchEffect(tcdp, pred, tok, before, preN, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let eff = 'unchanged', by = null, met = false, last = null, stalled = false;
  for (;;) {
    let r = null;
    const readT0 = Date.now();
    try { r = (await evalInTarget(tcdp, effectReadJS(tok, pred), EFFECT_EVAL_MS)).value; }
    catch (e) {
      // TWO different failures wear the same shape here, and calling them both 'navigation' would be a lie in
      // the direction that matters. A CDP ERROR (context destroyed / no such context) means the document went
      // away under us — only a navigation or a reload does that, so it IS the change we are measuring. A
      // TIMEOUT means the renderer stopped ANSWERING, which is what a JS dialog raised by the click does: the
      // page is still there, still ours, and we simply cannot see it. That one is "could not tell", never
      // "changed" — reporting a frozen tab as a successful navigation is exactly the false success this whole
      // feature exists to remove.
      if (/timed out/.test(String(e && e.message))) { stalled = true; break; }
      r = { gone: true, url: null, n: -1, met: false, ctxLost: true };
    }
    // A READ THAT OVERRAN ITS OWN CAP IS NOT AN ANSWER, however healthy its payload looks. Measured: 4 of 12
    // probe runs against an 8s renderer freeze: the read came back CLEAN after the full
    // 8s and the verb reported effect:"unchanged" — a confident "nothing happened" about a window in which
    // the tab could not be seen at all. Passing EFFECT_EVAL_MS to evalInTarget is evidently not sufficient on
    // its own (why the CDP-level timer does not always fire here is NOT yet understood, and this guard does
    // not pretend to explain it — it measures the elapsed time itself and refuses to trust a read that took
    // longer than the cap it asked for). Deliberately unconditional, including when the read reports a
    // change: across an unobservable 8-second gap, nothing can be attributed to this click.
    const readMs = Date.now() - readT0;
    if (readMs > EFFECT_EVAL_MS) { stalled = true; break; }
    last = r = r || {};
    if (eff === 'unchanged') {
      if (r.gone) { eff = 'changed'; by = 'navigation'; }
      else if (r.url !== before.url) { eff = 'changed'; by = 'url'; }
      else if (r.n > preN) { eff = 'changed'; by = 'dom'; }
      // NO title check, deliberately: `document.title = x` rewrites the <title> element's text node, which the
      // observer already counts as a DOM mutation. A separate title comparison would be dead code pretending to
      // add coverage. `history.pushState` is the one change with no mutation at all, and `url` above catches it.
    }
    if (pred && r.met) met = true;
    // Stop as soon as the question is answered: with --expect that is the predicate (the effect signal is a
    // by-product), without it the first sign of any change. So a click that works pays ~one round trip and
    // only a genuine no-op pays the whole window — the case worth waiting on.
    if (pred ? met : eff === 'changed') break;
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  return { eff, by, met, last, stalled, waited: Math.max(0, Date.now() - (deadline - budgetMs)) };
}

// The click verb's whole body: arm → rawClick → poll → (recover) → disarm. Everything is FAIL-SOFT around the
// click itself, which must behave exactly as it did before this existed: an observer that cannot be armed, a
// page that will not answer the read, a context destroyed by the very navigation we are measuring — none of
// those may turn a landed click into an error. They report effect:null (could not tell) and exit 0.
// The one deliberate exception is --expect, which the CALLER asked to be held to: not met is exit non-zero
// with empty stdout, matching --expect-url and `get-values ==expected`. A caller who states what success
// looks like has said the run should stop when it does not happen, and an agent that reads exit codes and
// not JSON is precisely who this feature is for.
// `act` is the activation recovery's context ({browser,targetId,ephemeral,enabled}); omit it and the function
// runs with no recovery at all.
async function clickWithEffect(tcdp, target, pred, expectMs, wantEffect, force, act) {
  const measuring = !!(wantEffect || pred);
  const watch = (tok, before, preN, budgetMs) => watchEffect(tcdp, pred, tok, before, preN, budgetMs);

  // ONE full attempt: arm a fresh observer, press, measure. The recovery runs this a SECOND time, and the two
  // passes are identical in every respect but the token — a retry that pressed differently from the original
  // would not be measuring the thing that failed.
  const attempt = async () => {
    const tok = 'fx' + Math.random().toString(36).slice(2, 10);
    let before = null;
    if (measuring) {
      try { const r = await evalInTarget(tcdp, effectArmJS(tok, pred), EFFECT_EVAL_MS); before = r.value || null; }
      catch (e) { before = { ok: false, why: String(e.message || e) }; }
      // A refused predicate is the caller's error, not a soft one — fail BEFORE clicking, so a credential
      // comparison or a typo'd selector never costs a real click on a real page.
      if (before && before.ok === false && pred) {
        if (before.why === 'credential-field')
          die('--expect value-changes: refuses a password/autofilled field (' + pred.value + ') — "did this value '
            + 'change" on a value you do not know is a comparison oracle on a credential. Assert the EFFECT of the '
            + 'submit instead: --expect appears:<the post-login element> or --expect url-contains:<the landing url>');
        if (before.why === 'no-such-field' || before.why === 'not-a-field')
          die('--expect value-changes: "' + pred.value + '" '
            + (before.why === 'no-such-field' ? 'matches no element' : 'is not a value-bearing field') + ' on this page');
      }
    }
    // …and if the press itself throws (not clickable, obscured, absent) the observer we just armed must not be
    // left running on the page. It used to be, and the leak was invisible only because the next click's arm
    // disconnects any previous one — on a page nobody clicks again it just kept counting. Fail-soft in turn:
    // a disarm that cannot run must not replace the real error with its own.
    let at;
    try { at = await rawClick(tcdp, target, null, force); }  // unchanged: throws on not-clickable/obscured, as always (unless --force)
    catch (e) {
      if (measuring && before && before.ok) await evalInTarget(tcdp, effectDisarmJS, EFFECT_EVAL_MS).catch(() => {});
      throw e;
    }
    // --no-effect ⇒ nothing was measured, so say nothing: the output is byte-for-byte the plain-click shape.
    // An ATTEMPTED measurement that could not be armed is different, and reports effect:null — could not tell.
    if (!measuring) return { at, armed: false };
    if (!(before && before.ok)) {
      // …but a caller who passed --expect must never be handed a silent exit 0 here. An unarmed page means the
      // predicate was never evaluated, and quietly dropping a stated expectation is the same false success this
      // whole feature exists to remove — one level up.
      if (pred) die('click: --expect ' + pred.raw + ' could not be set up on this page'
        + (before && before.why ? ' (' + before.why + ')' : '') + ' — the click LANDED, but the expectation was '
        + 'never evaluated, so this is neither a pass nor a fail. Re-read the page and check it yourself');
      return { at, armed: false };
    }
    // The pre-click count. rawClick reads it in the LAST round trip before the press — the pre-press recheck's
    // eval by default, or its settled actionability eval under --no-recheck; -1 means that eval could not see the
    // observer (a frame swap between arming and the hit test), in which case fall back to 0 — a page that mutated
    // in that window then reads as "changed", which errs toward reporting rather than toward a false all-clear.
    const preN = at.fx >= 0 ? at.fx : 0;
    return { at, armed: true, tok, before, preN, ...(await watch(tok, before, preN, pred ? expectMs : EFFECT_MS)) };
  };

  let a = await attempt();
  // NOTHING AT ALL HAPPENED — the only state the recovery acts on. `eff === 'changed'` with an unmet predicate
  // is deliberately excluded: that page IS listening, and a second press on it would be a second real click.
  const noEffect = (x) => x.armed && !x.stalled && x.eff === 'unchanged' && !(pred && x.met);
  let activated = false, recoveredBy = null, recoverFailed = null;
  if (act && act.enabled && noEffect(a) && a.last && a.last.vis === 'hidden') {
    const act1 = await activateForRecovery(act.browser, act.targetId, act.ephemeral);
    if (act1.ok) {
      activated = true;
      // SETTLE: the observer from attempt 1 is still armed and still counting, so re-reading it costs no arm
      // and no press. A background tab has rAF frozen and its timers throttled, so the handler may already
      // have run and simply not written yet — this is where that page answers, without a second interaction.
      const s = await watch(a.tok, a.before, a.preN, EFFECT_MS);
      if (!s.stalled && (pred ? s.met : s.eff === 'changed')) { a = { ...a, ...s }; recoveredBy = 'activate-settle'; }
      // A RETRY THAT CANNOT BE DISPATCHED MUST NOT DESTROY THE FIRST CLICK, WHICH DID LAND. rawClick throws on
      // absent / not-clickable / obscured, and ACTIVATION ITSELF can cause all three: a page that only mounts
      // its content on becoming visible, a bubble Chromium draws when a tab comes to the front. Letting that
      // throw propagate would turn an exit-0 `unchanged` into a hard failure purely because we tried to help —
      // the exact opposite of the fail-soft contract the rest of this function holds, and a REGRESSION against
      // the behavior before the recovery existed. So keep attempt 1's result, still say the tab was
      // activated, and NAME why the retry did not happen rather than swallowing it into silence.
      else {
        let b = null;
        try { b = await attempt(); } catch (e) { recoverFailed = errText(e).replace(/\s+/g, ' ').slice(0, 160); }
        if (b) { a = b; if (a.armed && !a.stalled && !noEffect(a)) recoveredBy = 'activate-retry'; }
      }
      if (act1.restore) await restoreForeground(act.browser, act1.restore, act.targetId);
    }
  }
  const { at, armed, eff, by, met, last, stalled, waited } = a;
  // `activated` rides along on EVERY path from here down, the failure ones included — the foreground MOVED,
  // and a caller reading a die() message or an effect:null still needs to be told that.
  const actOut = activated ? { activated: true, ...(recoveredBy ? { recoveredBy } : {}),
                               ...(recoverFailed ? { recoverFailed } : {}) } : {};
  if (!armed) return measuring ? { at, effect: null, ...actOut } : { at };

  // Nothing to disarm through a destroyed document, and nothing to be gained by spending another 2s against a
  // renderer that has already proved it will not answer. RESIDUAL, stated rather than hidden: a stalled page
  // therefore keeps its observer until either the next click re-arms (effectArmJS disconnects any previous one
  // first) or the document goes away. That is a counter incrementing on a page nobody is reading — cheap, and
  // strictly better than blocking the verb for another two seconds to tidy up after a frozen renderer.
  if (!stalled && !(last && last.gone)) await evalInTarget(tcdp, effectDisarmJS, EFFECT_EVAL_MS).catch(() => {});
  if (stalled) {
    if (pred) die('click: --expect ' + pred.raw + ' could not be evaluated — the click landed, but the renderer '
      + 'STOPPED ANSWERING immediately afterwards. A JS dialog raised by the click does exactly this (alert / '
      + 'confirm / onbeforeunload): the page is still there and still yours, it just cannot be read. Clear it '
      + 'with `browse dismiss-dialog` and re-read the page, rather than re-clicking'
      + (activated ? ' (NOTE: the tab was activated first — the foreground has moved)' : ''));
    return { at, effect: null, ...actOut };   // could not tell — never 'changed'
  }
  if (pred && !met) die('click: --expect ' + pred.raw + ' NOT met after ' + waited + 'ms — the click landed'
    + (eff === 'changed'
      ? ' and the page DID change (' + by + '), but not in the way you asked: check the predicate before assuming the click failed'
      : ' but NOTHING on the page changed either (effect=unchanged): this looks like a semantic no-op — the site'
        + ' ignored the click, or the real control is a different element')
    + (activated
      ? (recoverFailed
        ? '. The tab WAS activated (it was backgrounded, a real cause of a silent no-op) but the click could '
          + 'NOT be re-issued afterwards: ' + recoverFailed
          + '. So the first click landed and this expectation is untested against a visible tab — re-read the page'
        : '. The tab WAS activated and the click re-issued (it was backgrounded, which is a real cause of a silent '
          + 'no-op) and it still did not happen, so the tab is not '
          + 'the reason here')
      : (last && last.vis === 'hidden' && !(act && act.enabled)
        ? '. NOTE the tab is BACKGROUNDED and --no-activate-retry suppressed the activate-and-retry recovery — a '
          + 'visibility-gated page does exactly this'
        : ''))
    + (last && last.metErr ? ' [predicate error: ' + last.metErr + ']' : ''));
  return { at, effect: eff, effectBy: by, effectMs: waited, effectAmbient: at.fx > 0, ...actOut,
           // expectAlready:true ⇒ expectMet says nothing about THIS click, because the condition already held
           // when the click went out. Reported rather than refused: a toast left standing from a previous
           // action is a real page state, and only the caller knows whether "still true" was what they meant.
           ...(pred ? { expect: pred.raw, expectMet: met, expectAlready: !!a.before.met0 } : {}) };
}

// press-key's ENTER-ONLY counterpart of clickWithEffect. Enter in a field was one of the four
// attempts that silently did nothing on the backgrounded sign-in identifier page, and on a page with no <form>
// it IS the submit path — so it needs the same recovery. It gets the same signal, off the same observer,
// through the same watchEffect, so the two verbs can never drift into different ideas of "nothing happened".
// TWO DELIBERATE DIFFERENCES FROM THE CLICK PATH, both named rather than hidden:
//   • ENTER ONLY. The other control keys are excluded at the dispatcher (ACTIVATE_RETRY_VERBS): a Tab that
//     moves focus, an Escape with no dialog to close, an arrow that scrolls — none mutate the DOM, so every
//     one of them would read `unchanged` on a perfectly successful press and take the screen for nothing.
//   • NO `effectAmbient`, and the pre-count is 0. rawPressKey's own focus round trip sits between arming and
//     the keystroke, and there is no hook inside it to read the counter from the way rawClick's recheck gives
//     the click path one. So the window includes the focus, and a page that mutates ON FOCUS reads `changed`
//     here. That is a false `changed`, i.e. it errs toward NOT activating — the safe direction on a browser
//     whose foreground is shared. Buying a true ambient split would cost an extra eval on every press; it is
//     not worth it for a signal whose only consumer is "should I activate".
// Fail-soft throughout, exactly like the click path: an observer that cannot be armed, a page that will not
// answer, a context destroyed by the navigation being measured — none may turn a landed keystroke into an
// error. They report effect:null and exit 0.
async function pressKeyWithEffect(tcdp, target, key, act) {
  const press = async () => {
    const tok = 'fx' + Math.random().toString(36).slice(2, 10);
    let before = null;
    try { const r = await evalInTarget(tcdp, effectArmJS(tok, null), EFFECT_EVAL_MS); before = r.value || null; }
    catch (e) { before = { ok: false, why: String(e.message || e) }; }
    try { await rawPressKey(tcdp, target, key); }   // unchanged: throws on absent/unfocusable, as always
    catch (e) {                                      // …but never leave the observer we just armed running
      if (before && before.ok) await evalInTarget(tcdp, effectDisarmJS, EFFECT_EVAL_MS).catch(() => {});
      throw e;
    }
    if (!(before && before.ok)) return { armed: false };
    return { armed: true, tok, before, ...(await watchEffect(tcdp, null, tok, before, 0, EFFECT_MS)) };
  };

  let a = await press();
  const noEffect = (x) => x.armed && !x.stalled && x.eff === 'unchanged';
  let activated = false, recoveredBy = null, recoverFailed = null;
  if (act && act.enabled && noEffect(a) && a.last && a.last.vis === 'hidden') {
    const act1 = await activateForRecovery(act.browser, act.targetId, act.ephemeral);
    if (act1.ok) {
      activated = true;
      // SETTLE FIRST — a background tab has rAF frozen and its timers throttled, so the handler may already
      // have run and simply not written yet. The observer from the first press is still armed and counting.
      const s = await watchEffect(tcdp, null, a.tok, a.before, 0, EFFECT_MS);
      if (!s.stalled && s.eff === 'changed') { a = { ...a, ...s }; recoveredBy = 'activate-settle'; }
      // …and a retry that cannot be dispatched must not destroy the first keystroke, which DID land — same
      // reasoning as the click path, which carries the full note.
      else {
        let b = null;
        try { b = await press(); } catch (e) { recoverFailed = errText(e).replace(/\s+/g, ' ').slice(0, 160); }
        if (b) { a = b; if (a.armed && !a.stalled && !noEffect(a)) recoveredBy = 'activate-retry'; }
      }
      if (act1.restore) await restoreForeground(act.browser, act1.restore, act.targetId);
    }
  }
  const actOut = activated ? { activated: true, ...(recoveredBy ? { recoveredBy } : {}),
                              ...(recoverFailed ? { recoverFailed } : {}) } : {};
  if (!a.armed || a.stalled) return { effect: null, ...actOut };
  if (!(a.last && a.last.gone)) await evalInTarget(tcdp, effectDisarmJS, EFFECT_EVAL_MS).catch(() => {});
  return { effect: a.eff, effectBy: a.by, effectMs: a.waited, ...actOut };
}

// Raw-CDP file upload. DO NOT REINTRODUCE A PLAYWRIGHT FALLBACK HERE — the one that existed was deleted because
// it was strictly WORSE, not because it was redundant: Playwright only drives DOM.setFileInputFiles when it is
// CO-LOCATED with the browser; over connectOverCDP (how a remote client talks to Chromium) setInputFiles instead
// injected a DataTransfer and dispatched SYNTHETIC input/change events. Measured on a fixture: raw →
// isTrusted:true, that path → isTrusted:false — a hardened/PCI uploader that checks isTrusted silently ignored
// it. Capability differed too: it streamed the file BYTES over the CDP socket and hard-failed past 50 MB
// ("Cannot transfer files larger than 50Mb to a browser not co-located with the server"); this path hands the
// browser a PATH, so it has no ceiling. Falling back on a stubborn upload was exactly what could make it fail.
// Bounded auto-wait and __bq resolution match the other act verbs (shadow roots + <label> retargeting
// included). A DISABLED file input is accepted DELIBERATELY: setInputFiles has no enabled/visible actionability
// check either, and real forms disable the input until a doc type is chosen and then read input.files from JS —
// refusing it would make this path weaker than the one it replaced.
// Fails fast on a missing LOCAL file BEFORE touching the page: a typo'd path must not leave a half-driven form
// (and the path is resolved on the machine running browse.js, never the caller's filesystem).
async function rawUploadFile(tcdp, target, file) {
  const T = asTarget(target), NAME = targetName(T);
  const abs = path.resolve(file);
  // Name the path AS GIVEN when it differs from the resolved one: '~' is deliberately NOT expanded (the path
  // this replaced did not either), and a bare "not found: /root/~/x" reads like a bug in us rather than the
  // unquoted-tilde typo it is.
  if (!fs.existsSync(abs)) throw new Error('local file not found on the box: '
    + (file === abs ? abs : file + ' (resolved to ' + abs + ')'));
  if (!fs.statSync(abs).isFile()) throw new Error('not a regular file: ' + abs);
  const deadline = Date.now() + WAIT_MS;
  let objectId = null, last = 'absent';
  for (;;) {
    // returnByValue:false so a matched element comes back as a NODE HANDLE — DOM.setFileInputFiles needs the
    // objectId, and the read-back below goes through that SAME handle (see the identity check).
    const probe = await tcdp.send('Runtime.evaluate', {
      expression: `(function(){${RESOLVE_JS}
        var el=${elJS(T)};
        if(!el) return 'absent';
        if(el.tagName!=='INPUT'||(el.type||'').toLowerCase()!=='file') return 'nonfile';
        return el;})()`,
      returnByValue: false, awaitPromise: true }, remaining(deadline));
    if (probe.exceptionDetails) throw new Error(exceptionMessage(probe.exceptionDetails));
    const ro = probe.result || {};
    if (ro.subtype === 'node' && ro.objectId) { objectId = ro.objectId; break; }
    // 'nonfile' is a PERMANENT state — a <div> or a text input never becomes an <input type=file>, so polling it
    // just burns the whole wait budget while holding the global flock. Fail out immediately, exactly as
    // rawEnterText does on badtype. Only 'absent' is worth retrying: the element may still be mounting.
    if (ro.value === 'nonfile') { last = 'not an <input type=file>'; break; }
    if (Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  if (!objectId) throw new Error('upload target not usable' + (last === 'absent' ? ' after ' + WAIT_MS + 'ms' : '')
    + ' (' + last + '): ' + NAME);
  await tcdp.send('DOM.setFileInputFiles', { objectId, files: [abs] }, remaining(deadline));
  // READ BACK THROUGH THE SAME HANDLE, and compare the NAME. Both halves are load-bearing: Chromium accepts
  // DOM.setFileInputFiles on a DETACHED node without complaint, so if the page replaced the input between the
  // poll and the write, the file landed on a dead node — and a second __bq lookup would then resolve whatever
  // element now matches (possibly one already holding a DIFFERENT file) and report success while the form
  // submits with no file. this.isConnected proves the node we wrote to is still the one in the document.
  const back = await tcdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: 'function(){ return this.isConnected && this.files && this.files.length ? this.files[0].name : null }',
    returnByValue: true,
  }, remaining(deadline));
  const landed = back && back.result ? back.result.value : null;
  const want = path.basename(abs);
  if (landed !== want) throw new Error(landed == null
    ? 'upload did not land — the input holds no file, or the element was detached from the page before the upload landed: ' + NAME
    : 'upload landed the wrong file — the input holds ' + JSON.stringify(landed) + ', expected ' + JSON.stringify(want) + ': ' + NAME);
  return { name: landed };
}

// Raw-CDP saved-password autofill primitive — the wedge-immune counterpart of the page.click() +
// page.waitForFunction() pair it replaced, and the last act verb to be converted off Playwright.
// WHY THIS IS ONE VERB AND NOT `click` FOLLOWED BY `get-values`: a fire-and-forget click plus an immediate read
// sees an EMPTY field, and an empty-password submit is a failed login attempt (some sites lock after a few). The
// wait-then-verify is baked in so the caller submits only on filled:true.
// IT IS NOT A RACE. It is tempting to think autofill "fills the password field 0.5-2s AFTER a TRUSTED click",
// and that is wrong in a way that invites the wrong fix. Measured: Chromium has ALREADY filled both fields on
// page load, marked :autofill, before any click. What the click supplies is USER ACTIVATION, which is a hard
// GATE on the value being visible to page JS — not a delay. Poll for a minute without a gesture and you read 0
// forever, so a longer timeout is never the fix for an empty read; the fix is a gesture, or the pre-gesture
// proof below, which needs no gesture at all.
// The click DELEGATES to rawClick rather than re-implementing it, and that is load-bearing: rawClick dispatches
// real Input.dispatchMouseEvent coordinates, and only a TRUSTED click fires autofill at all (a synthetic
// el.click() never does) — plus it brings the __bq resolver (shadow roots + <label> retargeting), the bounded
// auto-wait and the obscured-element hit test, so this verb can't "click" a cookie banner and then blame the
// page for not filling.
// NOT FILLED IS A RESULT, NOT AN ERROR: filled:false / length:0 comes back and the caller exits 0 (escalate to
// the human) — and filled is TRI-STATE, because "definitely not filled" and "could not determine" are different
// answers and conflating them is what sends an agent off to fetch the credential by hand. The ONLY failure is a
// target that never resolves to a value-bearing element — a bad selector.
// An absent (or not-yet-value-bearing) target is POLLED for the whole window rather than failed fast, unlike
// rawUploadFile's permanent 'nonfile' state: on these login pages the password field is routinely injected by
// the page's own JS a beat after the click, and the path this replaced waited for it too. It is an error only
// once the window closes with nothing there.
// Timeouts are carried over unchanged from that path: PRESS_TIMEOUT_MS for the click half (what page.click's
// 30s timeout was) and timeoutMs for the fill poll (default 4000, at the same 150ms interval waitForFunction
// used) — expressed as ONE wall-clock deadline for the whole call, like the sibling verbs, so a blocked
// renderer can't hold the global flock for minutes (the connectOverCDP wedge shape). One deliberate divergence:
// it passed timeoutMs straight to waitForFunction, where 0 means NO TIMEOUT — `… 0` would have waited forever
// on a verb whose entire purpose is a bounded wait. Here 0 means one immediate check, which is what it reads as.
// Throws, never die()s: die() is a synchronous process.exit that skips runRaw's catch, stranding an
// ephemeral/--new tab — and stray blank tabs are what wedge this shared box.
// One probe of the target, used both BEFORE the click (the pre-gesture proof) and after the poll gives up (the
// tri-state verdict). Returns {length,autofill,gesture} — length -1 for absent/value-less, autofill true/false/
// null (see AUTOFILL_JS: null = could not determine, never collapse it to false), gesture = has this document
// ever seen a real user activation. NEVER returns the value.
async function rawFillProbe(tcdp, targetSel, deadline) {
  const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}${AUTOFILL_JS}
    var el=__bq(${JSON.stringify(targetSel)});
    var g = (navigator.userActivation && typeof navigator.userActivation.hasBeenActive === 'boolean')
      ? navigator.userActivation.hasBeenActive : null;
    if(!el||typeof el.value!=='string') return { length: -1, autofill: null, gesture: g };
    return { length: el.value.length, autofill: __af(el), gesture: g };})()`, remaining(deadline));
  const v = (r && r.value && typeof r.value === 'object') ? r.value : null;
  if (!v) return { length: -1, autofill: null, gesture: null };   // preview/degraded → treat as absent
  return { length: typeof v.length === 'number' ? v.length : -1,
           autofill: v.autofill === true ? true : (v.autofill === false ? false : null),
           gesture: typeof v.gesture === 'boolean' ? v.gesture : null };
}

async function rawClickAndAwaitFill(tcdp, clickSel, targetSel, timeoutMs, preflight) {
  const deadline = Date.now() + WAIT_MS + timeoutMs;   // WAIT_MS covers the CLICK half; timeoutMs the fill poll
  const t0 = Date.now();

  // ---- PRE-GESTURE PROOF (the preferred path) -------------------------------------------------------------
  // Chromium fills from the saved-password store at PAGE LOAD and marks the field :autofill there and then; it
  // withholds only the VISIBILITY of the value from page JS until a genuine user gesture lands, so a hostile
  // page cannot read an autofilled password the user never touched. So the triple
  //     :autofill == true  &&  .value.length == 0  &&  userActivation.hasBeenActive == false
  // is a STRICTLY STRONGER proof than the non-empty read below: it says the browser filled the field AND the
// value is still invisible to every run-js / get-text / get-values call on this tab. Measured. Report it and
// stop — do not click, do not read.
  // The caller's own trusted click on the SUBMIT button then supplies the activation, and the browser sends the
  // real value from its own side, so it never becomes JS-readable at any point an agent could observe it.
  // WHY THIS MATTERS BEYOND TIDINESS: the old sequence bought its verification by OPENING the hole — the
  // gesture it needed to read .value is the same gesture that unlocks the value for everything that follows.
  // NOT CLICKING IS A BEHAVIOR CHANGE, and it is deliberate: `clicked` comes back null so the caller can SEE
  // the click did not happen. The one case it can bite is a clickSelector whose job went BEYOND unlocking the
// read — e.g. a collapsed login widget the click expands (measured: both fields already
// :autofill while the widget is shut). That fails LOUDLY on the caller's next click, not silently, and
  // --no-preflight forces the click-then-poll path for it.
  if (preflight) {
    const pre = await rawFillProbe(tcdp, targetSel, deadline);
    if (pre.autofill === true && pre.length === 0 && pre.gesture === false)
      return { filled: true, length: 0, proof: 'pre-gesture', autofill: true, gesture: false,
               waitedMs: Date.now() - t0, clicked: null };
  }

  // ---- FALLBACK: the trusted click, then poll .value until non-empty ---------------------------------------
  await rawClick(tcdp, clickSel, WAIT_MS);   // throws with its own 'click: …' detail if it can't land
  const t1 = Date.now();
  const pollUntil = Math.min(t1 + timeoutMs, deadline); // min() keeps the whole call inside the one budget
  // 'absent' | 'empty' | 'filled' — NEVER a length. Computed in-page for the same reason as loginProbe's
  // `empty`: a number that never crosses the CDP boundary cannot end up in a variable, a log line, or an
  // exception message, and a credential's size, once in a node variable, is one `out()` call from stdout.
  let state = 'absent';
  for (;;) {
    const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}
      var el=__bq(${JSON.stringify(targetSel)});
      if(!el||typeof el.value!=='string') return 'absent';
      return el.value.length>0 ? 'filled' : 'empty';})()`, remaining(deadline));
    state = typeof r.value === 'string' ? r.value : 'absent';
    if (state === 'filled') return { filled: true, length: 0, proof: 'post-gesture', waitedMs: Date.now() - t0 };
    if (Date.now() >= pollUntil) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  if (state === 'absent') throw new Error('target selector not found after click (absent, or present but not a '
    + 'value-bearing element) — the click itself DID fire: ' + targetSel);

  // ---- THE POLL CAME BACK EMPTY. That is THREE different answers, and conflating them manufactures leaks. --
  // A naive verb calls all of them filled:false. An agent reads filled:false as "there is no saved password
  // for this site", falls back to fetching the credential from a password store, and types the value by hand —
  // and THAT fetch is the transcript leak. So re-probe and separate them:
  //   autofill true  -> Chromium DID fill the field; the gesture simply never unlocked the read (it landed on
  //                     the wrong element, or on a different frame). filled:true — safe to submit, the browser
  //                     holds the real value. proof:'autofill-marker'.
  //   autofill false -> definitely not filled. filled:false, exactly as before.
  //   autofill null  -> the marker could not be evaluated. filled:null — COULD NOT DETERMINE, never false.
  // filled:null is safe-fail for every caller: `if (r.filled)` treats it as falsy, while `r.filled === false`
  // means what it says.
  const post = await rawFillProbe(tcdp, targetSel, deadline);
  const verdict = post.autofill === true ? { filled: true, proof: 'autofill-marker' }
    : post.autofill === false ? { filled: false, proof: 'none' }
    : { filled: null, proof: 'indeterminate' };
  return { ...verdict, length: 0, autofill: post.autofill, gesture: post.gesture, waitedMs: Date.now() - t0 };
}

// ---- `login <site>` machinery: the gate probe and the post-login signal check ------------------------------
// Two shared in-page helpers, defined once rather than inlined twice: a visibility test, and a password-field
// counter that DESCENDS SHADOW ROOTS. The descent is not defensive dressing — measured on a real sign-in page,
// the whole form is inside web components, so a plain document.querySelectorAll('input[type=password]')
// counts ZERO on a page that is nothing but a login form, and the verb would report NO_FORM on a live form.
const VIS_JS = `function __vis(el){ try{ var b=el.getBoundingClientRect(); if(!b.width||!b.height) return false;
  var cs=getComputedStyle(el); return cs.visibility!=='hidden'&&cs.display!=='none'; }catch(e){ return false; } }`;
const PWCOUNT_JS = `function __pwCount(){ var n=0, v=0;
  (function walk(root,d){ if(d>8) return; var all=root.querySelectorAll('*');
    for(var i=0;i<all.length;i++){ var el=all[i];
      if(el.tagName==='INPUT'&&(el.type||'').toLowerCase()==='password'){ n++; if(__vis(el)) v++; }
      if(el.shadowRoot) walk(el.shadowRoot,d+1); } })(document,0);
  return {all:n, vis:v}; }`;

// THE GATE PROBE. Returns booleans and COUNTS OF FIELDS only — never a value, and never a value's LENGTH.
// `empty` is computed IN-PAGE for the same reason get-values withholds in-page: a number that never crosses the
// CDP boundary cannot end up in a variable, a log line, or an exception message. A caller learning "the field
// holds 12 characters" learns something about a credential; "the field is empty" is the entire signal the gate
// needs, and it discloses nothing.
async function loginProbe(tcdp, pwSel, deadline) {
  const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}${AUTOFILL_JS}${VIS_JS}${PWCOUNT_JS}
    var txt=0, textPw=0;
    (function walk(root,d){ if(d>8) return; var all=root.querySelectorAll('*');
      for(var i=0;i<all.length;i++){ var el=all[i];
        if(el.tagName==='INPUT'){
          var t=(el.type||'').toLowerCase();
          if(t!=='password'){
            if(__vis(el)&&(t===''||t==='text'||t==='email'||t==='tel')) txt++;
            // a field NAMED like a password but typed as something else — Chromium refuses to autofill it
            if(/pass|pwd/i.test((el.name||'')+' '+(el.id||''))) textPw++; } }
        if(el.shadowRoot) walk(el.shadowRoot,d+1); } })(document,0);
    var el=__bq(${JSON.stringify(pwSel)});
    var g=(navigator.userActivation&&typeof navigator.userActivation.hasBeenActive==='boolean')
      ? navigator.userActivation.hasBeenActive : null;
    return { pw:__pwCount(), txt:txt, textPw:textPw, gesture:g,
             target: el ? { hasValue: typeof el.value==='string',
                            isPassword: String((el.type||'')).toLowerCase()==='password',   // String(): see __ty
                            empty: typeof el.value==='string' ? el.value.length===0 : null,
                            autofill: __af(el), vis: __vis(el) } : null };})()`, remaining(deadline));
  const v = (r && r.value && typeof r.value === 'object') ? r.value : null;
  if (!v) throw new Error('could not read the entry page (the probe did not serialize) — the page may not have rendered');
  return v;
}

// THE POST-LOGIN SIGNAL. Every condition the registry declares must hold; `urlContains`/`titleContains` accept a
// LIST and any one member satisfies them (a site with more than one legitimate landing page — e.g. a dashboard
// and an account-picker — is normal). Evaluated in-page and reported as the registry's OWN strings, so the
// output can name what matched without ever echoing a live url (which can carry a token in its query).
async function loginSignalCheck(tcdp, sig, deadline) {
  const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}${VIS_JS}${PWCOUNT_JS}
    var sig=${JSON.stringify(sig)}, out={};
    function arr(v){ return v===undefined?null:(Array.isArray(v)?v:[v]); }
    function hit(list, hay){ if(!list) return undefined; for(var i=0;i<list.length;i++) if(hay.indexOf(list[i])>=0) return list[i]; return null; }
    var u=arr(sig.urlContains);   if(u) out.urlContains   = hit(u, location.href);
    var t=arr(sig.titleContains); if(t) out.titleContains = hit(t, document.title||'');
    if(sig.selector!==undefined) out.selector = __bq(sig.selector) ? sig.selector : null;
    if(sig.noPasswordFields===true) out.noPasswordFields = (__pwCount().all===0) ? true : null;
    return out;})()`, remaining(deadline));
  const m = (r && r.value && typeof r.value === 'object') ? r.value : null;
  if (!m) return { ok: false, matched: null };
  // null = that condition did NOT hold. Every declared condition must be satisfied — an AND, never a best-effort.
  return { ok: Object.values(m).every((x) => x !== null && x !== undefined), matched: m };
}

// Every failure message has the same shape, carries a greppable CAUSE=, and ENDS THE PATH. The closing clause is
// not boilerplate: the measured failure mode is an agent reading a negative result as "there is no saved
// password here", fetching the credential from a password store, and typing it — and THAT fetch is the
// transcript leak. So the message that reports a failure is also the message that forecloses the fallback.
const loginErr = (site, cause, detail) => site + ': CAUSE=' + cause + ' — ' + detail
  + ' — report this cause code and STOP: do NOT fetch the credential, and do not type one. If this site needs '
  + 'to work, fix its registry entry (or the site is genuinely unfillable and needs a human).';

// ---- `login-state`: is a human actually needed on THIS page? -----------------------------------------------
// THE BUG THIS EXISTS TO KILL. An agent lands on a sign-in page, sees the words "sign in", does not inspect
// the form, concludes "SSO login is a human step", and hands the operator a manual login — when the form was
// ALREADY FILLED (email and password both holding values, remember-me ticked) and a single click on the submit
// button would have signed it in. The agent was one click from done and escalated instead.
// The generalisable failure is not "it misread that page": it is that "I did not look" defaulted to "ask the
// human". So the fix is a verb that LOOKS, and whose only human-shaped answer is a narrow, named one.
//
// WHY THIS IS A SEPARATE VERB FROM `login <site>`, and not an extension of it:
//   `login` answers "sign me into this ENROLLED site" — it navigates to a registry entry url and SUBMITS. It
//   cannot answer "I am already on a page; what IS this?", which is the question that was mishandled. Nor is
//   the answer always a login: LOGGED_IN is a perfectly common verdict, and `login` has no way to say it about
//   a tab it did not navigate itself.
// AND WHY IT NEVER SUBMITS. `login` stays the ONLY verb that puts a credential on the wire, so the whole
//   no-credential property keeps one enforcement point. login-state classifies and hands back the SELECTOR of
//   the submit control it found; the caller clicks it with `browse click` (a trusted click that reads nothing),
//   or runs `browse login <site>` if the site is enrolled. Two verbs, one submitting.
//
// THE FOUR VERDICTS. The fourth is the point of the whole exercise:
//   LOGGED_IN            an authenticated page — a sign-out control is present and no sign-in form is.
//   SIGN_IN_SELF_SERVE   a submittable credential form whose values are THERE (readable, or proven present by
//                        the pre-gesture triple). The agent finishes this itself. No human.
//   SIGN_IN_HUMAN        the ONLY verdict that may ever be handed to the operator. Four narrow causes, below.
//   UNRESOLVED           could not tell. NOT a synonym for "ask the human" — that conflation IS the bug. It
//                        carries a `remedy` naming the next thing to try (--resolve, a fresh tab, `login
//                        <site>`), so an agent that hits it has somewhere to go that is not the operator.
//
// THE HUMAN CAUSES, deliberately narrow — anything not on this list is not a human's job:
//   CAPTCHA          a bot wall is rendered (recaptcha/hcaptcha/turnstile/arkose/geetest/px).
//   SECOND_FACTOR    an OTP field or an app-push prompt: it needs a real phone.
//   CHOOSER          an account-chooser with no password form — pick-an-account rows, or the SSO IdP's own
//                    picker. (Chromium's NATIVE saved-password picker is browser UI and INVISIBLE to CDP, so
//                    it can never be detected here — it stays declared in the login registry. Stated in the
//                    output's `limits` so a caller does not read a clean probe as proof there is no picker.)
//   SSO_ONLY         every credential path on the page is a third-party IdP button and there is NO password
//                    form beside them. A page with BOTH is SELF_SERVE — getting that distinction backwards is
//                    what costs the operator a needless manual login.
//   TWO_STEP         a username-first step: no password field, and nothing here supplies the username.
//
// SCOPE LIMIT, reported rather than hidden: main frame only, like every other raw verb. A login form inside a
// CROSS-ORIGIN iframe is a separate CDP target and is unreachable, so the probe would see an empty page and
// could say UNRESOLVED on a live form. The count of cross-origin iframes rides along in the evidence and turns
// an otherwise-empty verdict into UNRESOLVED naming that as the reason.
const LOGINSTATE_PATTERNS = {
  // Bot walls. Matched on iframe src, on the widget containers each vendor injects, and on the wording their
  // interstitials use — a vendor can be present as any one of the three.
  captchaSrc: /recaptcha|hcaptcha|turnstile|arkoselabs|funcaptcha|geetest|captcha-delivery|perimeterx/i,
  captchaSel: '.g-recaptcha, .h-captcha, .cf-turnstile, #px-captcha, #cf-challenge-running, [data-sitekey], iframe[title*="recaptcha" i], iframe[title*="challenge" i]',
  captchaText: /are you (a )?(human|robot)|verify (that )?you('| a)?re human|unusual traffic|complete the (security )?check/i,
  // A second factor. The autocomplete token is the reliable half; the name/id and wording halves catch the
  // sites that never set it.
  otpSel: 'input[autocomplete="one-time-code"]',
  otpName: /(^|[^a-z])(otp|mfa|2fa|totp|passcode|authcode)([^a-z]|$)|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|authenticator/i,
  otpText: /(approve|confirm|check).{0,40}(notification|push|phone|app|authenticator)|enter the (6|six)[- ]digit|two[- ]?factor|verification code (was )?sent|we (sent|texted)/i,
  // An account chooser. The DOM half (Google/Okta render selectable identity rows) plus the wording half.
  chooserSel: '[data-identifier], [data-email], #accountchooser, .account-chooser, [aria-label*="Choose an account" i]',
  chooserText: /choose an account|pick an account|select an account|use another account|continue as /i,
  // A third-party identity provider. Deliberately broad: it is EVIDENCE, and it only decides a verdict on its
  // own in the SSO_ONLY branch, which additionally requires that the page has no password field at all.
  sso: /google|microsoft|azure|office ?365|okta|onelogin|auth0|ping ?(id|federate)|saml|shibboleth|apple|facebook|github|single[- ]sign|sso|oauth|openid/i,
  // A sign-out control — the positive evidence for LOGGED_IN. "No password field" alone proves nothing (every
  // marketing page in the world has no password field), so a verdict of LOGGED_IN requires seeing this.
  logout: /log[\s_-]?out|sign[\s_-]?out|logoff|log[\s_-]?off|sign[\s_-]?off/i,
  // Username-first / continue steps, for telling TWO_STEP from a page that merely has a search box.
  nextText: /next|continue|proceed|log ?in|sign ?in|submit/i,
  userName: /user|email|login|account|identifi|^id$/i,
};
// The in-page probe. Returns BOOLEANS, COUNTS, SELECTORS and short control LABELS — never a field value, and
// never a value's LENGTH. The length rule is loginProbe's, adopted deliberately: a caller learning "the
// password field holds 12 characters" learns something about a credential, and "it holds a value" is the whole
// signal a classifier needs. No verb in this file discloses a credential's size.
// Every selector it hands back is UNIQUENESS-CHECKED in-page before being reported: a selector that matches two
// elements is worse than none, because the caller would click one of them and not know which.
const LOGINSTATE_JS = `
var __P=${JSON.stringify(Object.fromEntries(Object.entries(LOGINSTATE_PATTERNS)
  .map(([k, v]) => [k, v instanceof RegExp ? { re: v.source, fl: v.flags } : v])))};
function __rx(k){ var p=__P[k]; return new RegExp(p.re, p.fl); }
// Walk the light DOM AND every open shadow root, like __pwCount — a sign-in built entirely of web components
// would otherwise report "no form" on a page that is nothing but a form.
function __all(){ var acc=[]; (function walk(root,d){ if(d>8) return; var n=root.querySelectorAll('*');
  for(var i=0;i<n.length;i++){ acc.push(n[i]); if(n[i].shadowRoot) walk(n[i].shadowRoot,d+1); } })(document,0);
  return acc; }
// el.type IS NOT ALWAYS A STRING, and assuming it was crashed this whole verb on a real page.
// __all() returns EVERY element, not just inputs, and a <form> exposes its named controls as properties —
// so a form containing <input name="type"> answers that ELEMENT for form.type, and (el.type||'').toLowerCase
// throws "toLowerCase is not a function". Measured on a real page: login-state died outright
// rather than misreading anything, so the caller got a TypeError instead of a verdict. Coerce, never assume:
// a non-string yields a string that matches no input type, which is the correct reading for a non-input.
function __ty(el){ try{ return String((el && el.type) || '').toLowerCase(); }catch(e){ return ''; } }
// A CSS selector that resolves to exactly this element and nothing else, or null. Preference order is
// stability, not brevity: an id, then the owning form's id plus a name/type, then a tag+attribute pair. Each
// candidate is TESTED before it is returned, so a reported selector is always one the caller can click.
function __sel(el){ if(!el) return null;
  var esc = (window.CSS && CSS.escape) ? CSS.escape : function(s){ return String(s).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&'); };
  var cands=[];
  if(el.id) cands.push('#'+esc(el.id));
  var tag=el.tagName.toLowerCase(), nm=el.getAttribute('name'), ty=el.getAttribute('type');
  var attr=tag+(nm?'[name="'+nm.replace(/"/g,'\\\\"')+'"]':'')+(ty?'[type="'+ty.replace(/"/g,'\\\\"')+'"]':'');
  var f=el.form;
  if(f&&f.id) cands.push('form#'+esc(f.id)+' '+attr);
  cands.push(attr);
  for(var i=0;i<cands.length;i++){
    try{ if(document.querySelectorAll(cands[i]).length===1 && document.querySelector(cands[i])===el) return cands[i]; }catch(e){}
  }
  return null; }
function __label(el){ return ((el.innerText||el.value||el.getAttribute('aria-label')||el.title||'').trim().replace(/\\s+/g,' ')).slice(0,40); }
// The \`return\` lives HERE, inside the fragment, because the fragment is a STATEMENT LIST (var + function
// declarations, then this IIFE) and not an expression: \`return\` + newline + \`var …\` at the splice site is
// ASI bait — it becomes \`return;\` and the probe silently answers undefined. Measured, not theorized.
return (function(){
  var els=__all(), txt=((document.body&&document.body.innerText)||'').slice(0,20000);
  var pwAll=[], pwVis=[], userVis=[], otp=false, sso=[], logout=null, subs=[];
  for(var i=0;i<els.length;i++){ var el=els[i], tg=el.tagName, t=__ty(el);
    var idn=(el.getAttribute('name')||'')+' '+(el.id||'')+' '+(el.getAttribute('autocomplete')||'');
    if(tg==='INPUT'&&t==='password'){ pwAll.push(el); if(__vis(el)) pwVis.push(el); }
    if(tg==='INPUT'&&(t===''||t==='text'||t==='email'||t==='tel')){
      if(__vis(el)&&__rx('userName').test(idn)) userVis.push(el);
      if(__rx('otpName').test(idn)) otp=true; }
    if(tg==='INPUT'&&t==='tel'&&__rx('otpName').test(idn)) otp=true;
    // Submit controls and IdP buttons. A form's action is as much a provider tell as its label — some
    // SSO buttons carry NO text at all, only an action like /auth/google_oauth2 on the form.
    if(tg==='BUTTON'||(tg==='INPUT'&&(t==='submit'||t==='button'))||(tg==='A'&&el.getAttribute('role')==='button')){
      if(!__vis(el)) continue;
      var lab=__label(el), cls=(typeof el.className==='string'?el.className:''),
          act=(el.form&&el.form.getAttribute('action'))||el.getAttribute('href')||'',
          hay=lab+' '+cls+' '+act+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('data-provider')||'');
      if(__rx('logout').test(hay)&&!logout) logout={sel:__sel(el), label:lab};
      // An IdP button often carries NO text at all — a bare icon, where the only provider tell is the form
      // action. Record what actually matched so the verdict can NAME the providers instead of listing empty
      // strings.
      else if(__rx('sso').test(hay)) sso.push({sel:__sel(el), label:lab,
        provider:String((hay.match(__rx('sso'))||[''])[0]).toLowerCase()});
      else subs.push({el:el, lab:lab, submit:(t==='submit'||el.getAttribute('type')==='submit'||tg==='BUTTON')});
    }
    if(tg==='A'&&!logout&&__rx('logout').test((el.getAttribute('href')||'')+' '+__label(el))&&__vis(el))
      logout={sel:__sel(el), label:__label(el)};
  }
  if(document.querySelector(__P.otpSel)) otp=true;
  // The submit control that belongs to the CREDENTIAL form — scoped to the password field's own form, so a
  // page-wide "Search" button or a "Create an Account" button in a sibling form can never be handed back as
  // the thing to click. That mis-selection is a live hazard: a page may render "Sign In" and "Create an
  // Account" side by side, and clicking the wrong one starts a registration.
  var pw=pwVis[0]||pwAll[0]||null, form=pw?pw.form:null, best=null;
  for(var j=0;j<subs.length;j++){ var s=subs[j];
    if(form && s.el.form!==form) continue;
    if(!s.submit) continue;
    if(!best) best=s;
  }
  var ssoOnly = pwAll.length===0 && sso.length>0;
  // Cross-origin iframes: a form in one is invisible to this main-frame probe (see the SCOPE LIMIT note).
  var xo=0, ifr=document.querySelectorAll('iframe');
  for(var k=0;k<ifr.length;k++){ var src=ifr[k].getAttribute('src')||'';
    if(/^https?:\\/\\//.test(src)){ try{ if(new URL(src, location.href).origin!==location.origin) xo++; }catch(e){ xo++; } } }
  var g=(navigator.userActivation&&typeof navigator.userActivation.hasBeenActive==='boolean')
        ? navigator.userActivation.hasBeenActive : null;
  // Returned as a JSON STRING, not an object. evalInTarget deep-serializes an object handle through
  // Runtime.callFunctionOn and DEGRADES SILENTLY to an unserializable preview if any leaf resists — which
  // reads back here as "the page did not render" and sends the caller chasing a renderer problem that does not
  // exist. A string always crosses intact, and a JSON.stringify that throws in-page surfaces as a real page
  // exception with a real message.
  return JSON.stringify({
    pw: __pwCount(),
    pwSel: pw?__sel(pw):null,
    pwFilled: pw?(typeof pw.value==='string'?pw.value.length>0:null):null,
    pwAutofill: pw?__af(pw):null,
    pwVisible: pw?__vis(pw):null,
    userFields: userVis.length,
    userFilled: userVis.length?userVis.some(function(u){ return typeof u.value==='string'&&u.value.length>0; }):null,
    submitSel: best?__sel(best.el):null,
    submitLabel: best?best.lab:null,
    otherControls: subs.filter(function(s){ return !best||s.el!==best.el; }).map(function(s){ return s.lab; }).slice(0,6),
    sso: sso.slice(0,6), ssoOnly: ssoOnly,
    captcha: !!(document.querySelector(__P.captchaSel) || __rx('captchaText').test(txt) ||
      [].some.call(document.querySelectorAll('iframe'), function(f){ return __rx('captchaSrc').test(f.getAttribute('src')||''); })),
    secondFactor: !!(otp || __rx('otpText').test(txt)),
    chooser: !!(document.querySelector(__P.chooserSel) || __rx('chooserText').test(txt)),
    logout: logout, gesture: g, crossOriginIframes: xo,
    nextControl: (!pwAll.length && userVis.length && subs.length && __rx('nextText').test(subs[0].lab)) ? subs[0].lab : null,
  });})()`;

async function loginStateProbe(tcdp, deadline) {
  const r = await evalInTarget(tcdp, `(function(){${AUTOFILL_JS}${VIS_JS}${PWCOUNT_JS}${LOGINSTATE_JS}})()`,
    remaining(deadline));
  let v = null;
  try { v = typeof r.value === 'string' ? JSON.parse(r.value) : null; } catch (_) { v = null; }
  if (!v || typeof v !== 'object') throw new Error('could not read the page (the probe returned '
    + JSON.stringify(String(r && r.value).slice(0, 120)) + ') — it may not have rendered, or the renderer may be '
    + 'pinned (see dismiss-dialog --probe-only)');
  return v;
}

// THE DECISION. Order matters and is the whole design, so it is written out rather than left implicit:
//   1. A bot wall or a second factor beats everything else on the page — a filled form behind a CAPTCHA is
//      still a human's job, so these are checked before the form is.
//   2. A password field present ⇒ this is a self-serve form UNLESS 1 fired. It is NEVER by itself a reason to
//      call a human. That single rule is the fix for a page carrying SSO buttons AND a password form, where
//      the SSO buttons get read as the whole story.
//   3. No password field ⇒ LOGGED_IN if a sign-out control proves it; else the narrow human causes; else
//      UNRESOLVED, which sends the caller to another tool and never to the operator.
// `resolved` is the tri-state from a --resolve click, or null when none was spent.
function classifyLoginState(p, resolved) {
  const ev = {
    passwordFields: p.pw, passwordFilled: p.pwFilled, passwordAutofill: p.pwAutofill,
    passwordSelector: p.pwSel, usernameFields: p.userFields, usernameFilled: p.userFilled,
    submitSelector: p.submitSel, submitLabel: p.submitLabel, otherControls: p.otherControls,
    ssoButtons: p.sso.map((s) => s.label || s.provider || s.sel).filter(Boolean), ssoOnly: p.ssoOnly,
    captcha: p.captcha, secondFactor: p.secondFactor, accountChooser: p.chooser,
    signOutControl: p.logout ? (p.logout.label || p.logout.sel) : null,
    userActivationSpent: p.gesture, crossOriginIframes: p.crossOriginIframes,
    resolveClick: resolved || null,
  };
  const limits = ['main frame only — a form inside a cross-origin iframe is invisible here',
                  "Chromium's NATIVE saved-password account picker is browser UI and cannot be seen over CDP; "
                  + 'that case stays declared in the login registry (CHOOSER). `browse session-state` DOES read '
                  + 'those prompts (over AT-SPI) and reports BLOCKED when one is up',
                  'this verb reads the PAGE, so every verdict is as fresh as the render. It is the wrong tool '
                  + 'for "is my session still alive" — a rendered dashboard outlives its session. Ask '
                  + '`browse session-state`, which asks the server'];
  const V = (state, cause, reason, extra) => ({ state, cause: cause || null, reason, ...extra, evidence: ev, limits });

  if (p.captcha)
    return V('SIGN_IN_HUMAN', 'CAPTCHA', 'a bot-wall widget is rendered on this page — a CAPTCHA cannot be solved '
      + 'over CDP, so this is a genuine human step');
  if (p.secondFactor)
    return V('SIGN_IN_HUMAN', 'SECOND_FACTOR', 'the page is asking for a one-time code or an app-push approval — '
      + 'it needs a real phone, so this is a genuine human step');

  if (p.pw.all > 0) {
    // A credential form exists. From here the ONLY question is whether the values are there; the presence of
    // SSO buttons alongside it is irrelevant, and reading it otherwise is the bug this verb exists to kill.
    const next = p.submitSel
      ? "browse click '" + p.submitSel + "' --expect-url <the host you are on>"
      : 'inspect the form and click its submit control (no unique selector could be built for it)';
    if (p.pwFilled === true)
      return V('SIGN_IN_SELF_SERVE', null, 'the password field already holds a value' + (p.userFilled === true
        ? ' and so does the username field' : '') + ' — click the submit control and verify the landing page. '
        + 'You are one click from signed in; do NOT hand this to a human, and do NOT fetch a credential',
        { proof: 'prefilled', next });
    if (p.pwAutofill === true && p.gesture === false)
      return V('SIGN_IN_SELF_SERVE', null, 'the pre-gesture triple holds on the password field: Chromium filled it '
        + 'from its own saved store and the value is still invisible to page JS. A trusted click on the submit '
        + 'control makes the browser send it. Prefer `browse login <site>` if the site is enrolled — that path '
        + 'also verifies the landing page', { proof: 'pre-gesture', next });
    if (resolved && resolved.filled === true)
      return V('SIGN_IN_SELF_SERVE', null, 'a --resolve click on the password field proved Chromium fills it '
        + '(' + resolved.proof + ') — click the submit control', { proof: resolved.proof, next });
    // A --resolve that could not DECIDE is its own answer, and it must not fall through to the "try --resolve"
    // remedy below — telling a caller to re-run the thing they just ran is how a loop starts. filled:null from
    // rawClickAndAwaitFill means the autofill marker could not be evaluated: could-not-determine, which is
    // never "there is no saved credential" (that collapse is the documented leak path).
    if (resolved && resolved.filled !== true && resolved.filled !== false)
      return V('UNRESOLVED', null, '--resolve ' + (resolved.proof === 'not-attempted'
        ? 'could not run: ' + resolved.why
        : (resolved.proof === 'error' ? 'could not click the password field (' + resolved.error + ')'
          : 'clicked and the autofill marker still could not be evaluated'))
        + ' — this is could-not-determine, NOT "there is no saved credential"',
        { remedy: 'try `browse login <site>` if the site is enrolled (it navigates a clean tab and applies the '
          + 'full gate), and check `browse native-browser-prompts-view` for a saved-password chooser — that '
          + 'picker is native browser UI and CDP cannot see it' });
    if (resolved && resolved.filled === false)
      return V('SIGN_IN_HUMAN', 'NO_SAVED_CREDENTIAL', 'the password field is empty, Chromium did not fill it after '
        + 'a trusted click, and no user activation had been spent before that click — so there is no saved '
        + 'credential for this page. A human must sign in themselves (or save the credential in the browser). '
        + 'Do NOT fetch a credential from an oracle and type it', { next: null });
    // Not proven either way. Everything here has somewhere to go that is not the operator.
    if (p.gesture === true)
      return V('UNRESOLVED', null, 'the password field is empty and a user activation has ALREADY been spent on this '
        + 'document, so an empty read proves nothing — Chromium may still fill it in a clean document',
        { remedy: 'open a fresh tab on the same url (`browse --new open-url <url>`) and re-run login-state, or '
          + '`browse login <site>` if the site is enrolled' });
    return V('UNRESOLVED', null, 'the password field is empty and carries no autofill marker'
      + (p.pwAutofill === null ? ' that could be evaluated' : '') + ' — Chromium may still fill it after a trusted '
      + 'click (the fill lands 0.5-2s later), which has not been tried',
      { remedy: 'run `browse login-state --resolve` — it spends ONE trusted click on the password field and waits '
        + 'for the fill, then answers SELF_SERVE or HUMAN' });
  }

  // No password field anywhere.
  if (p.logout)
    return V('LOGGED_IN', null, 'a sign-out control is present ("' + (p.logout.label || p.logout.sel)
      + '") and the page has no password field — this session is authenticated');
  if (p.chooser)
    return V('SIGN_IN_HUMAN', 'CHOOSER', 'an account chooser is on screen with no password form beside it — '
      + 'picking an identity is a human decision');
  if (p.ssoOnly)
    return V('SIGN_IN_HUMAN', 'SSO_ONLY', 'every credential path on this page is a third-party identity-provider '
      + 'button (' + ev.ssoButtons.join(', ') + ') and there is NO password form beside them. Note the test: a '
      + 'page with BOTH an IdP button and a password form is SELF_SERVE, not this');
  if (p.userFields > 0 && p.nextControl)
    return V('SIGN_IN_HUMAN', 'TWO_STEP', 'a username-first step ("' + p.nextControl + '") with no password field — '
      + 'the saved store may hold the password but nothing here supplies the username at step 1');
  if (p.crossOriginIframes > 0)
    return V('UNRESOLVED', null, 'no login form in the main frame, but the page has ' + p.crossOriginIframes
      + ' cross-origin iframe(s) — a form inside one is unreachable from this probe',
      { remedy: 'name the iframe and act inside it — `browse snapshot --frame <iframe selector>` to see what is '
        + 'in there, then click/enter-text with the same --frame; or capture the page (`browse save-page`) and '
        + 'inspect it' });
  return V('UNRESOLVED', null, 'no password field, no sign-out control, no IdP button and no chooser — this does not '
    + 'look like a sign-in page or a recognizably authenticated one',
    { remedy: 'run `browse session-state` — THIS EXACT READING is what a LIVE, fully authenticated dashboard '
      + 'produces when its sign-out control sits in a shadow root the probe does not reach (measured on '
      + "a real site), and it is also what a login page produces when a NATIVE browser prompt has "
      + 'stopped it rendering. Both look identical here and neither is decidable from the page. session-state '
      + 'asks the SERVER and reads the native prompts. Only after that: `browse get-text` / `browse screenshot`' });
}

// ---- `session-state`: is my SESSION on this site alive? Asked of the SERVER. --------------------------------
// THE FAILURE THIS EXISTS TO KILL. Agents reading the PAGE reach confident and different conclusions about ONE
// session, and every one of them can be wrong:
//   - a login form that "never renders" is read as the SITE being broken;
//   - a typed stored password, rejected, is read as the CREDENTIAL being stale — when the browser's saved row
//     and the password store simply hold DIFFERENT usernames;
//   - a rendered "Dashboard · …" title is read as the session being LIVE, when it went 401 minutes earlier: a
//     rendered view outlives the session that produced it.
// Each wrong conclusion costs failed sign-ins against a real account, or a needless password change.
//
// THE THREE PAGE SIGNALS THAT LOOK DECISIVE AND ARE NOT — each MEASURED in BOTH states on a real site:
//   input count           0 on the live authenticated dashboard, 0 on the blocked login page.       USELESS
//   `browse login-state`  UNRESOLVED live, UNRESOLVED logged out (its sign-out probe does not pierce
//                         the site's shadow roots).                                                 USELESS
//   rendered title        DISCRIMINATES — and is STALE. It still read "Dashboard" for minutes after the
//                         server had gone 401. A FALSE POSITIVE, which is the direction that saves a
//                         blank document.                                                           UNSAFE
// So: ASK THE SERVER. The verdict comes from an authenticated ENDPOINT and from nothing else.
//
// AND THE ANSWER IS ABOUT THE COOKIE JAR, NOT THE TAB. The probe is a same-origin fetch, so it reports on the
// browser PROFILE's cookies for that origin — the same answer any tab on that origin would get. That is why a
// probe issued from a login page that itself never rendered is still valid, and it is the measured death of
// "the fetch 401'd because the page it ran on was never authenticated".
//
// THE FOUR STATES, and the rule that none of them may absorb another:
//   LOGGED_IN     the server answered with a status the registry says means authenticated.
//   LOGGED_OUT    the server answered with a status the registry says means NOT authenticated. This verdict
//                 can be reached NO OTHER WAY. No page reading, no missing form, no absent cookie produces
//                 it — because an agent that believes it is logged out goes and fetches a credential, and
//                 that is the leak the whole surrounding system exists to prevent. If the server did not say
//                 so, the answer is CANNOT_TELL.
//   CANNOT_TELL   a first-class answer, not a euphemism and not a synonym for LOGGED_OUT. Every instance
//                 carries a `remedy` naming the next thing to TRY, so it never resolves to "ask the operator".
//   BLOCKED       something is in front of the page: Chromium's own credential picker / permission bubble
//                 (browser UI, invisible to every CDP query and to page JS), or a page-raised JS dialog that
//                 has frozen the renderer.
//
// WHY BLOCKED OUTRANKS A CLEAN SERVER ANSWER. A native browser prompt does NOT freeze the renderer, so the
// server probe still answers truthfully underneath one — and the honest headline is still BLOCKED, because
// every PAGE-derived reading the caller is about to take is worthless until the prompt is cleared, and that is
// precisely the mistake page-reading makes. Nothing is lost by the precedence: `serverProbe` is reported in
// FULL in every state, so a caller that only wants the session answer reads it there and gets it.
//
// WHY THIS IS A SEPARATE VERB FROM `login-state`, having seriously considered extending it:
//   - Different question. login-state answers "is a HUMAN needed on THIS PAGE" and its verdicts are about a
//     page (SIGN_IN_SELF_SERVE, SIGN_IN_HUMAN). This answers "is my SESSION on this SITE alive", which is a
//     property of the profile's cookies and is the same from every tab.
//   - Different evidence. login-state reads the DOM, on purpose, and must never touch the network — it is
//     safe to run before `login` precisely because it changes nothing. This one issues a request.
//   - Different input. login-state takes NO arguments by design (it classifies the tab you are on). This
//     needs the site's session-truth endpoint, which is per-site knowledge and therefore registry data.
//   - Merging them would put a network call inside the verb whose whole contract is that it is inert, and
//     would give one `state` field two incompatible meanings.
//   THE TRAP THAT REMAINS, and it is closed rather than left: an agent asking "am I logged in?" reaches for
//   login-state by name, and login-state answers UNRESOLVED on a live dashboard. So login-state's terminal
//   UNRESOLVED now names THIS verb as its first remedy, and says that reading is what a live session looks
//   like. A new verb that did not do that would just move the trap.
const SESSION_PROBE_MS = Number(process.env.BROWSE_SESSION_PROBE_MS) || 20000;  // cap on the one probe fetch (tests override low)
// A native prompt BLOCKS if it is a modal dialog or offers buttons to press. Deliberately narrow: a browser can
// permanently carry a buttonless `{"role":"alert","name":"Infobar"}`, and Chromium's Autofill suggestion list is
// a buttonless `list box` that no more blocks the page than a tooltip does. Calling either of those blocking
// would make BLOCKED the permanent answer and the verb worthless — the failure mode a too-eager detector has.
const sessionPromptBlocks = (p) => !!p && (String(p.role || '') === 'dialog'
  || (Array.isArray(p.buttons) && p.buttons.length > 0));
// Reported in EVERY answer rather than hidden, like login-state's. The first line matters most, so it leads.
const SESSION_LIMITS = [
  'the verdict is the SERVER\'s, never the page\'s: a rendered view outlives its session (measured — a '
  + 'dashboard stayed on screen for minutes after the server had gone 401), so pageContextOnly decides nothing',
  'this answers for the browser PROFILE\'s cookie jar on that origin, not for this tab — every tab on the '
  + 'origin has the same answer, and a probe run from a login page that never rendered is still valid',
  'a native browser prompt is read over AT-SPI; if that read FAILS it is reported as nativePromptsRead:false '
  + 'and never as "no prompt"',
];
// The in-page probe. Returns a JSON STRING for the same reason LOGINSTATE_JS does (evalInTarget degrades an
// object handle to an unserializable preview, which reads back as "the page did not render").
// IT NEVER RETURNS THE BODY — only its length and content-type. The body of an authenticated endpoint is
// account data by construction, and a session checker has no business carrying any of it back.
const sessionStateJS = (probePath) => `(async function(){
  var o={origin:location.origin, path:location.pathname, href:location.href, title:document.title};
  try{
    var r=await fetch(${JSON.stringify(probePath)},{cache:'no-store'});
    var b=await r.text();
    o.probe={reached:true, status:r.status, contentType:r.headers.get('content-type'), bytes:b.length,
             redirected:r.redirected, finalPath:(function(){try{return new URL(r.url).pathname}catch(e){return null}})()};
  }catch(e){ o.probe={reached:false, error:String((e&&e.message)||e).slice(0,200)}; }
  return JSON.stringify(o);
})()`;

// THE DECISION. Written out in order because the order IS the design:
//   1. Something in front of the page beats everything — see WHY BLOCKED OUTRANKS above.
//   2. The server's answer decides LOGGED_IN / LOGGED_OUT, and only the server's answer ever does.
//   3. Everything else is CANNOT_TELL with a remedy. There is no fall-through that guesses.
// `prompts` is {blocking:[], other:[], read:bool, err}; `page` is the probe payload or null; `frozen` is true
// only when the renderer was CONFIRMED silent.
function classifySessionState(site, cfg, prompts, page, frozen) {
  const pr = page && page.probe;
  const ev = {
    serverProbe: {
      path: cfg && cfg.session ? cfg.session.probe : null,
      meansLoggedIn: cfg && cfg.session ? cfg.session.ok : null,
      meansLoggedOut: cfg && cfg.session ? cfg.session.no : null,
      expectContentType: (cfg && cfg.session && cfg.session.okContentType) || null,
      ...(pr || { reached: false, error: 'the probe was not run' }),
    },
    blockingPrompts: prompts.blocking,
    otherPrompts: prompts.other,
    nativePromptsRead: prompts.read,
    // PAGE CONTEXT, and the key is named for what it is worth. It is here to help a human recognize where the
    // tab is standing, and it decides NOTHING — see the three useless signals above.
    pageContextOnly: page ? { origin: page.origin, path: page.path, title: page.title } : null,
  };
  const V = (state, cause, reason, extra) => ({ site: site || null, state, cause: cause || null, reason,
    ...extra, evidence: ev, limits: SESSION_LIMITS });

  // 1 — in front of the page.
  if (prompts.blocking.length) {
    const p = prompts.blocking[0];
    return V('BLOCKED', 'NATIVE_PROMPT', 'Chromium itself is showing "' + (p.name || p.role) + '" in front of '
      + 'this page. It is BROWSER UI: page JS cannot see it, no CDP query can see it, and while it is up the '
      + 'app may be awaiting it and will not render — so page-level readings agree "the form never renders" '
      + 'while looking at the wrong layer. '
      + (pr && pr.reached ? 'The server probe still answered underneath it (status ' + pr.status
        + ') and is reported in evidence.serverProbe — read it there.' : 'The server probe did not answer.'),
      { buttons: Array.isArray(p.buttons) ? p.buttons : [],
        remedy: 'read it with `browse native-browser-prompts-view`, then clear it with `browse '
          + 'native-browser-prompts-dismiss --button <name>`. On a saved-password picker, Cancel resolves the '
          + "site's navigator.credentials.get() empty and the real form finally stamps; the OTHER button SIGNS "
          + 'YOU IN, so it is a login and not a probe. Re-run session-state after clearing' });
  }
  if (frozen)
    return V('BLOCKED', 'PAGE_DIALOG', 'this tab\'s renderer stopped answering, which is what a page-raised '
      + 'alert/confirm/beforeunload does — the dialog is drawn outside the page and holds the main thread, so '
      + 'nothing here can be read until it is cleared',
      { remedy: 'run `browse dismiss-dialog --probe-only` to confirm which tab is pinned, then `browse '
        + 'dismiss-dialog` to clear it. A common cause is `open-url` on a tab ALREADY on that url' });

  // 2 — the server, and only the server.
  if (!page)
    return V('CANNOT_TELL', 'PAGE_UNREADABLE', 'the tab could not be read at all, and its renderer is NOT '
      + 'confirmed frozen — so nothing is known about the session either way',
      { remedy: '`browse browser-status` and `browse list-tabs`, then re-run. Do NOT read this as logged out' });
  if (!cfg)
    return V('CANNOT_TELL', 'NO_SITE_MATCH', 'no enrolled site DECLARING A SESSION PROBE matches this tab\'s '
      + 'origin (' + page.origin + '), so there is no session-truth endpoint to ask. An entry can be enrolled '
      + 'for `login` and still have no session block — that is a gap in the registry, not a verdict',
      { remedy: 'name the site — `browse session-state <site>` (`browse login --list` names every enrolled '
        + 'one) — or add an entry with a "session" block to the login registry' });
  if (!cfg.session)
    return V('CANNOT_TELL', 'NO_PROBE_RECORDED', 'site "' + site + '" is enrolled but records no session probe, '
      + 'so there is nothing authoritative to ask. This is NOT logged out, and it is NOT a reason to fetch a '
      + 'credential — it is a gap in the registry',
      { remedy: 'find an endpoint the SPA itself calls that requires the session (its performance resource '
        + 'timings are a good source), verify it returns one status authenticated and another not, then add '
        + '"session": {"probe": "/that/path", "ok": [200], "no": [401]} to the "' + site + '" entry in the '
        + 'login registry' });
  if (!pr || !pr.reached)
    return V('CANNOT_TELL', 'PROBE_FAILED', 'the session probe ' + cfg.session.probe + ' could not be issued ('
      + ((pr && pr.error) || 'no result') + ') — a request that never completed says nothing about the session',
      { remedy: 'check the tab is still on the site origin and the box has network, then re-run' });
  const s = cfg.session;
  if (s.ok.includes(pr.status)) {
    // The one way a server probe lies in the DANGEROUS direction: the path moved, and the SPA's html shell
    // comes back 200 for it forever. Refuse to call that authenticated.
    if (s.okContentType && !String(pr.contentType || '').includes(s.okContentType))
      return V('CANNOT_TELL', 'PROBE_SHAPE_UNEXPECTED', 'the probe returned ' + pr.status + ' — which this site '
        + 'records as authenticated — but its content-type was ' + JSON.stringify(pr.contentType) + ' instead of '
        + 'the expected ' + JSON.stringify(s.okContentType) + '. A moved probe path answered by the app\'s own '
        + 'html shell looks exactly like this, and it would read as authenticated forever',
        { remedy: 'confirm the probe path still exists on this site and correct "session.probe" in the login '
          + 'registry. Do NOT treat this as logged out' });
    return V('LOGGED_IN', null, 'the server answered ' + pr.status + ' on ' + s.probe + ', which this site '
      + 'records as authenticated. This is the session as the SERVER sees it right now'
      + (String(pr.contentType || '') ? ' (content-type ' + pr.contentType + ', ' + pr.bytes + ' bytes)' : ''),
      { next: 'proceed. Re-run this check if the work is long — a session can lapse mid-task while the page '
        + 'you are looking at keeps rendering' });
  }
  if (s.no.includes(pr.status))
    return V('LOGGED_OUT', null, 'the server answered ' + pr.status + ' on ' + s.probe + ', which this site '
      + 'records as NOT authenticated. The cookie jar for this origin is not signed in',
      { next: 'if the site is enrolled and not blocked, `browse login ' + site + '` — the browser sends its OWN '
        + 'saved credential and nothing is typed. If it is blocked, report that and stop. Do NOT fetch a '
        + 'credential from an oracle and type it: a cold login with an oracle username against a site whose '
        + 'saved row holds a DIFFERENT one is exactly how failed sign-ins get spent on a real account' });
  return V('CANNOT_TELL', 'PROBE_STATUS_UNKNOWN', 'the probe ' + s.probe + ' returned ' + pr.status + ', which '
    + 'this site records as meaning neither authenticated (' + s.ok.join(', ') + ') nor not-authenticated ('
    + s.no.join(', ') + ')',
    { remedy: 'a 404 usually means the probe path moved; a 3xx or a 5xx means the site is answering something '
      + 'other than the question. Verify the endpoint by hand in both states, then correct "session" in the '
      + 'login registry. This is NOT logged out' });
}

// Raw-CDP download — the one act verb with NO Playwright fallback. The download ITSELF was always raw CDP
// (Playwright's download event / saveAs is unreliable over connectOverCDP); what moves here is the browser
// session it runs on and the trigger: Browser.* now goes over runRaw()'s EXISTING browser-level ws instead of
// newBrowserCDPSession(), so nothing ever attaches to the other tabs, and a selector clicks through rawClick.
// Sequence:
//   read OUR frame ids (Page.getFrameTree) so the events can be pinned to this tab → arm download EVENTS without
//   touching where files land (setDownloadBehavior{behavior:'default', eventsEnabled:true}) → trigger → latch OUR
//   download's guid from downloadWillBegin → wait for that guid's 'completed' ('canceled' rejects; 120s transfer
//   cap; 15s cap on one ever STARTING) → report the path the completion event NAMES, as-is.
// WE NO LONGER CHOOSE THE DIRECTORY OR THE NAME, and that is the whole design. behavior:'default' leaves the
// browser's own download path in force, so an automated download is byte-for-byte what a human's click produces:
// same folder, same filename, and Chromium's own "name (1).ext" when the name is already taken. eventsEnabled is
// what we are really here for and it is REQUIRED — measured: with no setDownloadBehavior call at all the file
// still downloads but NOT ONE event fires, so the wait would sit on the full 120s cap.
// WHY NOT A PRIVATE TEMP DIR. Isolation — put one download in an empty dir and whatever appears must be ours —
// buys nothing once the completion event NAMES the file, and it was never isolation anyway: setDownloadBehavior
// on the BROWSER endpoint is browser-WIDE, so a human's concurrent click would be redirected into that temp dir
// and deleted by its cleanup.
// Do NOT "simplify" this back to behavior:'allow' with a fixed downloadPath: measured
// (headless AND headful), 'allow' does NOT uniquify — it silently OVERWRITES a colliding file, including one it
// did not download. 'default' is the only mode that gets Chromium's never-clobber naming, and the only one under
// which another tab's download is left completely alone.
// THE GUID PIN IS STILL LOAD-BEARING, not defensive dressing: download events are browser-WIDE under 'default'
// too (verified — another tab's download fires downloadWillBegin/downloadProgress at us). Unfiltered, a download
// started 2.5s into a 12s transfer was returned as OURS with exit 0 in 3.6s while the real file was
// orphaned at 0 bytes. So: downloadWillBegin is accepted only from a frame of THIS target (frameId of a main-frame
// download == the page targetId) and only once, and every downloadProgress whose guid isn't the latched one is
// dropped on the floor. Failing CLOSED is deliberate — a wrong file handed back as the caller's file is worse than a
// loud failure.
// The handlers are registered BEFORE the trigger fires: a localhost download can complete in milliseconds, and an
// event that arrives before we subscribe is simply gone — the wait would then sit on the full 120s cap.
// URL vs selector: for a URL the caller hands us a THROWAWAY tab (downloadIsUrl → resolveTarget(forceNew)) and we
// do NOT await Page.navigate for the download — a download URL ABORTS the navigation, so rawGoto (which waits for
// load) would block every download until its 90s cap. We do keep the navigate PROMISE and race it: Page.navigate
// RESOLVES with an errorText rather than rejecting, so a DNS failure / 404 / bad URL used to be invisible and sat
// on the full 120s cap holding the global flock. net::ERR_ABORTED is the EXPECTED result of a successful download.
// A URL that simply renders a page reports no error at all — NO_DOWNLOAD_MS is what bounds that one.
// Throws, never die()s: die() is a synchronous process.exit, so the finally would never run — the event reset and
// the caller's temp-tab close would both be skipped, leaving a blank tab stranded on a shared browser. Capture the
// error → run the finally → rethrow.
// The finally does NOT detach anything: the browser client belongs to runRaw(), which closes it on every exit.
async function rawDownload(browser, tcdp, target, isUrl) {
  const deadline = Date.now() + PRESS_TIMEOUT_MS;   // budget for the TRIGGER half only; the transfer has its own cap
  // OUR frames, main + subframes. A hard failure here is correct: with no frame set every download would be
  // rejected as someone else's, and silently downgrading to "accept anything" is the bug this exists to kill.
  const ourFrames = new Set();
  try {
    const { frameTree } = await tcdp.send('Page.getFrameTree', {}, remaining(deadline));
    (function walk(n) { if (!n) return; if (n.frame && n.frame.id) ourFrames.add(n.frame.id); for (const c of n.childFrames || []) walk(c); })(frameTree);
  } catch (e) { throw new Error('cannot read this tab\'s frame tree, so a download could not be told apart from another tab\'s: ' + (e.message || e)); }
  if (!ourFrames.size) throw new Error('this tab reported no frames — refusing to start a download we could not pin to it');
  let guid = null, filePath = null, timer = null, startTimer = null, result = null, downloadErr = null;
  let rejectFinished;
  const finished = new Promise((resolve, reject) => {
    rejectFinished = reject;
    browser.on('Browser.downloadWillBegin', (e) => {
      if (guid !== null || !ourFrames.has(e.frameId)) return;  // already latched, or another tab's download
      guid = e.guid;
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
    });
    browser.on('Browser.downloadProgress', (e) => {
      if (e.guid !== guid) return;                             // never resolve/reject on someone else's transfer
      if (e.state === 'completed') { filePath = e.filePath || null; resolve(); }
      else if (e.state === 'canceled') reject(new Error('download canceled by the browser'));
    });
    // A dead browser socket (Chromium crash, a service restart) rejects only pending SENDS via
    // CDPClient.failAll; `finished` is an event promise, so without this it parked on the 120s cap holding the flock.
    browser.ws.on('close', () => reject(new Error('browser CDP socket closed mid-download')));
    timer = setTimeout(() => reject(new Error('timed out waiting for the download to finish')), DOWNLOAD_TIMEOUT_MS);
  });
  finished.catch(() => {}); // if we bail BEFORE awaiting it (a failed trigger), a late 'canceled' would be an
                            // UNHANDLED rejection — fatal in node — turning a clean exit-1 into a crash.
  try {
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }, remaining(deadline));
    let navGuard = null;
    if (isUrl) {
      navGuard = tcdp.send('Page.navigate', { url: target }).then((r) => {
        if (r && r.errorText && r.errorText !== 'net::ERR_ABORTED') throw new Error('navigate: ' + r.errorText);
        return new Promise(() => {});   // navigate reported no error → only the download (or a cap) settles this
      });
      navGuard.catch(() => {});         // same unhandled-rejection guard as `finished`
    } else {
      await rawClick(tcdp, target, remaining(deadline)); // auto-wait + obscured check, like every raw act verb
    }
    startTimer = setTimeout(() => { if (guid === null) rejectFinished(new Error('no download started for ' + target
      + ' — the URL may render a page or 404')); }, NO_DOWNLOAD_MS);
    await (navGuard ? Promise.race([finished, navGuard]) : finished);
    // The completion event NAMES the file — that path is the answer, verbatim. It is the real final name, after
    // Chromium's own duplicate handling (measured: a second download of the same name reports "name (1).ext"),
    // so there is nothing to sanitize, uniquify or move. The existsSync is the one sanity check worth keeping:
    // it turns "the browser said completed but the bytes are not there" into a loud failure rather than a
    // plausible-looking JSON answer a caller would keep as the real file.
    if (!filePath) throw new Error('the browser reported the download complete but named no file '
      + '(no filePath on Browser.downloadProgress) — refusing to guess which file was ours');
    if (!fs.existsSync(filePath)) throw new Error('the browser reported a completed download at ' + filePath + ' but nothing is there');
    result = { path: filePath, filename: path.basename(filePath), bytes: fs.statSync(filePath).size };
  } catch (e) {
    downloadErr = e; // rethrown after the finally so cleanup runs first
  } finally {
    // Drop the timers (they would hold the event loop open) and turn download EVENTS back off: success, failure
    // or timeout. The reset is pure hygiene now — it restores the browser to the state we found it in and can
    // never strand or delete anything, because no download PATH was ever overridden (verified: a bare
    // {behavior:'default'} stops the events and leaves in-flight and future downloads landing exactly as before).
    // It carries a SHORT explicit timeout: on the failure path the default 90s send cap could push the serial
    // worst case past the entry point's 240s hard kill, which would drop the flock without ever resetting.
    if (timer) clearTimeout(timer);
    if (startTimer) clearTimeout(startTimer);
    await browser.send('Browser.setDownloadBehavior', { behavior: 'default' }, 10000).catch(() => {});
  }
  if (downloadErr) throw new Error(downloadErr.message || downloadErr);
  return result;
}

// A capture destination under DOWNLOADS must not ENOENT on a machine where that dir was never created.
const outFile = (arg, fallback) => {
  if (arg && path.isAbsolute(arg)) return arg;
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  return path.join(DOWNLOADS, arg || fallback);
};
// capture dest: --out <path> wins, else positional, else default name ('-' is handled inline = stream)
const captureDest = (posArg, fallback) => outFile(flags.out && flags.out !== '-' ? flags.out : posArg, fallback);

(async () => {
  // Test-ONLY unit-test seam for redactUrl's fail-closed path (never set this by hand, like the other
  // BROWSE_* test overrides). A live, CDP-reported tab url is always parseable, so the malformed-input branch
  // can never be reached through a real verb/browser — this lets the hermetic suite probe it directly. No verb
  // required; runs before the verb-required check below.
  if (process.env.BROWSE_TEST_REDACT_URL !== undefined) { out({ redacted: redactUrl(process.env.BROWSE_TEST_REDACT_URL) }); return finish(0); }
  if (!verb) die('usage: browse <verb> [args] [--account <email>] [--new] [--out <path|->] [--ref <n>] [--frame <iframe selector>]');
  // --account NAMES WHICH SAVED ACCOUNT `login` picks out of Chromium's chooser on a realm holding more than
  // one. It is an email the caller already knows, never read from or written to the registry.
  if (flags.account && verb !== 'login')
    die('--account applies to login only (it names which SAVED ACCOUNT to pick when a realm holds two or more)');
  if (flags.expectUrl && BROWSER_ONLY.has(verb))
    die('--expect-url does not apply to browser-only verbs (' + [...BROWSER_ONLY].join('/') + ')');
  if (flags.probeOnly && verb !== 'dismiss-dialog') die('--probe-only is a dismiss-dialog flag (it probes every tab and changes nothing)');
  if (flags.button !== null && verb !== 'native-browser-prompts-dismiss')
    die('--button is a native-browser-prompts-dismiss flag (it names the button to press in a NATIVE browser '
      + 'prompt); no other verb takes it — to click something in the PAGE use `browse click <selector>`');
  if (flags.username !== null && verb !== 'native-browser-prompts-choose')
    die('--username is a native-browser-prompts-choose flag (it names which SAVED ACCOUNT to pick out of '
      + "Chromium's saved-password chooser); no other verb takes it — to type a username into the PAGE use "
      + '`browse enter-text <selector> <text>`');
  if (flags.card !== null && verb !== 'native-browser-prompts-choose')
    die('--card is a native-browser-prompts-choose flag (it names which SAVED CARD to accept out of '
      + "Chromium's autofill popup, by last four); no other verb takes it — to type a card number into the "
      + 'PAGE use `browse enter-text <selector> <text>`');
  if (flags.card !== null && flags.username !== null)
    die('native-browser-prompts-choose: --username and --card name different rows (a saved password vs a saved '
      + 'payment card) — pass one');
  if (flags.card !== null && !/^\d{4}$/.test(String(flags.card).trim()))
    die('--card takes exactly the LAST FOUR digits of the card, e.g. --card 4242 (got ' + JSON.stringify(flags.card)
      + '). Never pass a full card number to this tool: the number lives in the browser\'s own store and is '
      + 'sent by the browser from its own side');
  if (flags.yes && verb !== 'restart-browser') die('--yes is a restart-browser flag (it confirms destroying every tab); no other verb takes it');
  if (flags.echoValue && verb !== 'enter-text')
    die('--echo-value is an enter-text flag (it restores the landed value in the output for debugging); no other verb takes it');
  if (flags.noPreflight && verb !== 'click-and-await-fill')
    die('--no-preflight is a click-and-await-fill flag (it skips the pre-gesture autofill proof and always clicks); no other verb takes it');
  // CLICK EFFECT flags. Parsed and validated HERE, before any CDP connect or minted tab, so a typo'd predicate
  // costs nothing — and so a bad --expect can never be discovered AFTER a real click has already fired.
  for (const [given, name, what] of [[flags.expect !== null, '--expect', 'asserts a page change AFTER the click'],
                                     [flags.expectMs !== null, '--expect-ms', 'caps the --expect wait'],
                                     [flags.noEffect, '--no-effect', 'drops the automatic before/after signal'],
                                     [flags.force, '--force', 'clicks through an overlay the hit test refused']])
    if (given && verb !== 'click')
      die(name + ' is a click flag (it ' + what + '); no other verb takes it. To guard which TAB a verb acts on, '
        + 'the flag is --expect-url');
  // --no-recheck reaches further than --force does, because rawClick has four callers and the guard is on all
  // of them: `click` is only the most direct. A verb that never dispatches a mouse press has nothing to
  // recheck, so the flag is refused there rather than accepted and ignored.
  if (flags.noRecheck && !CLICKING_VERBS.has(verb))
    die('--no-recheck is a click flag (it presses at the coordinates the hit test chose without re-validating '
      + 'them first); it applies to ' + [...CLICKING_VERBS].join(', ') + ' — the verbs that dispatch a mouse '
      + 'press — and no others');
  // The activation recovery lives on exactly two verbs — see ACTIVATE_RETRY_VERBS for why press-key is
  // Enter-only and why enter-text is excluded outright. Refused elsewhere rather than accepted and ignored:
  // a caller who passes it to keep the foreground still must not be told "fine" by a verb that never had it.
  if (flags.noActivateRetry && !ACTIVATE_RETRY_VERBS.has(verb))
    die('--no-activate-retry is a ' + [...ACTIVATE_RETRY_VERBS].join('/') + ' flag (it stops the verb activating '
      + 'the tab and trying once more when the interaction reports NO effect at all); no other verb takes it. '
      + 'On press-key it applies to Enter only — the other control keys never trigger the recovery, because a '
      + 'Tab or an Escape that changes nothing is ordinary rather than a symptom');
  if (flags.expectMs !== null && flags.expect === null)
    die('--expect-ms caps the wait for --expect, so it needs one: `browse click <sel> --expect appears:#toast --expect-ms 10000`');
  if (flags.expect !== null && flags.noEffect)
    die('--expect and --no-effect contradict each other: --expect IS an effect check');
  if (flags.expect !== null) expectPred = parseExpect(flags.expect);
  if (flags.expectMs !== null) {
    if (!/^\d+$/.test(String(flags.expectMs))) die('--expect-ms takes milliseconds (a whole number), got "' + flags.expectMs + '"');
    expectWaitMs = Number(flags.expectMs);
  }
  if (flags.list && verb !== 'login')
    die('--list is a login flag (it names every site enrolled in the browser\'s saved-password store); no other verb takes it');
  if (flags.resolve && verb !== 'login-state')
    die('--resolve is a login-state flag (it spends ONE trusted click to settle an UNRESOLVED verdict); no other verb takes it');
  if (flags.stayFront && verb !== 'screenshot')
    die('--stay-front is a screenshot flag (it leaves the captured tab in the foreground instead of handing the '
      + 'foreground back to whichever tab had it); no other verb takes it. save-page and dismiss-dialog also '
      + 'activate a tab, and they always restore — neither has a caller that wants the tab left in front');
  // session-state: at most ONE site name, resolved + validated HERE so a typo costs neither a CDP connect nor
  // a minted tab (same treatment `login` gives its site argument, and for the same reason).
  if (verb === 'session-state') {
    if (pos.length > 1) die('session-state takes at most ONE site name — `browse session-state [<site>]`. With no '
      + "site it matches the tab's origin against the registry");
    if (pos.length === 1) {
      const sites = loadLoginRegistry();
      if (!Object.hasOwn(sites, pos[0]))   // hasOwn, not sites[name]: inherited proto members are truthy
        die('session-state: "' + pos[0] + '" is not enrolled — enrolled sites: ' + Object.keys(sites).join(', ')
          + '. Adding one is registry DATA (an entry with a "session" block), not a code change');
    }
  }
  if (verb === 'login-state' && pos.length)
    die('login-state takes no arguments — it classifies the tab you are ALREADY on (add --resolve to let it spend '
      + 'one trusted click). To sign into an enrolled site instead, use `browse login <site>`');
  if (flags.expectUrl && verb === 'login')
    die('--expect-url does not apply to login (it navigates to the registry ENTRY url itself, so there is no prior tab state to guard)');
  if (flags.rawUrls && !RAW_URL_OK.has(verb))
    die('--raw-urls only applies to ' + [...RAW_URL_OK].join('/') + ' (it disables URL redaction); "' + verb + '" reports no URL to redact');
  // --target is the ONE scope that can reach a tab the caller does not own, so its contract is spelled out
  // rather than inferred: exactly one tab, named by id, and never combined with a sweeping scope.
  if (flags.target !== null && verb !== 'close-tabs')
    die('--target is a close-tabs scope naming ONE tab by its targetId (see `browse list-tabs`); no other verb takes it');
  // Refused BLANK, like --button and --username. An empty value is falsy, so without this the scope would fall
  // through to the default session scope and close a DIFFERENT tab than the caller named — silently.
  if (flags.target !== null && !String(flags.target).trim())
    die('--target needs a targetId (see `browse list-tabs`); it is refused blank rather than falling back to another scope');
  if (flags.anySession && verb !== 'close-tabs')
    die('--any-session is a close-tabs flag (it permits closing a tab another session owns); no other verb takes it');
  if (flags.anySession && flags.target === null)
    die('--any-session only means anything alongside --target: it lifts the cross-session refusal for ONE named tab');
  if (flags.target !== null && (flags.agents || flags.stale))
    die('close-tabs: --target names ONE tab and is a scope of its own — run it separately from --agents/--stale');
  // Flags this verb has no meaning for must FAIL, not be silently ignored: `browse restart-browser --agents --yes …`
  // reads like `close-tabs --agents` and would in fact restart the whole browser.
  if (verb === 'restart-browser') {
    for (const [given, name, what] of [[flags.agents, '--agents', 'a close-tabs scope'], [flags.stale, '--stale', 'a close-tabs scope'],
                                       [flags.out !== null, '--out', 'a capture-verb destination']])
      if (given) die('restart-browser does not take ' + name + ' (' + what + ') — it restarts the WHOLE browser and '
        + 'reopens tabs; it never closes a subset and never writes a file. Did you mean `browse close-tabs ' + name + '`?');
  }
  // --new is tolerated (as a no-op) on the other browser-only verbs, but NOT here: a caller who thinks they are
  // asking for a fresh tab must not get the whole browser restarted under them.
  if (flags.new && verb === 'restart-browser')
    die('--new does not apply to restart-browser (it restarts the WHOLE browser — there is no tab to open); did you mean `browse --new browser-status`?');
  // …nor to a URL download: that drives a FRESH throwaway tab, so there is no caller tab to
  // guard and the flag checked nothing while exiting 0. Rejecting is the safe answer, exactly as above.
  if (flags.expectUrl && downloadIsUrl)
    die('--expect-url does not apply to a URL download (it drives a fresh throwaway tab) — use download <selector> to guard the session tab');

  // EVERY VERB, and there is exactly one path for all of them: raw per-target CDP. The Playwright fallbacks
  // that used to sit beside the act verbs are gone, and the reasons they went are worth keeping, because each
  // one is a bug someone could reintroduce by "restoring the fallback". download's could return a WRONG answer
  // with exit 0 — no guid pin (it resolved on ANY tab's downloadProgress, so a human's click mid-transfer could
  // be returned as the caller's file), no navigate guard (a bad URL sat on the full 120s cap holding the
  // global flock), no socket-close guard, and an arbitrary readdir got[0] pick. upload-file's was strictly
  // worse the same way — see rawUploadFile for the isTrusted/50MB detail. And none of them ever bought
  // cross-origin-iframe reach: page.click() is main-frame only, exactly as rawClick is; --frame is what reaches
  // into a frame.
  const RAW = new Set(['open-url', 'get-text', 'get-html', 'get-values', 'run-js', 'screenshot', 'print2pdf',
                       'save-page', 'highlight-text', 'snapshot', 'browser-status', 'list-tabs', 'close-tabs',
                       'dismiss-dialog', 'download', 'upload-file', 'restart-browser',
                       'native-browser-prompts-view', 'native-browser-prompts-dismiss',
                       'native-browser-prompts-choose', 'login', 'login-state', 'session-state',
                       'click', 'click-and-await-fill', 'enter-text', 'press-key']);
  // Act-verb ARITY is checked HERE, above runRaw(), because die() exits synchronously: the same check inside
  // the raw switch fires AFTER an ephemeral/--new tab has been minted and strands it (only the catch closes
  // that tab), so `browse --new upload-file '#f'` leaked a blank tab per call.
  // `--out -` streams bytes on the other capture verbs. Here it cannot: SingleFile writes the file itself,
  // through the browser's download path, and never hands us the bytes. Reject rather than quietly file it.
  if (verb === 'save-page' && flags.out === '-')
    die('save-page cannot stream (--out -): SingleFile writes the .html through the browser\'s own download '
      + 'path, so there are no bytes to pipe. Give a name/path instead, then copy it off the box');
  // save-page with NO url saves the tab you are already on — but an anon/--new caller has only a fresh
  // about:blank, so it would dutifully capture a blank page and report success. Demand the url on that path.
  if (verb === 'save-page' && !pos[0] && ephemeral)
    die('save-page needs <url> on an anon/--new call (there is no existing tab to save) — `browse save-page '
      + '<url> [--out <path>]`; the no-url form saves THIS session\'s current tab');
  // ---- STABLE REFS: which verbs take one, and the arity that follows. With --ref the SELECTOR positional is
  // gone (the ref names the element), so `enter-text --ref 7 hello` has the text at pos[0] rather than pos[1].
  // Both mistakes are refused by name here, before a tab is minted: a ref on a verb that has no target, and a
  // ref alongside a selector (which of the two did the caller mean? guessing is how you click the wrong thing).
  const REF_OK = new Set(['click', 'enter-text', 'press-key', 'upload-file', 'get-text']);
  if (flags.ref !== null) {
    if (!REF_OK.has(verb))
      die('--ref does not apply to "' + verb + '" (valid: ' + [...REF_OK].join(', ') + ') — a ref names ONE element '
        + 'from `browse snapshot`; the other verbs address the tab or the browser');
    if (anon || flags.new)
      die('--ref needs a persistent tab: an anon/--new call gets a THROWAWAY tab, and a ref into a tab that is '
        + 'closed at the end of the call could never resolve. Run through the `browse` wrapper (which tags your '
        + 'session)');
  }
  const refArg = (i) => (flags.ref !== null ? pos[i - 1] : pos[i]);   // positional index, shifted by an absent selector
  if (verb === 'enter-text') {
    if (flags.ref !== null) { if (!pos.length) die('enter-text --ref <n> needs <text>'); }
    else if (!pos[0] || pos.length < 2)                      die('enter-text needs <selector> <text>');
  }
  if (verb === 'click') {
    if (flags.ref !== null) { if (pos.length) die('click --ref <n> takes no selector (got "' + pos[0] + '") — the ref IS the target'); }
    else if (!pos[0])                                        die('click needs <selector>');
  }
  // press-key sends the NAMED CONTROL KEYS in KEY_MAP and nothing else, on both the selector and the --ref
  // form. A single character (`press-key '#q' a`) and a modifier chord (`Shift+Enter`) are refused BY NAME
  // here — before a tab is minted — rather than dying deeper in with an unsupported-key throw.
  if (verb === 'press-key') {
    if (flags.ref !== null) { if (!pos[0]) die('press-key --ref <n> needs <key>'); }
    else if (!pos[0] || !pos[1])                             die('press-key needs <selector> <key>');
    const pk = refArg(1) || '';
    if (!Object.hasOwn(KEY_MAP, pk))
      die('press-key sends the control keys ' + Object.keys(KEY_MAP).join(', ') + ' — not "' + pk + '". '
        + 'To put CHARACTERS in a field use `browse enter-text`, which clears it and types the value as one '
        + 'trusted insert. A modifier chord such as Shift+Enter has no path in this tool at all — both forms '
        + 'used to fall through to Playwright, which is gone');
  }
  if (verb === 'upload-file') {
    if (flags.ref !== null) { if (!pos[0]) die('upload-file --ref <n> needs <path>'); }
    else if (!pos[0] || !pos[1])                             die('upload-file needs <selector> <path>');
  }
  if (verb === 'get-text' && flags.ref !== null && pos.length)
    die('get-text --ref <n> takes no selector (got "' + pos[0] + '") — the ref IS the element to read');
  // snapshot: an optional SCOPE selector and nothing else. Refused on a throwaway tab for the same reason
  // --ref is: the refs it hands back would be dead before the caller could use them.
  if (verb === 'snapshot') {
    if (pos.length > 1) die('snapshot takes at most one <scopeSelector> (got ' + pos.length + ' arguments)');
    if (anon || flags.new)
      die('snapshot needs a persistent tab: an anon/--new call gets a THROWAWAY tab that is closed at the end of '
        + 'this call, so every ref it printed would already be dead. Run through the `browse` wrapper (which tags '
        + 'your session)');
  }
  // --frame: refused at the boundary rather than half-honored. A flag silently ignored by a verb is the worst
  // outcome here — the caller would read an exit 0 from a click that went into the TOP document instead.
  if (flags.frame !== null) {
    if (!FRAME_VERBS.includes(verb))
      die('--frame is not supported by ' + verb + ' (supported: ' + FRAME_VERBS.join(', ') + '). get-html is '
        + 'excluded on purpose: a cross-origin frame is where card numbers and passcodes are typed, and '
        + 'serialized HTML carries value attributes with them — use get-text --frame');
  }
  if (verb === 'download'    && !pos[0])                     die('download needs <url|selector>');
  // Browser-internal pages show saved passwords, settings and other tabs' data: never an agent's to open.
  if (verb === 'open-url' && /^\s*(chrome|chrome-untrusted|chrome-extension|chrome-search|devtools|edge|brave|view-source|javascript|about)\s*:/i.test(pos[0] || '')
      && !/^\s*about:blank\s*$/i.test(pos[0]))
    die('open-url refuses browser-internal pages (chrome://, edge://, devtools://, view-source:, javascript:, about:)');
  // The dismiss verb names its target with a FLAG, not a positional, so `browse native-browser-prompts-dismiss
  // Allow` must fail loudly instead of pressing nothing and exiting 0 — the exact silent-success this pair of
  // verbs exists to end.
  if (verb === 'native-browser-prompts-view' && pos.length)
    die('native-browser-prompts-view takes no arguments (it lists the NATIVE browser prompts currently showing)');
  if (verb === 'native-browser-prompts-dismiss') {
    if (pos.length)            die('native-browser-prompts-dismiss names its button with --button, not a '
                                 + 'positional: `browse native-browser-prompts-dismiss --button ' + pos[0] + '`');
    if (flags.button === null) die('native-browser-prompts-dismiss needs --button <name> — run `browse '
                                 + 'native-browser-prompts-view` first to read the exact button labels');
    if (!flags.button)         die('native-browser-prompts-dismiss: --button cannot be empty');
  }
  // Same contract as its sibling, and for the same reason: name the target with the flag, never a positional,
  // so a caller who types the wrong shape is told so instead of having something pressed on their behalf.
  if (verb === 'native-browser-prompts-choose') {
    if (pos.length)              die('native-browser-prompts-choose names the row with --username (a saved '
                                   + 'password) or --card (a saved card, by last four), not a positional: '
                                   + '`browse native-browser-prompts-choose --username ' + pos[0] + '`');
    if (flags.username === null && flags.card === null)
                                 die('native-browser-prompts-choose needs --username <account> or --card <last '
                                   + 'four> — run `browse native-browser-prompts-view` first to read what the '
                                   + 'popup is offering (saved cards are listed as "card ••••<last four>")');
    if (flags.username !== null && !flags.username.trim())
                                 die('native-browser-prompts-choose: --username cannot be empty (it would match '
                                   + 'nothing, and an empty match must never fall through to picking a row)');
  }
  if (verb === 'click-and-await-fill') {   // same reason, plus its optional fill window (parsed at cafTimeoutMs)
    if (!pos[0] || !pos[1]) die('click-and-await-fill needs <clickSelector> <targetSelector> [timeoutMs]');
    if (!Number.isInteger(cafTimeoutMs) || cafTimeoutMs < 0)
      die('click-and-await-fill: timeoutMs must be a non-negative integer, got ' + pos[2]);
  }
  // login: --list answers with NO browser at all, and a site name is resolved + validated HERE so a typo, a
  // malformed registry or a known-blocked site costs neither a CDP connect nor a minted tab.
  if (verb === 'login') {
    if (flags.list) {
      if (pos.length) die('login --list takes no site name (it names EVERY enrolled site; `browse login <site>` logs into one)');
      const sites = loadLoginRegistry();
      // Site names, status and cause code. NOTHING else — no username, no realm, no note, no hint of what any
      // credential is. The inventory answers "what can I log into", which is the whole question, and answering
      // more would make the discovery affordance its own small disclosure.
      out({ sites: Object.entries(sites).map(([site, e]) => (e.blocked ? { site, status: 'blocked', cause: e.blocked }
                                                                       : { site, status: 'enrolled' })) });
      return finish(0);
    }
    if (!pos[0]) die('login needs <site> — `browse login --list` names every enrolled site. It takes NO password '
      + 'and accepts none: the credential is Chromium\'s own saved one and the browser sends it itself');
    // THE HARD PROPERTY, enforced at the argument boundary: this verb has exactly one argument. A second
    // positional is refused by name, because the ONE thing it would ever be is the thing that must never be
    // typed — and a password in argv is already in the transcript before node starts.
    if (pos.length > 1) die('login takes ONE site name and nothing else (got ' + pos.length + ' arguments). It NEVER '
      + 'takes a password: the credential comes from the browser\'s own saved store, not from you or from any '
      + 'oracle. If you were about to pass one, that is the exact behavior this verb exists to eliminate');
    const sites = loadLoginRegistry();
    if (!Object.hasOwn(sites, pos[0]))   // hasOwn, NOT sites[name]: inherited proto members are truthy (KEY_MAP lesson)
      die('login: "' + pos[0] + '" is not enrolled — enrolled sites: ' + Object.keys(sites).join(', ')
        + ' (`browse login --list` for their status). Do NOT work around this by fetching a credential: if the '
        + 'site should be here, add it to the registry (' + LOGIN_REGISTRY + ') and deploy.');
    loginSite = sites[pos[0]];
    // Known-blocked: the cause is already established (from the saved-store metadata or a measured probe), so
    // report it WITHOUT navigating. A blocked site that quietly tried anyway would teach a caller to retry.
    if (loginSite.blocked)
      die('login: ' + loginErr(pos[0], loginSite.blocked, loginSite.note || 'declared known-blocked in the registry'));
    // ---- CHOOSER-DRIVEN SITES. `username` in the registry declares one, `--account` names the row, and the two
    // are required TOGETHER — both halves of the mismatch are refused here, before a tab exists, because either
    // one alone would otherwise fail deep in the flow with a cause code that describes a symptom instead of the
    // mistake. Without --account the site cannot resolve WHICH credential to send, and picking one would be a
    // guess; with it on an ordinary site there is no chooser for it to name a row in.
    if (flags.account !== null && flags.account !== undefined && !String(flags.account).trim())
      die('login: --account cannot be empty — it names WHICH saved account to pick out of the browser\'s '
        + 'account picker, and an empty name would match nothing while looking like a choice');
    if (loginSite.username && !flags.account)
      die('login: "' + pos[0] + '" holds MORE THAN ONE saved account, so it needs `browse login ' + pos[0]
        + ' --account <email>` to say which one. Chromium shows its native account picker on this realm instead '
        + 'of filling, and choosing a row for you would be a guess about which credential to send. The account '
        + 'is yours to name — it is deliberately NOT recorded in the registry, which holds selectors and urls '
        + 'only. Do NOT fetch a credential: the password still comes from the browser\'s own saved store');
    if (flags.account && !loginSite.username)
      die('login: "' + pos[0] + '" is not a chooser-driven site — it declares no username field, so there is no '
        + 'account picker for --account to name a row in. Drop the flag: `browse login ' + pos[0] + '`');
    // The chooser path is ONE gate-and-submit by construction (raise the picker, choose, submit), so a
    // multi-round site would silently get only its first step. Refuse rather than half-do it.
    if (flags.account && loginSite.rounds > 1)
      die('login: "' + pos[0] + '" declares rounds=' + loginSite.rounds + ', and the --account chooser path is '
        + 'built for a single gate-and-submit. Nobody has measured a two-step login behind an account picker; '
        + 'do not assume it works');
  }
  // ONE dispatch, one path. An unknown verb dies HERE rather than after a tab has been minted for it.
  if (!RAW.has(verb)) die('unknown verb: ' + verb);
  await runRaw();
})().catch((e) => die((verb || '?') + ': ' + (e.message || e)));

// ---- --wait on a READ verb: poll the read until it stops saying "not there yet" ---------------------------
// THE ASYMMETRY THIS CLOSES. The act verbs have always auto-waited; the read verbs never have, so the obvious
// two-step — click a control, then read the result it renders — races the render and dies with "selector not
// found" on a value that arrives 200ms later. The caller's only recourse was a sleep.
// OPT-IN, AND THAT IS THE WHOLE DESIGN. Making reads wait BY DEFAULT would break the opposite and equally
// legitimate use: asserting a thing is ABSENT (a spinner gone, an error banner never shown), where the honest
// answer is "not there" and any wait is pure cost — 30s of it, while holding the global flock. So the default
// stays exactly what it was, one shot, and `--wait <ms>` is how a caller says which question it is asking.
// ONE DEADLINE FOR THE WHOLE VERB, not per selector: get-values takes N selectors, and a per-selector budget
// would multiply the wait by N — five missing selectors at the 30s default is two and a half minutes of held
// lock. So the deadline is armed at the first poll and shared by every later one.
let READ_WAIT_DEADLINE = null;
async function readWithWait(read, missing) {
  if (flags.wait === null) return read();          // --no-wait and the default are both one shot — no change
  if (READ_WAIT_DEADLINE === null) READ_WAIT_DEADLINE = Date.now() + WAIT_MS;
  for (;;) {
    const r = await read();
    // Return the LAST read on timeout rather than throwing here: each call site already has its own die() with
    // the wording that verb's callers know, and a second error shape for the same condition helps nobody.
    if (!missing(r) || Date.now() >= READ_WAIT_DEADLINE) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
}

// ---------------------------------------------------------------------------------------
// RAW verb dispatch. Every path funnels errors through die(verb+': '+msg).
// ---------------------------------------------------------------------------------------
async function runRaw() {
  // restart-browser owns its OWN connect: it must still work when the browser is DOWN — a dead browser is
  // exactly when you reach for it, so it cannot sit behind the "cannot connect to CDP" abort below.
  if (verb === 'restart-browser') return restartBrowser();
  // Same reasoning for the AT-SPI pair, and it is the stronger case: you reach for the view verb precisely
  // when CDP calls are hanging or returning nonsense, so it must not queue behind a CDP connect of its own.
  // It needs no CDP session at all — the port only identifies which process to read out of the a11y tree.
  if (verb === 'native-browser-prompts-view' || verb === 'native-browser-prompts-dismiss') return nativeBrowserPromptVerb();

  let browser;
  try { browser = await connectBrowser(); }
  catch (e) { die('cannot connect to CDP ' + CDP + ' (' + (e.message || e) + ') — is the agent browser up? (schtasks /Run /TN ' + RESTART_TASK + ')', 2); }

  // ---- browser-only verbs (no page target) ----
  try {
    if (verb === 'browser-status') { // READ-ONLY precheck — never opens or changes anything
      const targets = await listPageTargets(browser);
      const live = new Set(targets.map((t) => t.targetId));
      const map = loadMap();
      let url = null, tt = { title: null };
      if (sessionKey && map[sessionKey] && live.has(map[sessionKey])) {
        const t = targets.find((x) => x.targetId === map[sessionKey]);
        if (t) { url = t.url; tt = tabTitle(t); }        // a never-loaded tab reports its url as its title — suppress it
      }
      out({ up: true, tabs: targets.length, session: sessionKey, url: redactUrl(url), ...tt });
      browser.close(); return finish(0);
    }

    if (verb === 'list-tabs') { // tag each tab with its owning session (so a mis-aimed close is visible/avoidable)
      const targets = await listPageTargets(browser);
      const map = loadMap();
      const owner = {}; for (const [k, v] of Object.entries(map)) owner[v] = k; // targetId → session
      // targetId is REPORTED, not just used internally: it is the only thing `close-tabs --target` accepts, so
      // withholding it would leave the one scope that can close an unowned tab with no supported way to name
      // one — the caller would be pushed back to raw CDP, which is what that scope exists to replace. It also
      // completes this verb's own stated purpose above: a mis-aimed close is only avoidable if you can see
      // WHICH tab you are about to name. `dismiss-dialog` already reports it the same way.
      const tabs = targets.map((t) => ({ targetId: t.targetId, url: redactUrl(t.url), ...tabTitle(t),
                                         session: owner[t.targetId] || null }));
      out({ tabs });
      browser.close(); return finish(0);
    }

    if (verb === 'dismiss-dialog') {
      // Recover a tab frozen by a native JS dialog, and — just as valuable — RULE IT OUT. Browser-WIDE by
      // design: the frozen tab is normally the one ANOTHER session was driving (that session's call is what
      // hung holding the wrapper's lock), so probing only this session's tab would miss it. Probes run in
      // parallel on their own sockets; a healthy tab answers in milliseconds, only a frozen one costs PROBE_MS.
      const targets = await listPageTargets(browser);
      const probes = await Promise.all(targets.map(async (t) => ({ t, p: await probeTarget(t.targetId) })));
      const desc = ({ t, p }) => ({ url: redactUrl(t.url), ...(p.title ? { title: p.title } : tabTitle(t)), targetId: t.targetId });
      // A LAZY tab is silent for the same reason a frozen one is — but for the opposite cause: it has NO
      // RENDERER, so there is no dialog on it and nothing a keystroke can help. Before this split, every
      // never-loaded restored tab landed in `frozen` (measured: dozens at once in a lab restore), and a real
      // run would then have ACTIVATED each and pressed a blind Return at the X layer — one
      // foreground steal and one stray keystroke per tab on the live browser, any of which can land in a page a
      // human is using. That is the precise harm the "never press with nothing frozen" rule exists to stop,
      // walked straight past because the count was not zero.
      // Told apart by the url-placeholder title (see isUrlPlaceholderTitle): a tab that once loaded keeps its
      // real title in the browser-side target info even after its renderer jams, so a real title means it
      // rendered something and a placeholder means it never did. It is a heuristic, and it is pointed the
      // safe way — its only failure is declining to press a key on a genuinely frozen tab whose title happens
      // to equal its own url, which is REPORTED, not silently dropped. Never woken: the whole point is that
      // this verb touches nothing.
      const silent = probes.filter((x) => x.p.frozen);
      const lazy = silent.filter((x) => isUrlPlaceholderTitle(x.t.title, x.t.url));
      const frozen = silent.filter((x) => !isUrlPlaceholderTitle(x.t.title, x.t.url));
      const lazyNote = lazy.length ? lazy.length + ' tab(s) are silent because they have NO RENDERER — '
        + 'session-restored tabs Chromium never loaded. They are NOT frozen, no key was pressed on them, and '
        + 'nothing is wrong with them: a verb aimed at one wakes it on demand.' : null;

      // --probe-only, and the nothing-frozen case, change NOTHING. Never press a key on a browser with no
      // frozen tab: a blind Return would land in whatever page is foreground — in the worst case a form a human
      // is filling in. "Nothing frozen" is also a real answer, so it names the other suspect explicitly.
      if (flags.probeOnly || !frozen.length) {
        const o = { tabs: targets.length, frozen: frozen.map(desc), via: 'none' };
        if (lazy.length) { o.lazy = lazy.map(desc); o.lazyNote = lazyNote; }
        if (flags.probeOnly) o.probeOnly = true;
        // ASK THE OTHER LAYER BEFORE BLAMING THE HEAVY-TAB WEDGE. "No frozen renderer" used to be reported as
        // proof that no native prompt was involved, and that is simply not true: Chromium's PRINT PREVIEW
        // (what a page's window.print() raises) leaves the tab unusable — every act verb on it times out —
        // while the target still ANSWERS Runtime.evaluate, so it lands here and the caller was sent to the
        // wrong suspect entirely. Measured on a throwaway browser: get-text timed out four times
        // running while this branch said "suspect the heavy-tab wedge". The probe is pid-scoped to THIS
        // browser and costs one shell-out on a path that was about to give an answer anyway.
        if (!frozen.length) {
          const a = atspiProbe();
          const seen = a.code !== 0 ? []
            : (Array.isArray(a.json) ? a.json : (a.json && Array.isArray(a.json.prompts) ? a.json.prompts : []));
          // Same classifier session-state uses, deliberately — one definition of "this blocks", not two that
          // can drift. It already excludes a permanent buttonless Infobar.
          const blocking = seen.filter(sessionPromptBlocks);
          if (blocking.length) {
            o.nativePrompts = blocking;
            o.note = 'no frozen renderer, BUT Chromium is showing browser UI in front of the page: '
              + blocking.map((p) => '"' + (p.name || p.role) + '"').join(', ') + '. That is why a verb on this '
              + 'tab can hang while every renderer answers — the prompt is drawn outside the page and THIS '
              + 'verb cannot press it. Read it with `browse native-browser-prompts-view`, then clear it with '
              + '`browse native-browser-prompts-dismiss --button <name>`. Do NOT read this as the heavy-tab wedge';
          } else if (a.code !== 0) {
            // "Could not check" must never render as "checked and clear" — the rule the whole a11y path follows.
            o.note = 'no frozen renderer (every tab with a renderer answered Runtime.evaluate), but the '
              + 'NATIVE-PROMPT read FAILED (' + (a.err || 'unknown') + '), so browser UI in front of the page '
              + 'could NOT be ruled out on this run. Try `browse native-browser-prompts-view` before suspecting '
              + 'the heavy-tab wedge (browse list-tabs → browse close-tabs --stale)';
          } else {
            o.note = 'no frozen renderer (every tab with a renderer answered Runtime.evaluate) and no native '
              + 'browser-chrome prompt is showing either — a stalled browse call is NOT a dialog here: suspect '
              + 'the heavy-tab wedge (browse list-tabs → browse close-tabs --stale)';
          }
        }
        out(o);
        browser.close(); return finish(0);
      }

      // Read ONCE, before the loop, and restored ONCE after it. Per-tab restore would be wrong twice over:
      // with several frozen tabs it would bounce the human's screen between their tab and ours on every lap,
      // and after the first lap the "previous" reading would be OUR OWN last tab rather than theirs.
      const prevFront = await frontmostTargetId();
      const cleared = [], stuck = [];
      let usedCdp = false, usedX = false, lastActivated = null;
      for (const f of frozen) {
        const cdp = await cdpAcceptDialog(f.t.targetId);   // only works while a LIVE session still owns the dialog
        let via = null, x = null;
        if (cdp.ok && !(await probeTarget(f.t.targetId)).frozen) { via = 'cdp'; usedCdp = true; }
        if (!via) {
          // X layer. Activate THIS target first — Target.activateTarget is handled in the browser process, so a
          // jammed renderer cannot block it (the property screenshot relies on) — and it is also what maps the
          // tab to an X window: the window holding it becomes the ACTIVE window, which xPressReturn then proves
          // belongs to this browser before pressing anything.
          try { await browser.send('Target.activateTarget', { targetId: f.t.targetId }, 10000); } catch (_) {}
          lastActivated = f.t.targetId;
          try { x = xPressReturn(); } catch (e) { x = { error: String(e.message || e) }; }
          if (x.pressed) {
            await new Promise((r) => setTimeout(r, 500));  // the renderer resumes a beat after the button
            if (!(await probeTarget(f.t.targetId)).frozen) { via = 'x'; usedX = true; }
          }
        }
        const rec = { ...desc(f), via };
        if (via !== 'cdp') rec.cdp = cdp.ok ? 'accepted but still frozen' : cdp.error;   // "No dialog is showing" ⇒ orphan
        if (x) rec.x = x;
        (via ? cleared : stuck).push(rec);
      }
      // Every keystroke has landed and every result has been read, so the foreground can go back. AFTER the
      // loop and not inside it: xPressReturn aims at whatever X window is active, so re-activating another
      // tab while a press is still pending is how a Return ends up in the wrong page — the exact accident
      // xPressKey's ownership proof exists to prevent, and one that proof would NOT catch, because the wrong
      // tab would still belong to the right browser. Before the `stuck` die() as well as the success exit: a
      // run that failed to clear the dialog stole the foreground just the same.
      await restoreForeground(browser, prevFront, lastActivated);
      const via = usedX ? (usedCdp ? 'cdp+x' : 'x') : (usedCdp ? 'cdp' : 'none');
      if (stuck.length) {
        browser.close();
        die('dismiss-dialog: ' + stuck.length + ' of ' + frozen.length + ' tab(s) STILL frozen — ' + JSON.stringify(stuck)
          + ' — read the per-tab `cdp`/`os` reasons, then look at the browser on this machine\'s own screen: an OS '
          + 'press SKIPPED means the foreground window did not belong to this browser (nothing was typed); a dialog still '
          + 'on screen after a press means the default button was not focused; no dialog on screen at all means the '
          + 'renderer is hung for another reason and only `browse restart-browser` (DROPS every tab) clears it');
      }
      const done = { tabs: targets.length, frozen: frozen.map(desc), via, cleared };
      if (lazy.length) { done.lazy = lazy.map(desc); done.lazyNote = lazyNote; }
      out(done);
      browser.close(); return finish(0);
    }

    if (verb === 'close-tabs') {
      // FAIL-SAFE: only ever close a tab the caller confidently OWNS.
      //   default    → close THIS session's own tab (BROWSE_SESSION). Anon/no owned tab → close NOTHING.
      //   --stale    → close abandoned file:// tabs only (manual heavy-tab-wedge cleanup), never a registered tab.
      //   --agents   → close EVERY agent/session tab (everything registered in the map); KEEP unowned tabs
      //                (always-open human tabs are unowned, so they survive a maintenance sweep).
      //   --target   → close ONE tab named by targetId, INCLUDING an unowned human tab — the only scope that
      //                can, hence the refusals it carries.
      const map = loadMap();
      const targets = await listPageTargets(browser);
      const ensureOne = async () => {
        if (!(await listPageTargets(browser)).length) await browser.send('Target.createTarget', { url: 'about:blank' });
      };
      if (flags.target) {
        // ONE named tab, by EXACT targetId or a unique PREFIX of one: this is the one scope that can reach a
        // tab the caller does not own, so it must never guess. DELIBERATELY NO url/title matching: a URL pattern
        // is precisely how an always-open human tab gets closed by accident ("it matched my pattern").
        const want = String(flags.target);
        const hits = targets.filter((t) => t.targetId === want || t.targetId.startsWith(want));
        if (!hits.length)
          die('close-tabs --target: no page target matches ' + want + ' — run `browse list-tabs` for the live ids');
        if (hits.length > 1)
          die('close-tabs --target: ' + hits.length + ' page targets match the prefix ' + want
            + ' — refusing to guess which one you meant. Matches: ' + hits.map((t) => t.targetId).join(', '));
        const tgt = hits[0];

        // LAST TAB: refuse BEFORE closing, never repair after. Measured on a throwaway HEADFUL
        // Chrome on its own Xvfb display — closing the only page target took CDP down with it. The same test
        // on HEADLESS survived, which is exactly why this is measured rather than assumed. This browser is
        // headful, so ensureOne() after the fact is a race, not a guard.
        if (targets.length === 1)
          die('close-tabs --target: that is the ONLY tab open, and closing the last tab exits this browser '
            + '(measured headful). Open a replacement tab first, then close this one.');

        // Cross-session: a mapped tab belongs to somebody, and closing it destroys their work mid-flow.
        const owner = Object.keys(map).find((k) => map[k] === tgt.targetId);
        if (owner && owner !== sessionKey && !flags.anySession)
          die('close-tabs --target: ' + tgt.targetId + ' is owned by session ' + owner + ' — refusing to close '
            + "another session's tab. Pass --any-session if you are deliberately reaping it.");

        try { await browser.send('Target.closeTarget', { targetId: tgt.targetId }); }
        catch (e) { die('close-tabs --target: ' + tgt.targetId + ' did not close: ' + e.message); }

        // MAP HYGIENE: drop EVERY key pointing at the tab just closed, not only the caller's — a stale entry
        // would otherwise resolve to a dead target on the owner's next call.
        let dropped = 0;
        for (const k of Object.keys(map)) if (map[k] === tgt.targetId) { delete map[k]; dropped++; }
        if (dropped) { try { saveMap(map); } catch (_) {} }

        out({ closed: 1, scope: 'target', targetId: tgt.targetId, url: redactUrl(tgt.url),
              owner: owner || null, mapEntriesDropped: dropped });
      } else if (flags.agents) {
        const owned = new Set(Object.values(map)); // a tab in the map = owned by some agent/session
        let closed = 0;
        for (const t of targets) {
          if (!owned.has(t.targetId)) continue; // unowned (human/persistent) tab → leave it open
          try { await browser.send('Target.closeTarget', { targetId: t.targetId }); closed++; } catch (_) {}
        }
        try { saveMap({}); } catch (_) {} // all agent tabs gone
        await ensureOne(); // never hit 0 tabs (if there were no unowned tabs to keep)
        out({ closed, scope: 'agents', kept: 'unowned (human/persistent) tabs' });
      } else if (flags.stale) {
        const keepIds = new Set(Object.values(map));
        let closed = 0;
        for (const t of targets) {
          if (!/^file:\/\//.test(t.url)) continue;
          if (keepIds.has(t.targetId)) continue; // never reap a registered session tab
          try { await browser.send('Target.closeTarget', { targetId: t.targetId }); closed++; } catch (_) {}
        }
        await ensureOne();
        out({ closed, scope: 'stale' });
      } else if (sessionKey && map[sessionKey]) {
        let closed = 0;
        const live = new Set(targets.map((t) => t.targetId));
        if (live.has(map[sessionKey])) {
          try { await browser.send('Target.closeTarget', { targetId: map[sessionKey] }); closed++; } catch (_) {}
        }
        delete map[sessionKey]; try { saveMap(map); } catch (_) {}
        await ensureOne();
        out({ closed, scope: 'session', session: sessionKey });
      } else {
        // anon, or this session owns no tab → close NOTHING (never nuke other sessions' or human tabs)
        out({ closed: 0, scope: 'none',
              note: anon ? 'anon caller owns no tab — use --agents to reap all agent tabs'
                         : 'this session owns no tab' });
      }
      browser.close(); return finish(0);
    }

    // ---- page-target verbs: resolve/create the target tab, drive it over a raw per-target ws ----
    //   download <url>   ⇒ a THROWAWAY tab as well (downloadIsUrl): a URL download must never navigate the
    //                      caller's own tab, and it must work for a session that owns no tab at all.
    //   otherwise        ⇒ THIS session's tab (or a throwaway for --new/anon)
    let resolved;
    try {
      resolved = await resolveTarget(browser, ephemeral || downloadIsUrl, sessionKey);
    } catch (e) { browser.close(); die(verb + ': ' + (e.message || e)); }
    const { targetId, temp = false, created } = resolved;

    // BLANK-CAPTURE GUARD: if a persistent session's mapped tab was GONE and we had to
    // mint a fresh about:blank, a READ/CAPTURE verb would silently return blank content — a print2pdf on a
    // vanished tab would yield a blank-but-valid %PDF a caller keeps as the real file. Fail loud
    // instead. open-url is exempt (it's about to navigate the fresh tab); ephemeral (--new/anon) is the
    // intentional throwaway path and is exempt.
    if (created && !ephemeral && verb !== 'open-url' && verb !== 'login') {
      try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {} // don't leak the just-minted blank
      browser.close();
      die(verb + ': this session has no live tab (open-url first)');
    }

    // wrong-tab guard (opt-in --expect-url): refuse to act on a tab whose url doesn't match. open-url is
    // exempt (it's about to set the url). Uses the browser-level target url (no renderer eval → wedge-safe).
    // !temp rather than !ephemeral: a throwaway tab has nothing to verify, and a URL download's tab is one too
    // (for every other verb temp IS ephemeral, so nothing else changes).
    if (flags.expectUrl && !temp && verb !== 'open-url') expectOk(resolved.url);

    // close an ephemeral/--new tab no matter how we exit; do NOT touch persistent tabs.
    const closeTemp = async () => { if (temp) { try { await browser.send('Target.closeTarget', { targetId }); } catch (_) {} } };

    let tcdp;
    try { tcdp = await connectTarget(targetId); }
    catch (e) { await closeTemp(); browser.close(); die(verb + ': cannot attach to tab (' + (e.message || e) + ')'); }

    // LAZY TAB, WOKEN ON DEMAND (see ensureRenderer). Every verb below this line ends up talking to the
    // renderer, so the check is here rather than repeated per-verb — including open-url, whose rawGoto blocks
    // on `Page.enable` before it ever gets to Page.navigate. Costs ONE Page.getFrameTree (~4ms) when the tab
    // is awake, which is every ordinary call. Reported on STDERR, not in the JSON: waking is a real side
    // effect on a browser other sessions are watching and it should be visible, but stdout stays the verb's
    // own contract. Deliberately NOT a sweeper over every tab — waking one costs a whole renderer's memory and a long-lived browser
    // can carry many restored tabs, so tabs are woken only when somebody actually uses them.
    // NOTE for print2pdf, which the screenshot case below is careful to say never needs an activate: that
    // still holds for a tab that HAS a renderer. A tab with none has nothing to print, so print2pdf pays the
    // activate too — but only in the case where it could not have worked at all.
    try {
      const w = await ensureRenderer(browser, tcdp, targetId);
      if (w.woke) fs.writeSync(2, 'note: ' + verb + ': target had no renderer (session-restored tab Chromium '
        + 'never loaded) — activated it and waited ' + w.ms + 'ms for the page to become usable\n');
    } catch (e) {
      await closeTemp(); tcdp.close(); browser.close();
      die(verb + ': ' + (e.message || e));
    }

    // ---- STABLE REF → a live element, pinned for this call (see STABLE ELEMENT REFS). Resolved HERE, once,
    // after the renderer is known good and before any verb runs: a dead ref must cost nothing but a loud exit.
    // die() inside resolveRef is fine at this point — the tab is this session's own persistent one (a ref is
    // refused on the anon/--new path precisely because that tab would need closing), so nothing leaks.
    // ---- --frame: swap the surface the act/read verbs run against, BEFORE the ref is resolved (a ref taken
    // inside a frame must be resolved inside that same frame). `acdp` is tcdp itself whenever --frame is
    // absent, so every verb below is byte-for-byte on its old path when the flag is not used. See FRAME REACH.
    let frameSurface = null;
    let acdp = tcdp;
    if (flags.frame) {
      try { frameSurface = await resolveFrameSurface(browser, tcdp, flags.frame); acdp = frameSurface.cdp; }
      catch (e) { await closeTemp(); tcdp.close(); browser.close(); die(verb + ': ' + (e.message || e)); }
    }

    let refTarget = null;
    if (flags.ref !== null) refTarget = await resolveRef(acdp, targetId, refKey(), flags.ref);
    const aim = (sel) => refTarget || sel;      // every ref-capable verb aims at the ref when one was given

    try {
      switch (verb) {

        case 'snapshot': {
          // A compact labeled map of what is actually on the page, each row carrying a STABLE ref. Read-only:
          // it walks the DOM, records identities, and changes nothing (the one global it stashes the elements
          // in is deleted again before it returns).
          const r = await takeSnapshot(acdp, targetId, refKey(), pos[0] || null);
          out(r);
          break;
        }

        case 'open-url': {
          const url = pos[0]; if (!url) die('open-url needs <url>');
          const r = await rawGoto(tcdp, url);
          out({ url: redactUrl(r.url), title: r.title, status: r.status });
          break;
        }

        case 'get-text': {
          const sel = pos[0];
          const expr = refTarget
            ? `(function(){var el=${elJS(refTarget)};return el?el.innerText:null;})()`
            : (sel
              ? `(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.innerText:null;})()`
              : 'document.body.innerText');
          // null = the selector matched nothing (the expr's own miss value), so that is what --wait polls on.
          // An unserializable read is a DIFFERENT outcome, not a miss, and must never be retried into a timeout.
          const ev = await readWithWait(() => evalInTarget(acdp, expr),
                                        (r) => !r.unserializable && r.value === null);
          if (ev.unserializable) { out(ev.payload); break; }
          if (ev.value === null) die(refTarget ? targetName(refTarget) + ' no longer resolves' : 'selector not found: ' + sel);
          out({ text: ev.value });
          break;
        }

        case 'get-html': {
          const sel = pos[0];
          const expr = sel
            ? `(function(){var el=document.querySelector(${JSON.stringify(sel)});return el?el.outerHTML:null;})()`
            : 'document.documentElement.outerHTML';
          const ev = await readWithWait(() => evalInTarget(tcdp, expr),
                                        (r) => !r.unserializable && r.value === null);
          if (ev.unserializable) { out(ev.payload); break; }
          if (ev.value === null) die('selector not found: ' + sel);
          out({ html: ev.value });
          break;
        }

        case 'get-values': { // read each input's LIVE .value; with sel==expected, DIE non-zero on mismatch —
          if (!pos.length) die('get-values needs <selector[==expected]> ...');  // the pre-submit assertion that
          const values = {}, mism = [];                                         // catches an AJAX-reverted field.
          // CREDENTIAL FIELDS ARE WITHHELD, and the refusal lives INSIDE the page eval, not out here. A
          // type="password" field, or any field carrying Chromium's autofill marker, returns
          // {selector,filled,withheld} in place of its string — so the value never crosses the CDP
          // boundary at all: it is never in a variable node can print, log, or fold into an exception message.
          // WHY THE VERB AND NOT THE CALLER: a caller can pipe this verb through a hand-written redactor such as
          // `sed 's/"value":"[^"]*"/…/'` and still print a live password IN FULL, because the verb emits the
          // NESTED "values":{…} shape and the redactor was watching for "value":"…". Guessing a tool's output
          // shape from memory is a coin flip, so the verb itself must not emit the secret.
          // NO CHARACTER COUNT EITHER. An exact count of a password IS disclosure: partial information about a
          // secret is still information. login-state and click-and-await-fill draw the same line.
          // WHAT REPLACES IT is the boolean `filled`, chosen over the two richer candidates on purpose. A
          // coarse bucket (empty/short/long) still narrows a search space, still fixes a known threshold in
          // the output, and still cannot see a change that stays inside its own bucket — it discloses
          // something and buys nothing. A salted digest, comparable across two reads, would have to be
          // computed IN-PAGE to keep the value off the CDP boundary at all, which means injecting a
          // long-lived comparison salt into whatever third-party page happens to be loaded and letting that
          // page's own JS read it back out of the injected source — handing a site the means to rainbow its
          // visitors' saved passwords. Neither is worth it, because `filled` already answers the question the
          // mismatch message exists for: is the field EMPTY, or does it hold something that is not what you
          // expect. A caller who knows the value it should hold still gets an exact verdict from ==expected.
          // WHAT IS GENUINELY LOST: telling "it changed" from "it is unchanged" for a value the caller does
          // NOT know (an autofilled password nobody typed). Accepted — that is a comparison oracle on a
          // credential, which is the thing being refused, and Chromium fills one saved credential per origin,
          // so the real revert failure mode is the field going EMPTY, which `filled` catches exactly.
          // HONEST LIMIT: this guards the OUTPUT channel only. `get-values '#password==<the value>'` puts the
          // expected value in argv, i.e. in the transcript, before node starts — nothing here can un-leak that.
          // Non-password, non-autofilled fields are untouched: they return their string exactly as before
          // (the pre-submit assertion on ordinary form inputs is the verb's day job and must not regress).
          for (const arg of pos) {
            const i = arg.indexOf('==');                    // '==' delimiter: a single '=' is valid inside a CSS selector
            const sel = i >= 0 ? arg.slice(0, i) : arg;
            const exp = i >= 0 ? arg.slice(i + 2) : null;
            // The ==expected comparison for a withheld field also happens in-page, so a MISMATCH can report
            // match:false plus whether the field is EMPTY — never a count of either side — without either
            // value, or any measurement of one, ever leaving the renderer.
            const gvExpr = `(function(){${AUTOFILL_JS}
              var el=document.querySelector(${JSON.stringify(sel)});
              if(!el)return undefined;
              if(!('value' in el))throw new Error('not a value-bearing element: '+${JSON.stringify(sel)});
              var v = el.value==null?null:String(el.value);
              var af = __af(el);
              var why = el.type==='password' ? 'password-field' : (af===true ? 'autofill' : null);
              if(why===null) return { v: v };
              var exp = ${JSON.stringify(exp)};
              return { withheld: why, selector: ${JSON.stringify(sel)}, filled: v!==null&&v.length>0,
                       match: exp===null?null:(v===exp) };})()`;
            // undefined = no element matched (the expr's own miss value); every real read returns an OBJECT.
            // All N selectors share ONE deadline inside readWithWait, so a page missing five of them waits the
            // budget once rather than five times over — see READ_WAIT_DEADLINE.
            const ev = await readWithWait(() => evalInTarget(tcdp, gvExpr),
                                          (r) => !r.unserializable && r.value === undefined);
            // Explicit, because the probe now returns an OBJECT: a serialize failure yields the preview shape
            // (no `value` key), which would otherwise be misreported below as "selector not found".
            if (ev.unserializable) die('get-values: could not read ' + sel + ' (result did not serialize)');
            if (ev.value === undefined) die('get-values: selector not found: ' + sel);
            const r = ev.value;
            if (r.withheld) {                              // credential field — report the shape, never the value
              values[sel] = r;                             // …and the shape no longer includes a character count
              if (r.match === false) mism.push(sel + ' does not match (withheld: ' + r.withheld + '; field '
                + (r.filled ? 'holds a different value' : 'is empty') + ')');
            } else {
              values[sel] = r.v;
              if (exp !== null && r.v !== exp) mism.push(sel + ' is "' + r.v + '" expected "' + exp + '"');
            }
          }
          if (mism.length) die('get-values MISMATCH — ' + mism.join('; '));
          out({ values });
          break;
        }

        case 'run-js': { // escape hatch; LAST statement must be an EXPRESSION (completion value, like eval)
          const code = pos.join(' '); if (!code) die('run-js needs <code>');
          const ev = await evalInTarget(tcdp, code);
          if (ev.unserializable) { out(ev.payload); break; }
          out({ result: ev.value === undefined ? null : ev.value });
          break;
        }

        case 'highlight-text': { // make a real on-screen selection so it's visible on screen
          const sel = pos[0]; if (!sel) die('highlight-text needs <selector>');
          const expr = `(function(){
            var el=document.querySelector(${JSON.stringify(sel)});
            if(!el) return false;
            var r=document.createRange(); r.selectNodeContents(el);
            var sl=window.getSelection(); sl.removeAllRanges(); sl.addRange(r);
            el.scrollIntoView({block:'center'});
            return true;
          })()`;
          // false = no match. NOTE this one has a SIDE EFFECT (it moves the selection), so the poll must not
          // re-run a successful read — `!r.value` is false the moment it lands, and the loop stops there.
          const ev = await readWithWait(() => evalInTarget(tcdp, expr), (r) => !r.value);
          if (!ev.value) die('selector not found: ' + sel);
          out({ highlighted: sel });
          break;
        }

        case 'screenshot': {
          const params = { format: 'png', captureBeyondViewport: true };
          // Page.captureScreenshot is served by copying the tab's COMPOSITOR SURFACE, and a tab that is not
          // the foreground tab produces no frames — its last one is retained briefly, then evicted. So a
          // capture of a background tab is a coin flip between a stale-but-resident surface returned slowly
          // (9-25s) and a wait for a frame that never comes, which sits on the 90s send() cap above. This is
          // not theoretical and not headless-only: measured on a headful browser carrying production flags,
          // a large share of captures of a hidden tab never returned. A long-lived browser holds many tabs and only
          // one is foreground, so EVERY capture against a session tab the human isn't looking at was exposed.
          // Activating the target first makes the frame arrive; measured 16/16 correct captures at 1.2s
          // (full-page) and 0.2s (viewport clip), pixel-verified against a foreground reference.
          // Target.activateTarget, NOT Page.bringToFront: it is handled entirely in the browser process and
          // addresses the tab by targetId, so a jammed renderer cannot block it — the wedge-immunity property
          // this whole raw path exists for survives. Bounded and swallowed: if the activate fails we are no
          // worse off than before it existed, and a capture that would have worked still works.
          // The cost is real and deliberate: on the live browser this changes which tab the human sees. The
          // alternative considered was a short first attempt and activate-then-retry only on timeout, so the
          // foreground is stolen only when the capture would have hung. Measured and rejected: a hidden tab
          // exceeds any sane bound most of the time, so it steals almost as often AND pays the bound (~8s)
          // every time it does. Page.captureScreenshot{fromSurface:false} was also measured — it does NOT
          // avoid the hang, and when it does return it SILENTLY IGNORES both captureBeyondViewport and clip,
          // handing back a viewport-sized unscaled image with exit 0. Never use it.
          // print2pdf deliberately gets none of this: Page.printToPDF renders through the print path and
          // needs no compositor frame. It never once failed while the captures beside it were hanging.
          // A LAZY tab used to fail here specifically: this activate woke it and the capture went out before
          // the brand-new renderer had laid anything out, so the first call died "Cannot take screenshot with
          // 0 width" and only a second call worked. Nothing extra is needed for that now — ensureRenderer has
          // already waited for a NON-ZERO layout viewport above, which is the condition that was missing.
          // …and the foreground is handed straight back afterwards. The activate above is not negotiable, but
          // LEAVING it activated is: the capture needs this tab to be foreground only for as long as it takes
          // the compositor to produce one frame, so the human's tab goes back the instant the frame is in
          // hand. Read before, restored after Page.captureScreenshot RETURNS — not before it, because the
          // pixels are copied from the surface by that call and a background tab stops producing frames,
          // which is the entire defect the activate was added to fix (see above).
          const prevFront = flags.stayFront ? null : await frontmostTargetId();
          try { await browser.send('Target.activateTarget', { targetId }, 10000); } catch (_) {}
          const { data } = await tcdp.send('Page.captureScreenshot', params);
          await restoreForeground(browser, prevFront, targetId);   // no-op under --stay-front (prevFront null)
          const buf = Buffer.from(data, 'base64');
          if (flags.out === '-') { await closeTemp(); tcdp.close(); browser.close(); return streamExit(buf); }
          const f = captureDest(pos[0], `shot-${Date.now()}.png`); fs.writeFileSync(f, buf);
          out({ path: f, bytes: buf.length });
          break;
        }

        case 'print2pdf': { // CDP Page.printToPDF — works on this headful Chromium (page.pdf() does not)
          const { data } = await tcdp.send('Page.printToPDF', {
            printBackground: true, paperWidth: 8.5, paperHeight: 11,
            marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
          });
          const buf = Buffer.from(data, 'base64');
          if (flags.out === '-') { await closeTemp(); tcdp.close(); browser.close(); return streamExit(buf); }
          const f = captureDest(pos[0], `page-${Date.now()}.pdf`); fs.writeFileSync(f, buf); out({ path: f, bytes: buf.length });
          break;
        }

        case 'save-page': { // SingleFile — ONE self-contained .html, CSS/images/fonts inlined (see singleFileCapture)
          // `save-page <url>` navigates first (the anon shape: throwaway tab, capture, tab reaped);
          // `save-page` alone captures the tab this session is already on (a logged-in view).
          const url = pos[0];
          let pageUrl = null, pageTitle = null;
          if (url) {
            const r = await rawGoto(tcdp, url);
            pageUrl = r.url; pageTitle = r.title;
          } else {
            pageUrl = (await evalInTarget(tcdp, 'location.href').catch(() => ({ value: null }))).value;
            pageTitle = (await evalInTarget(tcdp, 'document.title').catch(() => ({ value: null }))).value;
          }
          await sleep(SAVEPAGE_SETTLE_MS);   // a beat for the page to settle before the capture
          const src = await singleFileCapture(browser, targetId);
          // Rename to the caller's name if they gave one. They almost always should: SingleFile names the file
          // after the page TITLE plus a save timestamp, which says when the capture ran, not what it is of.
          let dest = src;
          const want = flags.out && flags.out !== '-' ? flags.out : pos[1];
          if (want) { dest = outFile(want, null); if (dest !== src) fs.renameSync(src, dest); }
          const bytes = fs.statSync(dest).size;
          // Report the url and title the capture was taken FROM, not the ones asked for: a site that timed
          // out mid-save saves its login screen, and the only way a caller can tell is by being told where the
          // tab actually was. Same reason `bytes` is reported — a few-hundred-byte "capture" is an error page.
          out({ path: dest, bytes, url: pageUrl == null ? null : redactUrl(pageUrl), title: pageTitle,
                savedAs: path.basename(src) });
          break;
        }

        case 'enter-text': { // raw act verb (the DEFAULT path): select + type via trusted Input.insertText
          const sel = refTarget ? targetName(refTarget) : pos[0];   // (arity checked in the dispatcher, before this tab existed)
          const r = await rawEnterText(acdp, aim(pos[0]), (refTarget ? pos : pos.slice(1)).join(' '));
          // Default output discloses NOTHING of the typed/landed value — a live password/passcode must never
          // hit a transcript just because enter-text succeeded (a value echoed by default will, sooner or later,
          // be a password). `length` + `differs` preserves the WHOLE diagnostic without the content: length
          // proves something landed, differs flags a mask/normalizer having reformatted it, so a caller can
          // still tell "the field transformed my input" (fine) from "nothing went in" (a real failure) without
          // ever seeing the content. --echo-value opts back into the literal value for debugging, except on a
          // password or autofilled field, where even the length is withheld.
          // typed/cleared are value-free diagnostics (see rawEnterText's failure modes): typed says which
          // input pipeline delivered it, cleared says a pre-filled value was wiped (and proven wiped) first.
          const o = { filled: sel, ...(refTarget ? { ref: refTarget.ref } : {}), raw: true,
                      ...(r.secret ? { landed: r.value.length > 0, withheld: 'password-or-autofill' } : { length: r.value.length }),
                      differs: r.differs, typed: r.typed, cleared: r.cleared };
          if (flags.echoValue && !r.secret) o.value = r.value;
          out(o);
          break;
        }

        case 'click': { // raw act verb (the DEFAULT path): trusted mouse events at real coordinates
          const sel = pos[0];                            // (arity checked in the dispatcher, before this tab existed)
          // …plus the EFFECT check: `clicked` used to mean "the click was dispatched", which a site's own
          // handler can ignore without a trace. See CLICK EFFECT for the signal and its honest limits.
          // …and the ACTIVATION RECOVERY, which needs the BROWSER ws (Target.activateTarget is browser-routed,
          // so a jammed renderer cannot block it) and the tab's own id. `ephemeral` decides whether the
          // foreground is handed back: a --new/anon tab is closed at the end of this call and has no next step.
          const { at: { fx, alt, forced, by, repositioned, ...at }, ...fxOut } = await clickWithEffect(acdp, aim(sel), expectPred, expectWaitMs, !flags.noEffect, flags.force,
            { browser, targetId, ephemeral, enabled: ACTIVATE_RETRY && !flags.noEffect });
          // OBSCURED, reported rather than only refused. `centerObscuredBy` names what is sitting on the
          // target's center; `hitPoint:"alt"` says the click went to a clear point elsewhere in its box
          // instead; `forced:true` says --force dispatched at the center and the coverer took the click.
          // All three are absent on the ordinary clear-center click, whose output is unchanged.
          // `repositioned` joins them on the same terms: absent unless the pre-press recheck caught the page
          // moving the target out from under the click point, and then it is how many times the verb re-aimed
          // before it was willing to press. Pulled OUT of `at` deliberately — `at` is the coordinates, and a
          // count of retries is not one of them.
          // With a ref, report WHAT was clicked as well as the number: the snapshot's role+name is the only way
          // a reader of the transcript can tell the ref hit what the caller meant.
          out({ clicked: refTarget ? targetName(refTarget) : sel, ...(refTarget ? { ref: refTarget.ref } : {}), raw: true, at,
                ...(alt ? { hitPoint: 'alt' } : {}), ...(forced ? { forced: true } : {}), ...(by ? { centerObscuredBy: by } : {}),
                ...(repositioned ? { repositioned } : {}), ...fxOut });
          break;
        }

        case 'click-and-await-fill': { // raw act verb (the DEFAULT path): the pre-gesture autofill proof
          // first, and only if that is inconclusive a trusted rawClick + poll of the target's .value over the
          // SAME per-target ws. raw:true marks which path ran; `proof` names HOW the answer was established and
          // `filled` is now TRI-STATE (true / false / null = could not determine). Every one of them is a
          // RESULT and exits 0 — the caller submits on filled:true and escalates otherwise. `clicked` comes
          // back null when the pre-gesture proof held and no click was issued. See rawClickAndAwaitFill.
          const clickSel = pos[0], targetSel = pos[1];   // (arity + timeoutMs checked in the dispatcher)
          const r = await rawClickAndAwaitFill(tcdp, clickSel, targetSel, cafTimeoutMs, !flags.noPreflight);
          out({ clicked: clickSel, target: targetSel, raw: true, ...r }); // ...r last: it owns `clicked` on the pre-gesture path
          break;
        }

        case 'login': {
          // THE ONLY SANCTIONED WAY AN AGENT LOGS INTO A SITE. It takes no password, accepts none (the
          // dispatcher refuses a second positional), and calls no credential oracle. See LOGIN_REGISTRY.
          // The one credential that exists here lives in Chromium's own store; the browser sends it from its own
          // side on submit. It is never read, never printed, never crosses the CDP boundary.
          const site = pos[0], reg = loginSite;   // resolved + validated in the dispatcher, before this tab existed
          // ---- THE CHOOSER PATH (`--account`). A realm holding two or more saved rows does not autofill at
          // all: Chromium offers the rows in its native picker instead, so the pre-gesture triple below can
          // never hold there, on any timeout. This path swaps ONE leg of the proof and keeps the rest.
          // WHAT IS THE SAME: the credential still lives only in Chromium's store, is still sent by the browser
          // from its own side, is still never read and never printed; the submit is still ONE trusted click on
          // the registry's submit selector; the landing is still verified against the registry signal.
          // WHAT IS DIFFERENT, stated plainly rather than buried: the proof of WHICH credential is on its way
          // is no longer "Chromium filled this field and nothing has read it" but "the picker row we named was
          // pressed, and the page now holds THAT account" — chooseAccountCore's verify-by-effect. A chooser
          // fill is user-initiated, so the value is JS-readable to the login origin from that moment; the
          // ordinary path stays the default everywhere one saved row makes it possible.
          if (flags.account) {
            const acct = flags.account;
            const nav0 = await rawGoto(tcdp, reg.entry);
            if (nav0.status === 403 || nav0.status === 401)
              throw new Error(loginErr(site, 'BLOCKED_403', 'the site answered HTTP ' + nav0.status + ' to the '
                + 'automated browser before any login form rendered — this is a bot wall, not an autofill problem'));
            const deadline = Date.now() + PRESS_TIMEOUT_MS + reg.verifyMs;
            // SETTLE on the USERNAME FIELD, not on autofill-present. The ordinary settle polls for a fill that
            // is never coming here, so it would burn the whole settleMs ceiling on every call and then decide
            // on a page it had already been able to read seconds earlier.
            const settleUntil = Date.now() + reg.settleMs;
            let q = null, already = null;
            for (;;) {
              q = await loginProbe(tcdp, reg.username, Date.now() + PRESS_TIMEOUT_MS).catch(() => null);
              if (q && q.target && q.target.hasValue && q.target.vis) break;
              // The entry url redirecting PAST the login form is the happiest reason the field is missing, and
              // it is proven with the same signal a real login is verified by — never assumed.
              if (q && q.pw.all === 0) {
                const s0 = await loginSignalCheck(tcdp, reg.signal, deadline).catch(() => ({ ok: false }));
                if (s0.ok) { already = s0; break; }
              }
              if (Date.now() >= settleUntil) break;
              await new Promise((res) => setTimeout(res, LOGIN_SETTLE_POLL_MS));
            }
            if (already) { out({ site, filled: false, verified: true, signal: already.matched, cause: 'NO_FORM', via: 'chooser' }); break; }
            if (!q || !q.target || !q.target.hasValue)
              throw new Error(loginErr(site, 'NO_FORM', 'the registry username selector "' + reg.username + '" did '
                + 'not resolve to a field on the entry page within ' + reg.settleMs + 'ms, and the post-login signal '
                + 'does not hold either — the entry url or that selector is wrong'));
            if (q.pw.all === 0)
              throw new Error(loginErr(site, 'TWO_STEP', 'the username field is there but the entry page has NO '
                + 'password field — this login is username-first, and the chooser path fills both at once, so it '
                + 'cannot drive it'));
            // ---- RAISE THE PICKER: clear both fields, click the username field, wait for the widget — and
            // RETRY THE WHOLE TRIO, which is the part that is not obvious and took two test runs to find.
            // A field holding a value has no suggestion list, so the clear is a precondition, not tidiness.
            // But on a realm with saved rows Chromium ALSO fills one of them by itself shortly after load, and
            // that fill can land AFTER a clear that raced it — leaving a value in the field again by the time
            // the click arrives, so no picker, and the caller is told a picker "never appeared" when the real
            // story is that it was refilled underneath. The hand-driven sequence never hits this: its clear
            // and its click are separate `browse` processes, hundreds of milliseconds apart, so the clear
            // always lands after the fill. The verb does them back to back and does not. Re-clearing per
            // attempt lets the second one land on a page that has finished filling itself.
            // The field state is MEASURED into the failure message rather than assumed, so a future red says
            // which of the two things happened instead of leaving the next reader to guess.
            const clearFields = async () => {
              const r = await evalInTarget(tcdp, `(function(){${RESOLVE_JS}
                var u=__bq(${JSON.stringify(reg.username)}), p=__bq(${JSON.stringify(reg.password)});
                [u,p].forEach(function(el){ if(el&&typeof el.value==='string'&&el.value.length){
                  el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); } });
                return JSON.stringify({u:u&&typeof u.value==='string'?u.value.length:null,
                                       p:p&&typeof p.value==='string'?p.value.length:null});})()`, remaining(deadline));
              try { return JSON.parse(String(r.value)); } catch (_) { return null; }
            };
            const pickerUp = () => {
              const pr = atspiProbe();
              return pr.code === 0 && pr.json.some((p) => (p.entries || []).length);
            };
            let sawPicker = false, cl = null;
            for (let attempt = 1; attempt <= LOGIN_PICKER_TRIES && !sawPicker; attempt++) {
              cl = await clearFields();
              if (!cl || cl.u !== 0 || cl.p !== 0) {          // still holding a value ⇒ let the fill finish, retry
                await new Promise((res) => setTimeout(res, 600));
                continue;
              }
              // The click that raises it. It lands on the username field, never on submit, and it is the only
              // gesture spent before the credential is chosen.
              await rawClick(tcdp, reg.username, PRESS_TIMEOUT_MS);
              const by = Date.now() + Math.ceil(LOGIN_PICKER_MS / LOGIN_PICKER_TRIES);
              for (;;) {
                if (pickerUp()) { sawPicker = true; break; }
                if (Date.now() >= by) break;
                await new Promise((res) => setTimeout(res, 300));
              }
            }
            // NOT the same failure as "you named a row that is not on offer", so it does not borrow that
            // message: nothing appeared at all, and the likely reasons point in different directions.
            if (!sawPicker) {
              const end = await clearFields();
              throw new Error(loginErr(site, 'CHOOSER', 'the account picker never appeared after '
                + LOGIN_PICKER_TRIES + ' attempts to raise it (clear both fields, click "' + reg.username
                + '", wait) within ' + LOGIN_PICKER_MS + 'ms total — so there was no row to name and nothing '
                + 'was submitted. Field lengths at the last attempt: ' + JSON.stringify(cl) + ', and now: '
                + JSON.stringify(end) + '. A non-zero username length there means Chromium keeps refilling the '
                + 'field faster than it can be cleared; zeros mean the picker itself is not being published — '
                + 'either this realm holds only ONE saved row (drop --account and let the ordinary pre-gesture '
                + 'path fill it) or the browser is publishing no accessibility tree to read it out of'));
            }
            // Its return value is deliberately dropped: every field on it that a caller might want is either
            // already known (the account they passed) or an identity this verb does not print.
            try { await chooseAccountCore(tcdp, acct); }
            catch (e) {
              // NEVER LEAVE THE PICKER STANDING. This is a browser-wide widget on a browser other sessions are
              // driving, and it swallows input for all of them — the standalone verb can afford to leave it up
              // for the caller to inspect, a verb that raised it itself cannot. Backing out to about:blank
              // closes it and takes the half-filled form with it.
              let backedOut = false;
              const still = atspiProbe();
              if (still.code === 0 && still.json.some((p) => (p.entries || []).length)) {
                await rawGoto(tcdp, 'about:blank').catch(() => {});
                backedOut = true;
              }
              throw new Error(loginErr(site, 'CHOOSER', String(e.message || e)
                + (backedOut ? ' — the picker was left showing, so this tab was backed out to about:blank to close '
                  + 'it (it blocks input browser-wide, not just here)' : ' — nothing was chosen and nothing submitted')));
            }
            // SUBMIT: one trusted click on the registry's submit selector, exactly as the ordinary path.
            await rawClick(tcdp, reg.submit, PRESS_TIMEOUT_MS);
            let sigC = { ok: false, matched: null };
            const untilC = Date.now() + reg.verifyMs;
            for (;;) {
              sigC = await loginSignalCheck(tcdp, reg.signal, deadline).catch(() => ({ ok: false, matched: null }));
              if (sigC.ok || Date.now() >= untilC) break;
              await new Promise((res) => setTimeout(res, 500));
            }
            if (!sigC.ok)
              throw new Error(loginErr(site, 'NOT_VERIFIED', 'the account picker filled the row asked for and the '
                + 'submit click landed, but the post-login signal never appeared within ' + reg.verifyMs + 'ms '
                + '(matched so far: ' + JSON.stringify(sigC.matched) + ') — the credential for THAT account may be '
                + 'stale, the site may want a second factor, or the registry signal may be wrong'));
            // The account is NOT echoed. It came from the caller, so it is already wherever they keep it, and
            // this output goes into transcripts.
            out({ site, filled: true, verified: true, signal: sigC.matched, via: 'chooser', picker: 'closed' });
            break;
          }
          const nav = await rawGoto(tcdp, reg.entry);
          // The bot wall comes BEFORE any form, so it is not a fill failure and must not be reported as one
          // (measured: HTTP 403, with the url rewritten to a captcha marker).
          if (nav.status === 403 || nav.status === 401)
            throw new Error(loginErr(site, 'BLOCKED_403', 'the site answered HTTP ' + nav.status + ' to the automated '
              + 'browser before any login form rendered — this is a bot wall, not an autofill problem'));
          // ---- SETTLE: an ADAPTIVE POLL on the gate's OWN success condition, never a fixed sleep. rawGoto
          // resolves on whichever document first fires load, so on a multi-hop SAML chain (three hops is common) a
          // fixed wait starts counting from a point that varies by seconds between runs. A settle that expires
          // mid-load reads pw:0/txt:0 — byte-for-byte the NO_FORM signature — and the verb then reports
          // "NO_FORM — the entry url may be wrong" about an entry url that was measured CORRECT. The obvious
          // response to that message is to go and change a url that was never at fault, which is why this is a
          // poll and not a bigger constant.
          //
          // POLL ON AUTOFILL-PRESENT, NEVER ON FIELD-EXISTENCE. Chromium's fill lands slightly after the form
          // parses, so a poll that stopped at "the field exists" would read a real form before the fill arrived
          // and report NO_FILL instead of NO_FORM. That trade is strictly WORSE, not neutral: NO_FORM is a
          // harmless refusal, while NO_FILL is the one cause code that reads as "there is no saved password
          // here" — the reading that sends an agent off to fetch a credential and type it. Polling for the
          // gate's own condition has neither failure mode.
          //
          // settleMs keeps its meaning as the CEILING, so every existing registry entry stays valid and fast
          // sites stop paying for slow ones. On expiry we simply fall through and let the gate report whatever
          // it finds: the poll changes WHEN the gate reads, never WHAT it decides.
          //
          // THE POLL SPENDS NO USER ACTIVATION. It is loginProbe, whose evalInTarget calls Runtime.evaluate
          // WITHOUT userGesture, so hasBeenActive stays false however many times it looks. That is load-bearing:
          // an eval that ever supplied a gesture would silently destroy the pre-gesture leg of the proof this
          // whole design rests on, and it would do it invisibly — the gate would still pass.
          const settle = async () => {
            if (!reg.settleMs) return;
            const settleUntil = Date.now() + reg.settleMs;
            for (;;) {
              // A probe can legitimately THROW mid-chain: an execution context destroyed by the next hop's
              // navigation is exactly what this poll exists to wait out, so a failed look is a retry, not a
              // result. The gate's own one-shot probe below is deliberately NOT catch-wrapped — an unreadable
              // page at expiry is still an error there.
              const s = await loginProbe(tcdp, reg.password, Date.now() + PRESS_TIMEOUT_MS).catch(() => null);
              if (s && s.target && s.target.isPassword && s.target.autofill === true) break;
              const left = settleUntil - Date.now();
              if (left <= 0) break;
              await new Promise((res) => setTimeout(res, Math.min(LOGIN_SETTLE_POLL_MS, left)));
            }
          };
          // The full pre-gesture triple, as a predicate, so the non-final round can ask "is the NEXT step ready
          // to be gated?" with exactly the test the gate itself applies — never a weaker one.
          const gatePasses = (q) => !!(q && q.target && q.target.hasValue && q.target.isPassword
                                       && q.target.autofill === true && q.target.empty === true && q.gesture === false);
          // `rounds` ROUNDS OF GATE-AND-SUBMIT (default 1 = exactly today's behavior). Auth0-style identifier-
          // first logins present a SECOND document with its own gate-passing password field; one click can never
          // finish them. Every safety property survives unchanged: each round runs the FULL gate on ITS OWN
          // document before ITS OWN single trusted click, a later round never inherits an earlier round's proof,
          // the click is always reg.submit and never a field, and the total is bounded by the validator.
          let sig = null, alreadyIn = null, clicks = 0;
          for (let round = 1; round <= reg.rounds; round++) {
            // Names the failing STEP in every cause message on a multi-round site, and stays silent on the
            // single-round sites that are the overwhelming majority — "NO_FILL (round 2 of 2)" is a different
            // diagnosis from the same code at round 1, and a caller cannot tell them apart otherwise.
            const at = reg.rounds > 1 ? ' (round ' + round + ' of ' + reg.rounds + ')' : '';
            await settle();
            const deadline = Date.now() + PRESS_TIMEOUT_MS + reg.verifyMs;
            const p = await loginProbe(tcdp, reg.password, deadline);

            // ---- THE GATE. It FAILS CLOSED: every path out of here is either a proven pre-gesture fill or a
            // cause code. There is deliberately no third branch, and no degraded mode. ------------------------
            if (!p.target || !p.target.hasValue) {
              if (p.pw.all === 0) {
                // No password field anywhere. The commonest reason by far is the happiest one: the session is
                // still live, so the entry url redirected past the login form. Prove that with the SAME
                // post-login signal a real login is verified by — never assume it. Still correct on a LATER
                // round: a late redirect that lands the session is a success, not a failure.
                const s0 = await loginSignalCheck(tcdp, reg.signal, deadline);
                if (s0.ok) { alreadyIn = s0; break; }
                if (p.textPw > 0)
                  throw new Error(loginErr(site, 'TEXT_TYPE_PASSWORD', 'the page has a password-named field that is NOT '
                    + 'type="password"' + at + ' — Chromium will not autofill it, so no saved-store login is possible here'));
                if (p.txt > 0)
                  throw new Error(loginErr(site, 'TWO_STEP', 'no password field on the entry page, only a username step '
                    + '— the saved store holds the password but nothing supplies the username at step 1' + at));
                throw new Error(loginErr(site, 'NO_FORM', 'no login form on the entry page AND the post-login signal '
                  + 'does not hold' + at + ' — the entry url may be wrong, or the page did not render in ' + reg.settleMs + 'ms'));
              }
              throw new Error(loginErr(site, 'NO_FILL', 'the registry password selector "' + reg.password + '" did not '
                + 'resolve to a value-bearing element, though the page HAS ' + p.pw.all + ' password field(s)' + at + ' — this is a '
                + 'registry defect, not a browser one: fix the selector'));
            }
            if (!p.target.isPassword) {
              if (p.pw.all === 0)
                throw new Error(loginErr(site, 'TEXT_TYPE_PASSWORD', 'the registry password selector resolves to a field '
                  + 'that is not type="password" and the page has none' + at + ' — Chromium refuses to autofill it'));
              throw new Error(loginErr(site, 'NO_FILL', 'the registry password selector "' + reg.password + '" resolves to '
                + 'a non-password field while the page has ' + p.pw.all + ' real one(s)' + at + ' — fix the selector'));
            }
            // The pre-gesture triple, all three legs required (measured):
            //   autofill  Chromium filled this field from ITS OWN saved store
            //   empty     the value is STILL invisible to page JS — nothing has read it, nothing can
            //   !gesture  no user activation has been spent on this document, so nothing COULD have read it
            // A missing leg is never "probably fine". autofill:null in particular means we could not determine,
            // and reporting a can't-determine as a pass is exactly how a tool starts submitting empty passwords.
            if (!(p.target.autofill === true && p.target.empty === true && p.gesture === false))
              throw new Error(loginErr(site, 'NO_FILL', 'the pre-gesture proof does not hold on "' + reg.password
                + '"' + at + ' (autofill=' + p.target.autofill + ', empty=' + p.target.empty + ', userActivation=' + p.gesture
                + '; wanted true/true/false) — Chromium did not fill from its saved store, or the value is already '
                + 'JS-readable. A site that pre-populates the username suppresses Chromium\'s own fill; a spent '
                + 'user activation means this tab already touched the page (open a fresh tab and retry)'));

            // ---- SUBMIT. A TRUSTED click, and the ONLY gesture this round ever spends. It is what tells the
            // browser to send the credential from its own side; the value becomes JS-readable to the page from
            // this instant, which is precisely why nothing below reads anything from the form. ---------------
            await rawClick(tcdp, reg.submit, PRESS_TIMEOUT_MS);
            clicks++;

            // ---- VERIFY. A click that "worked" and a login that HAPPENED are different claims, and a verb that
            // reports the first as the second is how a caller ends up acting on a signed-out session. -------
            // On a NON-FINAL round this races TWO outcomes instead of one, which is the whole point: the signal,
            // OR a new document presenting a gate-passing password field. Waiting out verifyMs first would make
            // every two-step login pay the full window (25s by default) before even looking at step 2.
            const until = Date.now() + reg.verifyMs;
            for (;;) {
              sig = await loginSignalCheck(tcdp, reg.signal, deadline).catch(() => ({ ok: false, matched: null }));
              if (sig.ok) break;
              if (round < reg.rounds) {
                const nxt = await loginProbe(tcdp, reg.password, Date.now() + PRESS_TIMEOUT_MS).catch(() => null);
                if (gatePasses(nxt)) break;        // step 2 is ready → fall out and let the next round gate it
              }
              if (Date.now() >= until) break;
              await new Promise((res) => setTimeout(res, 500));   // the post-submit redirect chain needs a beat
            }
            if (sig.ok) break;
            // A non-final round can fall through with NEITHER the signal nor a gate-passing field — the verify
            // window simply expired. The next round then runs its own settle and gate and reports THAT round's
            // cause code, which is the honest answer: "step 2 never rendered a fillable form" IS a NO_FORM
            // about step 2, and inventing a distinct code for it would claim knowledge nobody measured.
            if (round === reg.rounds)
              throw new Error(loginErr(site, 'NOT_VERIFIED', 'the submit click landed and the pre-gesture proof HELD, but the '
                + 'post-login signal never appeared within ' + reg.verifyMs + 'ms after ' + reg.rounds + ' round(s) '
                + '(matched so far: ' + JSON.stringify(sig.matched)
                + ') — the credential may be stale, the site may want a second factor, or the registry signal may be wrong'));
          }
          // ALREADY SIGNED IN, and which round found it decides what is true. On round 1 nothing was clicked, so
          // this is today's NO_FORM success verbatim. On a later round the earlier rounds DID gate and submit,
          // so reporting filled:false would understate a login that actually happened.
          if (alreadyIn) {
            if (!clicks) { out({ site, filled: false, verified: true, signal: alreadyIn.matched, cause: 'NO_FORM' }); break; }
            out({ site, filled: true, verified: true, signal: alreadyIn.matched, rounds: clicks, cause: 'NO_FORM' });
            break;
          }
          // `rounds` reports the rounds actually SPENT, not reg.rounds: a 2-round site that verifies after one
          // is a one-round login, and saying otherwise would be a small lie in the one output callers trust.
          out({ site, filled: true, verified: true, signal: sig.matched, rounds: clicks });
          break;
        }

        case 'login-state': {
          // READ-ONLY by default: one in-page probe, no navigation, no click, no gesture spent — so it is safe
          // to run before `login`, whose gate needs the activation unspent. --resolve is the single exception
          // and it is opt-in for exactly that reason.
          const deadline = Date.now() + PRESS_TIMEOUT_MS;
          const p = await loginStateProbe(tcdp, deadline);
          let resolved = null;
          // Only spend the click when it can actually decide something. Re-using rawClickAndAwaitFill rather
          // than re-implementing the wait is the point: it already owns the pre-gesture proof, the trusted
          // click and the tri-state verdict (filled true/false/null, where null is "could not determine" and
          // must never be collapsed to false — that collapse is the documented leak path).
          // The click lands on the PASSWORD FIELD, not the submit button: this verb never submits.
          // A --resolve that CANNOT run says so rather than staying silent: otherwise the verdict below tells the
          // caller to "run --resolve" — which they just did — and that is a loop, not a remedy. The
          // already-spent-activation case is deliberately NOT flagged here: the classifier has a better answer
          // for it (open a fresh tab), and it reaches that answer from p.gesture on its own.
          if (flags.resolve && p.pw.all > 0 && p.pwFilled !== true && !p.pwSel && p.gesture === false)
            resolved = { filled: null, proof: 'not-attempted',
              why: 'no unique CSS selector could be built for the password field, so there is nothing safe to click' };
          if (flags.resolve && p.pw.all > 0 && p.pwSel && p.pwFilled !== true && p.gesture === false) {
            resolved = await rawClickAndAwaitFill(tcdp, p.pwSel, p.pwSel, 4000, true)
              .then((r) => ({ filled: r.filled, proof: r.proof }))
              .catch((e) => ({ filled: null, proof: 'error', error: String(e.message || e) }));
            // Re-probe: the click may have unlocked the value, changing the verdict from can't-tell to proven.
            // Its OWN budget — the click half may have eaten most of the first one.
            if (resolved.filled === true) Object.assign(p, await loginStateProbe(tcdp, Date.now() + PRESS_TIMEOUT_MS));
          }
          out(classifyLoginState(p, resolved));
          break;
        }

        case 'session-state': {
          // READ-ONLY: one GET at an endpoint the site itself calls, no click, no gesture spent, no credential
          // anywhere near it. It does not navigate EITHER — except onto a blank throwaway tab (--new/anon),
          // which has nothing to lose. Navigating a caller's real tab can freeze it behind a beforeunload prompt,
          // and a session check that can do that is not a check.
          const sites = loadLoginRegistry();
          let site = pos[0] || null;
          let cfg = site ? sites[site] : null;
          // A blank throwaway gets sent to the named site's origin first — otherwise `browse --new
          // session-state <site>` would faithfully probe about:blank and answer CANNOT_TELL every time.
          if (cfg && cfg.entry && temp) {
            const here = await evalInTarget(tcdp, 'location.href', 8000).then((r) => String(r.value || ''))
              .catch(() => '');
            if (!here || here === 'about:blank') await rawGoto(tcdp, new URL(cfg.entry).origin + '/');
          }
          // Native prompts FIRST and unconditionally: they are read outside CDP, they cost ~25-200ms, and a
          // failure to read them must be reported rather than assumed away (see the limits array).
          const a = atspiProbe();
          // atspiProbe returns the probe's stdout PARSED, and that is a BARE ARRAY of prompts — `native-
          // browser-prompts-view` is what wraps it in {prompts,a11y}. Reading `a.json.prompts` alone would yield
          // undefined and therefore an empty list: NO PROMPTS reported with a credential dialog visibly on
          // screen, a silent all-clear, which is the precise failure this whole verb exists to end. A hermetic
          // test cannot catch it (a throwaway browser has no a11y tree at all), so both shapes are accepted and
          // a future wrap cannot resurrect it.
          const seen = a.code !== 0 ? []
            : (Array.isArray(a.json) ? a.json : (a.json && Array.isArray(a.json.prompts) ? a.json.prompts : []));
          const prompts = { read: a.code === 0, err: a.code === 0 ? null : (a.err || null),
                            blocking: seen.filter(sessionPromptBlocks),
                            other: seen.filter((p) => !sessionPromptBlocks(p)) };
          // ONE exit for every verdict, so the "the prompt read failed" caveat can never be attached to some
          // answers and not others — a caller that cannot tell whether BLOCKED was even detectable is back to
          // guessing, which is the whole failure.
          const finishSession = (v) => out(!prompts.read
            ? { ...v, limits: (v.limits || []).concat('the native-prompt read FAILED (' + (prompts.err
                || 'unknown') + '), so a BLOCKED state could not have been detected on this run') }
            : v);
          // The page read doubles as the origin read, so the site can be resolved from the tab when none was
          // named. When it fails we do NOT assume anything — we ask whether the renderer is actually frozen,
          // because "frozen" and "could not tell" are different answers and collapsing them loses the one
          // that is actionable.
          let page = null, frozen = false;
          const readPage = async (probePath) => {
            const expr = probePath ? sessionStateJS(probePath)
              : '(function(){return JSON.stringify({origin:location.origin,path:location.pathname,'
                + 'href:location.href,title:document.title})})()';
            try {
              const r = await evalInTarget(tcdp, expr, SESSION_PROBE_MS);
              return typeof r.value === 'string' ? JSON.parse(r.value) : null;
            } catch (_) {
              frozen = (await probeTarget(targetId).catch(() => ({ frozen: false }))).frozen;
              return null;
            }
          };
          // Location FIRST, without the fetch: the site may still have to be resolved FROM the origin, and the
          // probe path is only knowable once it is. Cheap, and it is also the renderer liveness check.
          page = await readPage(null);
          // No site named ⇒ match the tab's origin against the registry. Only entries that DECLARE a session
          // probe are candidates: an entry without one cannot answer the question, so letting it win the match
          // would turn a perfectly answerable tab into NO_PROBE_RECORDED — and several enrolled sites sharing
          // one origin is normal (a test registry can hold many on one host).
          // MORE THAN ONE candidate is NOT resolved by picking the first. Object key order is not a fact about
          // the site, and silently choosing between two accounts on one origin is exactly the class of quiet wrong
          // answer this verb exists to end — so it says so and asks to be told which.
          let ambiguous = null;
          if (!site && page) {
            const hits = [];
            for (const [name, e] of Object.entries(sites)) {
              let o = null;
              try { o = e.entry ? new URL(e.entry).origin : null; } catch (_) { o = null; }
              if (o && o === page.origin && e.session) hits.push([name, e]);
            }
            if (hits.length === 1) { site = hits[0][0]; cfg = hits[0][1]; }
            else if (hits.length > 1) ambiguous = hits.map(([n]) => n);
          }
          // Both early exits below answer WITHOUT sending the probe, so they cannot go through
          // classifySessionState (which is the shape "the server said something"). They still carry the same
          // evidence keys and the same limits, because a caller must never have to learn two output shapes.
          const noProbeAnswer = (o) => finishSession({ ...o, evidence: {
            pageContextOnly: { origin: page.origin, path: page.path, title: page.title },
            blockingPrompts: prompts.blocking, otherPrompts: prompts.other, nativePromptsRead: prompts.read },
            limits: SESSION_LIMITS });
          if (ambiguous) {
            noProbeAnswer({ site: null, state: 'CANNOT_TELL', cause: 'AMBIGUOUS_ORIGIN',
              reason: ambiguous.length + ' enrolled sites declare a session probe at this origin ('
                + ambiguous.join(', ') + '), and picking one of them would be a guess',
              remedy: 'name the one you mean — `browse session-state ' + ambiguous[0] + '`. This is NOT logged out' });
            break;
          }
          // Named site, but the tab is standing somewhere else. The probe is SAME-ORIGIN by construction, so it
          // would have asked the wrong host about the wrong cookies (and a cross-origin fetch would have failed
          // CORS anyway). Checked BEFORE the probe runs: the mismatch is the answer, and "the request errored"
          // would have been a worse-shaped version of the same fact.
          if (site && cfg && cfg.entry && page) {
            let want = null;
            try { want = new URL(cfg.entry).origin; } catch (_) {}
            if (want && page.origin !== want) {
              noProbeAnswer({ site, state: 'CANNOT_TELL', cause: 'WRONG_ORIGIN',
                reason: 'this tab is on ' + page.origin + ' but "' + site + '" lives at ' + want
                  + ', so its session-truth endpoint was NOT asked — a same-origin probe can only answer about '
                  + 'the origin it is issued from',
                remedy: '`browse open-url ' + want + '/` first, then re-run `browse session-state ' + site
                  + '` — or run it with --new, which sends a throwaway tab there itself. This is NOT logged out' });
              break;
            }
          }
          // Only NOW is the probe path known and the origin proven right. One request, GET, side-effect free.
          if (page && cfg && cfg.session) page = (await readPage(cfg.session.probe)) || page;
          finishSession(classifySessionState(site, cfg, prompts, page, frozen));
          break;
        }

        case 'native-browser-prompts-choose': {
          // The one verb in the native-prompt family that needs a TAB: its success test is a page read (see
          // chooseAccount for why "the prompt went away" is not a proof here). --card takes the same widget
          // down a different verify: a card fills SEVERAL fields and no username, so the account probe would
          // report a correct fill as "nothing on the page changed".
          // acdp, not tcdp: on an iframe checkout the card form lives in a frame, and a probe against the top
          // document reports a correct fill as "nothing changed". --frame aims the verify at the frame; without
          // the flag acdp IS tcdp.
          if (flags.card !== null) await chooseCard(acdp);
          else await chooseAccount(acdp);
          break;
        }

        case 'press-key': { // raw act verb (the DEFAULT path for a control key): a discrete keystroke
          const sel = pos[0], key = refTarget ? pos[0] : pos[1];   //  over the wedge-immune raw ws. raw:true in
          // ENTER is measured and recovered (see pressKeyWithEffect); every other control key is dispatched
          // exactly as before and its output is byte-for-byte unchanged — a Tab or an Escape that changes
          // nothing is ordinary, not a symptom, and must never cost anybody the foreground.
          // --no-activate-retry turns off the RECOVERY, not the SIGNAL — the same line `click` holds, and the
          // name is the promise: a caller who opted out of having the foreground moved is still told that
          // nothing happened, which is the diagnosis they need in order to activate the tab themselves.
          let fxOut = {};                                          //  the output marks which path ran.
          if (key === 'Enter')
            fxOut = await pressKeyWithEffect(acdp, aim(sel), key, { browser, targetId, ephemeral, enabled: ACTIVATE_RETRY });
          else await rawPressKey(acdp, aim(sel), key);
          out({ pressed: key, on: refTarget ? targetName(refTarget) : sel, ...(refTarget ? { ref: refTarget.ref } : {}), raw: true, ...fxOut });
          break;
        }

        case 'upload-file': { // raw act verb (the only path there has ever been for it):
          const sel = pos[0], file = refTarget ? pos[0] : pos[1];  // DOM.setFileInputFiles hands the browser a PATH,
          const r = await rawUploadFile(tcdp, aim(sel), file);     // so the change event is browser-generated (isTrusted:true)
          // with no 50 MB ceiling — see rawUploadFile for the isTrusted/size comparison against Playwright's
          // setInputFiles. `name` is the file the input actually holds, read back through the SAME node we
          // wrote to, so a mid-flight re-render can't fake a success.
          out({ uploaded: file, to: refTarget ? targetName(refTarget) : sel, ...(refTarget ? { ref: refTarget.ref } : {}), raw: true, name: r.name });
          break;
        }

        case 'download': { // raw act verb (the DEFAULT path): Browser.setDownloadBehavior +
          // downloadProgress ride the SAME browser-level ws this dispatch already holds — no newBrowserCDPSession,
          // no connectOverCDP, so a heavy sibling tab can't wedge a download. For a URL, the tab resolved above is
          // a THROWAWAY (downloadIsUrl) that closeTemp closes on success AND on failure; a selector acts on this
          // session's own tab.
          const r = await rawDownload(browser, tcdp, pos[0], downloadIsUrl); // (arity checked in the dispatcher)
          out({ ...r, raw: true });
          break;
        }

        default:
          die('unknown verb: ' + verb); // unreachable (the RAW set + press-key routing gate this)
      }

      if (refTarget) await unpinRef(acdp);      // leave nothing of ours in a page other sessions share
      if (frameSurface) await frameSurface.close();   // …and no frame session: a leaked one IS the wedge risk
      await closeTemp();
      tcdp.close(); browser.close();
      return finish(0);
    } catch (e) {
      const emsg = String(e.message || e);
      if (refTarget) { try { await unpinRef(acdp); } catch (_) {} }   // the failure path drops the pin too
      if (frameSurface) { try { await frameSurface.close(); } catch (_) {} }
      try { await closeTemp(); } catch (_) {}
      // A renderer that stopped answering must not be left running — see reapWedgedTab. Only for a PERSISTENT
      // tab: a temp one closeTemp has already taken, and it runs BEFORE the sockets close because it needs the
      // browser-level ws.
      let reaped = null;
      if (!temp) { try { reaped = await reapWedgedTab(browser, targetId, emsg, e); } catch (_) {} }
      try { tcdp.close(); } catch (_) {}
      try { browser.close(); } catch (_) {}
      die(verb + ': ' + emsg + (
        reaped === 'closed' ? ' — this tab\'s renderer stopped answering, so THE TAB WAS CLOSED to stop it '
          + 'consuming the box (a wedged renderer left open can reach many GB and pin every core). Run '
          + 'open-url to start again.'
        : reaped === 'unowned' ? ' — this tab is NOT registered to this session, so it was left open: a tab we '
          + 'did not open may be a human\'s, and closing one is permanent (session restore does not bring it '
          + 'back). Diagnose browser-wide with `browse dismiss-dialog --probe-only`; reaping someone else\'s '
          + 'wedged tab is a human\'s decision.'
        : reaped === 'failed' ? ' — WARNING: the tab could not be closed. Check it by hand; a wedged renderer '
          + 'left open can consume the whole box.'
        : ''));
    }
  } catch (e) {
    try { browser.close(); } catch (_) {}
    die(verb + ': ' + (e.message || e));
  }
}

// ---- WEDGED-TAB REAPER -------------------------------------------------------------------------------------
// A verb that fails with a CDP TIMEOUT has, by definition, a renderer that is not answering. Left alone, that
// tab is never revisited, and a wedged renderer can go on allocating: measured at many GB with every core
// pinned and the machine's own sshd starved so nobody could get in — heading for an OOM kill whose victim could
// be the browser process itself, taking every tab with it.
// WHY NOTHING ELSE CATCHES IT, stated plainly because the usual guard LOOKS like it should:
//   - the entry point's 240s cap limits the CALL, and kills NODE. A renderer already spinning inside the
//     browser process does not care that node died. The cap gives false assurance here.
//   - the session map only ever RECORDS a tab; nothing inspects one.
// THE LEVER: Target.closeTarget is handled in the BROWSER process, so — unlike a navigate, which needs the
// renderer we are trying to escape — a wedged renderer cannot block it. Same property the screenshot path
// already relies on for Target.activateTarget. Closing the tab is therefore the only action that reliably
// works on a wedged renderer, and it is what this does.
// REAP WHAT WE OPENED, NEVER REAP WHAT WE FOUND. This is the rule, and it is enforced here rather than left as
// an emergent property of resolveTarget, because "you cannot get there from here" is exactly the kind of
// invariant that quietly stops being true.
// THE CONCERN, and it is the right one to have: a long-lived browser carries restored tabs, possibly including tabs a
// human keeps open. Closing one is PERMANENT — session restore will not bring it back — and a tab that
// was merely slow to answer inside our timeout is not necessarily wedged. A false positive would silently
// destroy a human's working state, and they would never connect it to a verb an agent ran. That risk is
// unacceptable, so the reaper is confined to tabs THIS SESSION created.
// It is confined by construction as well as by the check below: resolveTarget only ever returns a temp tab, or
// the tab registered to this session in the map, or one it just created and registered. A restored/human tab
// is not addressable by any verb, so a wedged human tab cannot reach this function at all. The map test is the
// belt to that braces — if the map is ever wrong, we refuse rather than close.
// THREE EXEMPTIONS:
//   unowned      not ours per the session map ⇒ someone else's or a human's. Fail LOUDLY with instructions; a
//                destructive recovery must never fire on a tab whose provenance we cannot vouch for.
//   temp/--new   closeTemp already reaps those on every exit path, wedged or not.
//   no renderer  a LAZY tab (see ensureRenderer) never had a renderer to wedge, so there is nothing here to
//                stop consuming the machine — and closing it would destroy a restored tab for no gain. Without
//                the caller's mark it would reach the reaper as a plain eval timeout and be CLOSED (measured:
//                get-text hung for minutes, then the target was gone).
// Returns 'closed' | 'unowned' | 'failed' | 'no-renderer' | null (not a timeout ⇒ nothing to do). Never throws:
// this runs on the error path and must not replace the caller's real error with one of its own.
async function reapWedgedTab(browser, targetId, msg, err) {
  if (err && err.noRenderer) return 'no-renderer';            // never HAD a renderer ⇒ not a wedge, don't close
  if (!/timed out|timeout/i.test(String(msg))) return null;   // an ordinary error left the renderer healthy
  let map = {};
  try { map = loadMap(); } catch (_) { return 'unowned'; }    // can't prove ownership ⇒ don't close. Fail closed.
  if (!sessionKey || map[sessionKey] !== targetId) return 'unowned';
  try { await browser.send('Target.closeTarget', { targetId }, 10000); }
  catch (_) { return 'failed'; }
  // Unmap it too, or the session keeps a pointer to a tab that no longer exists and the next verb dies on the
  // blank-capture guard instead of simply opening a fresh one.
  try { delete map[sessionKey]; saveMap(map); } catch (_) {}
  return 'closed';
}

// ---------------------------------------------------------------------------------------
// restart-browser — the most destructive verb in the tool: it DROPS EVERY TAB, live logged-in views
// included. So the default is SHOW, not DO: without --yes it prints the blast radius and exits non-zero.
// With --yes it snapshots → restarts → waits for genuine readiness → checks the browser really came back
// with its tabs.
//
// IT REOPENS NOTHING ITSELF. The browser's OWN SESSION RESTORE is the mechanism — a restart brings back every
// tab, in order, with the right active tab, other sessions' tabs included (WINDOWS: only if the agent Edge's
// "On startup" setting is "Open tabs from the previous session" — see README.md). Reopening anything on top of
// that would duplicate it. What this verb does is the confirmation gate, the snapshot, and proof that every tab
// came back — by URL against that snapshot, not by tab count.
// ---------------------------------------------------------------------------------------

// A refused localhost connect throws an AggregateError whose message is EMPTY — "browser: DOWN (AggregateError)"
// tells the reader nothing. Surface the underlying codes.
function errText(e) {
  if (!e) return 'unknown error';
  if (e.message) return String(e.message);
  if (Array.isArray(e.errors) && e.errors.length) return e.errors.map((x) => (x && (x.code || x.message)) || String(x)).join(', ');
  return String(e.code || e.name || e);
}
// Cap a promise that has no timeout of its own (connectBrowser's ws handshake is 60s, listPageTargets' send is
// 90s). Only used where we then die() or retry, so the abandoned promise never outlives the process.
function withTimeout(p, ms, what) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(what + ': timed out after ' + Math.round(ms / 1000) + 's')), ms); }),
  ]);
}
// The plan/apply token: a short hash of the exact tab set the dry run showed. --yes carries it back, so an
// approval can only apply to the blast radius that was actually read — and the TOCTOU window (a session opens
// or closes a tab between the dry run and the apply) becomes a refusal instead of a surprise.
function planToken(ids) { return crypto.createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 8); }

// The completeness check the verdict now rests on. Comparing the tab COUNT before and after is only a FLOOR:
// if session restore drops one tab while a human opens a different one during the readiness polls, the counts
// match and the loss is silent. So compare the URLs as a MULTISET (three identical tabs must come back as
// three), normalized only enough to survive the trip — fragment dropped and one trailing slash — and nothing
// cleverer. (Guessing at tab IDENTITY beyond that is deliberately not attempted.)
// Returns the ORIGINAL urls on both sides, so a missing one can be pasted straight back into a browser.
function urlDiff(beforeUrls, afterUrls) {
  const norm = (u) => String(u == null ? '' : u).replace(/#.*$/, '').replace(/\/$/, '');
  const bucket = (urls) => {
    const m = new Map();
    for (const u of urls) { const k = norm(u); if (m.has(k)) m.get(k).push(u); else m.set(k, [u]); }
    return m;
  };
  const b = bucket(beforeUrls), a = bucket(afterUrls);
  const only = (x, y) => {
    const o = [];
    for (const [k, urls] of x) { const n = urls.length - (y.get(k) || []).length; for (let i = 0; i < n; i++) o.push(urls[i]); }
    return o;
  };
  return { missing: only(b, a), extra: only(a, b) };   // missing ⇒ FAILURE; extra ⇒ benign (someone opened a tab)
}

// ---- native-browser-prompts-view / native-browser-prompts-dismiss ----------------------------------------
// Read, and press a button in, Chromium's NATIVE browser-chrome prompts (see the AT-SPI block near
// xPressReturn for why nothing else can see them). Deliberately NOT wired into every act verb: a per-action
// probe was offered and declined, so a prompt is something a caller asks about, not something that happens
// behind their back.
async function nativeBrowserPromptVerb() {
  if (verb === 'native-browser-prompts-view') {
    const r = atspiProbe();
    // Exit 3 = no a11y tree for THIS browser. Report it as an ANSWER, not a crash — but never as a bare empty
    // list: "I cannot see" and "there is nothing there" are different facts, and collapsing them into `[]`
    // would recreate the exact silent all-clear these verbs exist to end. a11y:false says which one it is.
    if (r.code === 3) {
      out({ prompts: [], a11y: false, note: 'CANNOT SEE — not "nothing showing": ' + r.err });
      return finish(0);
    }
    if (r.code !== 0) die('native-browser-prompts-view: ' + r.err);
    out({ prompts: r.json, a11y: true });
    return finish(0);
  }

  // ---- native-browser-prompts-dismiss --button <name> ----
  const before = atspiProbe();                    // code 3 IS fatal here: you cannot press what you cannot see
  if (before.code !== 0) die('native-browser-prompts-dismiss: ' + before.err);
  const target = before.json.find((p) => (p.buttons || []).includes(flags.button));
  if (!target)
    die('native-browser-prompts-dismiss: no native prompt is showing a button named "' + flags.button
      + '" — showing: ' + JSON.stringify(before.json) + ' (button names are the visible labels, matched '
      + 'EXACTLY; `browse native-browser-prompts-view` lists them)');

  // Is the prompt we just pressed in actually GONE? Matched on role+name, so a different prompt appearing in
  // its place (Chromium often opens the download bubble after an Allow) does not read as failure.
  const stillUp = (list) => list.some((p) => p.role === target.role && p.name === target.name);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitGone = async () => {
    const deadline = Date.now() + PROMPT_VERIFY_MS;
    let last = [];
    for (;;) {
      await sleep(400);
      const now = atspiProbe();
      if (now.code === 3) return { gone: true, remaining: [] };   // whole tree went away with the window
      if (now.code !== 0) die('native-browser-prompts-dismiss: pressed "' + flags.button
        + '" but could not re-probe to verify it — ' + now.err);
      last = now.json;
      if (!stillUp(last)) return { gone: true, remaining: last };
      if (Date.now() > deadline) return { gone: false, remaining: last };
    }
  };

  // do_action() returns True even when Chromium SWALLOWS the press — measured: the first press on a
  // download-permission bubble returned True, the bubble stayed up and the blocked file never landed; a retry
  // cleared it (a second bubble had taken input activation). So the return value proves NOTHING and only the
  // prompt disappearing does. Press, poll, retry once, then fail loud rather than report a press that did nothing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const p = atspiProbe(['--press', flags.button]);
    if (p.code === 2 && attempt > 1) break;       // button gone on the retry ⇒ the first press landed after all
    if (p.code !== 0) die('native-browser-prompts-dismiss: ' + p.err);
    const v = await waitGone();
    if (v.gone) { out({ pressed: flags.button, in: target.name, role: target.role, gone: true, attempts: attempt, remaining: v.remaining }); return finish(0); }
  }
  const after = atspiProbe();
  if (after.code === 0 && !stillUp(after.json)) { // cleared during the retry round — a slow dismiss, not a failure
    out({ pressed: flags.button, in: target.name, role: target.role, gone: true, attempts: 2, remaining: after.json });
    return finish(0);
  }
  // LAST RESORT — an X-layer Escape, on a path that is otherwise a GUARANTEED failure. Chromium's print
  // preview is the case that forced this: it is a real prompt with real Cancel/Save buttons, AT-SPI reports
  // {"pressed":"Cancel"} for each attempt above, and the preview does not budge — measured: three
  // presses with two-second waits, the page still unreadable afterwards. An Escape at the X layer DOES clear
  // it, and the blocked page becomes readable again in the same breath (proved by re-reading the page, not by
  // the keystroke returning).
  // SAFE BECAUSE OF WHERE IT SITS, not because a keystroke is harmless. Three things hold it in place:
  // xPressKey's ownership proof (the window's pid must belong to the browser on THIS cdp port, else nothing is
  // pressed and it says why); `targeted`, which delivers the key TO THAT PROVEN WINDOW rather than to whatever
  // happens to be active, so a window another agent session raises on :99 in the meantime cannot catch it; and
  // Escape being the mildest key there is — it closes UI, where the Return in dismiss-dialog activates a
  // default button. By here a pid-scoped AT-SPI read has also confirmed twice that the prompt is still up.
  // RESIDUAL, stated rather than hidden: the proof identifies the browser's window through the ACTIVE window,
  // so on a multi-window browser whose prompt sits on a BACKGROUND window, the key goes to the active one and
  // simply does not clear the prompt — which still dies loud below. A dedicated agent browser usually runs one window.
  let esc = null;
  try { esc = xPressKey('Escape', { targeted: true }); } catch (e) { esc = { error: String(e.message || e) }; }
  if (esc && esc.pressed) {
    const v = await waitGone();
    if (v.gone) {
      out({ pressed: flags.button, in: target.name, role: target.role, gone: true, attempts: 2, via: 'x-escape',
            x: esc, remaining: v.remaining,
            note: 'the AT-SPI press was SWALLOWED twice (Chromium reported it landed and the prompt stayed up); '
              + 'an X-layer Escape cleared it. Chromium\'s print preview behaves exactly this way' });
      return finish(0);
    }
  }
  die('native-browser-prompts-dismiss: pressed "' + flags.button + '" twice and the prompt is STILL showing after '
    + PROMPT_VERIFY_MS + 'ms each time — ' + JSON.stringify(after.code === 0 ? after.json : after.err)
    + '. An X-layer Escape was then ' + (esc && esc.pressed ? 'pressed and did not clear it either'
      : 'NOT sent (' + JSON.stringify(esc && (esc.skipped || esc.error)) + ')')
    + '. Chromium suppresses a bubble press while another bubble holds input activation, so dismiss the OTHER '
    + 'prompt first (`browse native-browser-prompts-view`); if it is the only one, look at the browser on this '
    + 'machine\'s own screen — the button may be disabled or the prompt may need a different one');
}

// ---- native-browser-prompts-choose --username <account> ---------------------------------------------------
// Pick ONE saved account out of Chromium's saved-password chooser and PROVE the page received that account's
// credential. The chooser is what stands between an agent and an unattended login on a realm holding two or
// more saved rows; the alternative — deleting one of the saved passwords — destroys a credential to work
// around a tool that simply could not see the widget.
//
// WHY THIS IS ITS OWN VERB rather than `native-browser-prompts-dismiss --button <row label>` — a chooser row
// IS a named control, so routing it through the dismiss verb would appear to work, and that is the trap:
//  1. DIFFERENT KEY. A caller knows a USERNAME. The row's label is Chromium's own phrasing of it ("Password
//     for <u>") and is localized, so --button would make them read a label off the tree and hand it straight
//     back, with nothing checking that the label they chose is even an account row.
//  2. DIFFERENT PROOF, and this is the load-bearing one. "The prompt went away" is the whole of the dismiss
//     verb's success test, and here it proves NOTHING: Escape closes the chooser, and pressing the WRONG row
//     closes it too — having filled the wrong account's password into a form that is about to be submitted.
//     Success here means the PAGE changed, which is a CDP read; the dismiss verb deliberately never makes one,
//     because you reach for it precisely when CDP is misbehaving. So this verb is TAB-SCOPED where that one is
//     browser-only — a structural difference, not a flag.
//  3. DIFFERENT BLAST RADIUS. 'Manage passwords…' is a row like any other, and pressing it OPENS
//     chrome://password-manager/passwords, which on the live profile RENDERS EVERY SAVED USERNAME. Being a
//     separate verb does not by itself prevent that, and the first cut of this one did not: measured,
//     `--username 'Manage passwords…'` matched the row exactly, pressed it, opened that tab, and
//     only then failed the effect check — an error AFTER the exposure. The row is now dropped by the probe
//     itself (TRAP (d) there: collection stops at the `separator` Chromium puts above the footer), so neither
//     this verb nor --press-entry can name it, and this verb's error for it is the ordinary "not offering".
// The machinery is shared all the same (same probe, same pid scoping, same press → re-probe → retry-once
// shape), and --button still matches role `button` only, so it can never land on a chooser row by accident.
//
// Caller sequence, and the CLEAR step is not optional: with two saved rows Chromium usually fills ONE of them
// silently on load (measured — two saved rows do NOT suppress autofill), and a field that already holds a
// value has no suggestion list to show, so the chooser never appears. Clearing is also what makes the proof
// below attributable.
//   browse open-url <login page>
//   browse run-js '<clear the username and password fields>'
//   browse click '<username field>'                       ← raises the chooser (a CDP click is enough; no OS keystroke)
//   browse native-browser-prompts-choose --username <account>
//   browse click '<submit>'
//
// EXPOSURE, worth knowing before reaching for this: a chooser fill is a USER-INITIATED fill, so the password
// becomes readable by page JS immediately — unlike the silent-autofill path, where the value stays masked
// until a gesture unlocks it. The exposure is to the login origin, which is about to be sent the password
// anyway, and nothing here ever reads, logs or returns the value. But it is a real difference, and it is why
// the ordinary `click-and-await-fill` pre-gesture path stays the default on single-credential realms.

// The EFFECT probe. Returns the username values it can see plus a BOOLEAN for the password — never the
// password and never its length, the same rule LOGINSTATE_JS states and for the same reason: "it holds a
// value" is the entire signal, and a length is something learned about a credential.
const CHOOSE_VERIFY_JS = `
var __UP=${JSON.stringify({ re: LOGINSTATE_PATTERNS.userName.source, fl: LOGINSTATE_PATTERNS.userName.flags })};
return (function(){
  var rx=new RegExp(__UP.re,__UP.fl), users=[], pwFields=0, pwFilled=false, acc=[];
  (function walk(root,d){ if(d>8) return; var n=root.querySelectorAll('*');   // shadow roots too, like __pwCount:
    for(var i=0;i<n.length;i++){ acc.push(n[i]); if(n[i].shadowRoot) walk(n[i].shadowRoot,d+1); } })(document,0);
  for(var i=0;i<acc.length;i++){ var el=acc[i]; if(el.tagName!=='INPUT') continue;
    var t=(el.type||'').toLowerCase();
    if(t==='password'){ pwFields++; if(typeof el.value==='string'&&el.value.length>0) pwFilled=true; continue; }
    if(t===''||t==='text'||t==='email'||t==='tel'){
      var idn=(el.getAttribute('name')||'')+' '+(el.id||'')+' '+(el.getAttribute('autocomplete')||'');
      if(__vis(el)&&rx.test(idn)&&typeof el.value==='string'&&el.value.trim()) users.push(el.value.trim()); } }
  return JSON.stringify({usernames:users.slice(0,6), passwordFields:pwFields, passwordFilled:pwFilled});
})()`;

async function chooseVerifyProbe(tcdp) {
  const r = await evalInTarget(tcdp, `(function(){${VIS_JS}${CHOOSE_VERIFY_JS}})()`, PRESS_TIMEOUT_MS);
  try { return JSON.parse(r.value); }
  catch (_) { throw new Error('could not read the page back to verify the fill (the probe returned '
    + JSON.stringify(String(r && r.value).slice(0, 120)) + ')'); }
}

// A chooser row's accessible name is Chromium's own phrasing of the account, and it has TWO shapes rather than
// the one this verb was built against. A row saved against THIS realm reads "Password for <account>". A row
// Chromium offers because it PSL-MATCHES — saved on a different host under the same registrable domain — is
// ANNOTATED with where it came from: "Password for <account>, accounts.example.com" (if two saved rows exist
// on a sibling subdomain, both are annotated this way).
// THE ANNOTATION BROKE THIS VERB IN BOTH DIRECTIONS AT ONCE, which is why it is worth a named function. The
// MATCH half demanded the suffix (the bare account matched no row); the VERIFY half demanded it ABSENT (the
// page's username field holds the bare account). Mutually exclusive, so NO input could ever succeed — and the
// failure printed for the annotated one was "WRONG ACCOUNT — do NOT submit this form", about a row it had in
// fact picked correctly. Normalizing BOTH sides through this single function is what makes that class of
// disagreement structurally impossible: match and verify now compare the same thing.
// The strip is deliberately TIGHT — a trailing comma followed by something HOSTNAME-shaped and nothing else —
// so "alice@example.test, not-a-host" stays a name this verb REFUSES rather than a near miss it resolves. It
// is applied to the caller's --username too, so passing the annotated label works and means the same account.
const CHOOSER_ROW_REALM = /,\s*[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+\.?$/i;
const chooserAccount = (label) => {
  const s = String(label).trim().replace(CHOOSER_ROW_REALM, '').trim();
  const parts = s.split(/\s+/);
  return parts[parts.length - 1] || s;
};

async function chooseAccount(tcdp) {
  let r;
  try { r = await chooseAccountCore(tcdp, flags.username); }
  catch (e) { die(String(e.message || e)); }
  out(r);
  return finish(0);
}

// The core, shared with `login --account`. It THROWS where the verb exits, so a caller that RAISED the chooser
// itself gets a chance to back the page out first — leaving a chooser standing is the one outcome both callers
// must avoid. Every message is unchanged and still names this verb, because it is the same failure whichever
// door it arrived through.
async function chooseAccountCore(tcdp, account) {
  const want = chooserAccount(account).toLowerCase();
  const norm = (s) => String(s).trim().toLowerCase();
  const fail = (m) => { throw new Error('native-browser-prompts-choose: ' + m); };
  const before = atspiProbe();                    // code 3 IS fatal, exactly as for dismiss: cannot press unseen
  if (before.code !== 0) fail(before.err);
  const offered = before.json.filter((p) => (p.entries || []).length);
  if (!offered.length)
    fail('no saved-password chooser is showing — nothing to choose from. The '
      + 'chooser only appears when something CLICKS a CLEARED username field: with a value already in it '
      + "(Chromium usually fills one of the saved rows silently on load) there is no suggestion list to show. "
      + 'Clear the username and password fields, `browse click` the username field, then run this again. '
      + 'Showing: ' + JSON.stringify(before.json));

  // EXACT on the ACCOUNT, or a clear error — never a partial match. Both sides go through chooserAccount(),
  // which strips Chromium's fixed "Password for " prefix (by taking the label's LAST whitespace-delimited part,
  // never by searching for the account anywhere in it — a substring rule would let "alice@example.test" match a
  // row for "notalice@example.test") and the PSL realm annotation. A near miss here fills the WRONG password
  // into a form about to be submitted. Two matches is an error for the same reason — the verb never guesses.
  const hits = [];
  for (const p of offered)
    for (const e of p.entries)
      if (norm(chooserAccount(e)) === want) hits.push({ prompt: p, entry: e });
  const all = offered.flatMap((p) => p.entries);
  if (!hits.length)
    fail('the chooser is not offering "' + account + '" — it is offering: '
      + JSON.stringify(all) + '. Match the account EXACTLY as it appears there (the "Password for " prefix is '
      + "Chromium's own wording and is stripped for you, as is a \", <realm>\" annotation on a row saved "
      + 'against another host); this verb never picks a near match');
  if (hits.length > 1)
    fail('"' + account + '" matches ' + hits.length + ' rows — '
      + JSON.stringify(hits.map((h) => h.entry)) + ' — and picking either one would be a guess about which '
      + 'credential to send. Name the account so that exactly one row matches');
  const { prompt: target, entry } = hits[0];

  // The BEFORE reading, so the AFTER one is attributable. A password field that was ALREADY filled cannot
  // afterwards prove anything by being filled, which is why the caller is told to clear the fields first —
  // and why "it was already filled" is a stated condition below rather than a silent pass.
  let pre;
  try { pre = await chooseVerifyProbe(tcdp); }
  catch (e) { fail(String(e.message || e)); }

  const stillUp = (list) => list.some((p) => p.role === target.role && p.name === target.name);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitGone = async () => {
    const deadline = Date.now() + PROMPT_VERIFY_MS;
    for (;;) {
      await sleep(400);
      const now = atspiProbe();
      if (now.code === 3) return { gone: true, remaining: [] };  // whole tree went with the window
      if (now.code !== 0) fail('pressed the row for "' + account
        + '" but could not re-probe to verify it — ' + now.err);
      if (!stillUp(now.json)) return { gone: true, remaining: now.json };
      if (Date.now() > deadline) return { gone: false, remaining: now.json };
    }
  };

  // Press the row, then verify — never trust the press. AT-SPI's do_action returns true on the chooser's INNER
  // duplicate row too, where Chromium silently swallows it (measured: True returned, chooser still up, fields
  // untouched); the probe presses the outer node, but "it returned true" remains worth nothing either way.
  let gone = null, attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    const p = atspiProbe(['--press-entry', entry]);
    if (p.code === 2 && attempts > 1) { gone = await waitGone(); break; } // row gone on the retry ⇒ press 1 landed
    if (p.code !== 0) fail(p.err);
    gone = await waitGone();
    if (gone.gone) break;
  }
  if (!gone.gone)
    fail('pressed the row for "' + account + '" twice and the chooser is '
      + 'STILL showing after ' + PROMPT_VERIFY_MS + 'ms each time — ' + JSON.stringify(gone.remaining)
      + '. Nothing was chosen; the page is untouched');

  // VERIFY BY EFFECT. The chooser closing is not the proof — Escape closes it, and so does pressing the wrong
  // row. The proof is that the PAGE now carries this account.
  let post;
  try { post = await chooseVerifyProbe(tcdp); }
  catch (e) { fail('the chooser closed but ' + (e.message || e)); }
  const matched = post.usernames.find((u) => norm(u) === want) || null;
  const otherUser = post.usernames.find((u) => norm(u) !== want) || null;
  if (!matched && otherUser)
    fail('WRONG ACCOUNT — asked for "' + account + '" but the username '
      + 'field now holds "' + otherUser + '". Do NOT submit this form: whatever password Chromium filled '
      + 'belongs to that account, not the one you asked for. Reload the page, clear both fields and try again');
  const newlyFilled = post.passwordFilled && !pre.passwordFilled;
  if (!matched && !newlyFilled)
    fail('the chooser closed but NOTHING on the page changed — no username field '
      + 'holds "' + account + '" and no password field went from empty to filled, so the press was '
      + 'swallowed (or it landed on a row that fills nothing). '
      + (pre.passwordFilled ? 'The password field was ALREADY filled before the press, so it could not serve '
        + 'as proof either — clear both fields before raising the chooser. ' : '')
      + 'The page is in whatever state the chooser left it; do not submit it blind');

  return { chose: account, entry, in: target.name, role: target.role, gone: true, attempts,
           filled: post.passwordFilled, username: matched,
           ...(pre.passwordFilled ? { wasAlreadyFilled: true } : {}),
           remaining: gone.remaining };
}

// ---- ACCEPTING A SAVED CARD out of the same popup (`native-browser-prompts-choose --card <last four>`) -----
// The capability this closes: Chromium can be made to OFFER a saved card, but until now nothing could ACCEPT
// the offer, so a payment flow needed a human for its last gesture. The suggestion list is browser UI, not
// page DOM, so there is nothing at page coordinates to click — the same wall the saved-password chooser hit,
// and it has the same answer. Measured alternatives, so the next reader does not re-run them:
//   CDP Input.dispatchKeyEvent (ArrowDown then Enter) DOES NOT WORK. The popup stays up and no field changes;
//     the keys never reach its handler at all. Cheap to try, and it is not a timing problem.
//   An OS keystroke at the desktop layer DOES work (Down then Return fills every field), and it is NOT what
//     this uses. An OS keystroke goes to whichever window is in front of a desktop a person is also using, and
//     other agent sessions drive their own tabs in the same browser — a keystroke aimed at a card field can
//     land in someone else's tab or in another application entirely. It also picks a row by POSITION, so it
//     cannot say WHICH card. Pressing the accessibility node is scoped to the browser this call is already
//     talking to and names the row by last four: no keystroke exists to misdeliver.
// The label of a card row is never matched against and never echoed — see TRAP (e) in
// browse-drive-native-browser-prompts.ps1, which rewrites card rows to "card ••••<last four>" at the source.
const CARD_ROW_LABEL = /^card ••••(\d{4})$/;

// The EFFECT probe for a card fill. COUNTS ONLY — never a value, and never a per-field length, for the same
// reason CHOOSE_VERIFY_JS returns a bare boolean for the password: a length is something learned about a card.
// Two counts, because they answer different questions. `autofilled` is the strong one: Chromium sets :autofill
// on a field IT filled, which distinguishes a browser fill from a page script writing something. `nonEmpty` is
// the backstop for an engine where the pseudo-class cannot be evaluated at all — AUTOFILL_JS returns null
// there, and that null must never collapse to false (see the marker's own note), so it is counted separately.
const CARD_VERIFY_JS = `
return (function(){
  var acc=[];
  (function walk(root,d){ if(d>8) return;
    var ins=root.querySelectorAll('input'); for(var i=0;i<ins.length;i++) acc.push(ins[i]);
    var all=root.querySelectorAll('*'); for(var j=0;j<all.length;j++) if(all[j].shadowRoot) walk(all[j].shadowRoot,d+1);
  })(document,0);
  var af=0, ne=0, unknown=0;
  for(var i=0;i<acc.length;i++){ var el=acc[i], m=__af(el);
    if(m===null) unknown++; else if(m) af++;
    if(typeof el.value==='string' && el.value.length>0) ne++; }
  return JSON.stringify({inputs:acc.length, autofilled:af, nonEmpty:ne, markerUnknown:unknown});
})()`;

async function cardVerifyProbe(tcdp) {
  const r = await evalInTarget(tcdp, `(function(){${AUTOFILL_JS}${CARD_VERIFY_JS}})()`, PRESS_TIMEOUT_MS);
  try { return JSON.parse(r.value); }
  catch (_) { throw new Error('could not read the page back to verify the fill (the probe returned '
    + JSON.stringify(String(r && r.value).slice(0, 120)) + ')'); }
}

async function chooseCard(tcdp) {
  let r;
  try { r = await chooseCardCore(tcdp, String(flags.card).trim()); }
  catch (e) { die(String(e.message || e)); }
  out(r);
  return finish(0);
}

async function chooseCardCore(tcdp, lastFour) {
  const fail = (m) => { throw new Error('native-browser-prompts-choose: ' + m); };
  const before = atspiProbe();                    // code 3 IS fatal, exactly as for dismiss: cannot press unseen
  if (before.code !== 0) fail(before.err);
  const offered = before.json.filter((p) => (p.entries || []).length);
  const cardsUp = offered.flatMap((p) => (p.entries || []).filter((e) => CARD_ROW_LABEL.test(e)));

  // THE NON-SECURE-FORM DEAD END, named rather than left to look like "no cards saved". Chromium will not
  // offer a saved card on a page that is not a valid-certificate https context — not on http, not on
  // http://localhost, and not on https with a cert error (all three measured). What it
  // renders instead is this same `list box` named 'Autofill' holding ONE line of prose and NO rows:
  // "Automatic payment methods filling is disabled because this form does not use a secure connection."
  // That is indistinguishable from an empty popup unless you say so, and mistaking the one for the other is
  // exactly what made an earlier attempt conclude the card could be offered but never accepted.
  const emptyAutofillPopup = before.json.some((p) => p.role === 'list box' && p.name === 'Autofill'
                                                     && !(p.entries || []).length);
  if (!cardsUp.length && emptyAutofillPopup)
    fail("Chromium's autofill popup is showing but it is offering NO rows, which on a card field means it is "
      + 'refusing to fill rather than having nothing saved. The overwhelmingly likely cause is that this page '
      + 'is not a valid-certificate https context — Chromium declines on http, on http://localhost and on '
      + 'https with a cert error alike, and says so in the popup itself. Read it with `browse '
      + 'native-browser-prompts-view`; the card store is fine and nothing needs re-saving');
  if (!cardsUp.length)
    fail('no saved-card row is showing — nothing to accept. The popup only appears when something CLICKS a '
      + 'CLEARED card field: with a value already in it there is no suggestion list. `browse click` the card '
      + 'number field, then run this again. Showing: ' + JSON.stringify(before.json));

  // EXACT on the last four, never a partial match, and two matches is an error rather than a guess — this
  // decides which card gets paid with.
  const hits = cardsUp.filter((e) => CARD_ROW_LABEL.exec(e)[1] === lastFour);
  if (!hits.length)
    fail('the popup is not offering a card ending ' + lastFour + ' — it is offering: '
      + JSON.stringify(cardsUp) + '. Name the last four exactly as it appears there');
  if (hits.length > 1)
    fail(hits.length + ' saved cards end ' + lastFour + ', and picking either would be a guess about which '
      + 'card to pay with. Resolve the duplicate in chrome://settings/payments');
  const target = offered.find((p) => (p.entries || []).includes(hits[0]));

  // The BEFORE reading, so the AFTER one is attributable. A form that was ALREADY filled cannot afterwards
  // prove anything by being filled — stated as a condition below rather than passed silently.
  let pre;
  try { pre = await cardVerifyProbe(tcdp); }
  catch (e) { fail(String(e.message || e)); }

  const stillUp = (list) => list.some((p) => p.role === target.role && p.name === target.name
                                             && (p.entries || []).includes(hits[0]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitGone = async () => {
    const deadline = Date.now() + PROMPT_VERIFY_MS;
    for (;;) {
      await sleep(400);
      const now = atspiProbe();
      if (now.code === 3) return { gone: true, remaining: [] };  // whole tree went with the window
      if (now.code !== 0) fail('pressed the card row ending ' + lastFour
        + ' but could not re-probe to verify it — ' + now.err);
      if (!stillUp(now.json)) return { gone: true, remaining: now.json };
      if (Date.now() > deadline) return { gone: false, remaining: now.json };
    }
  };

  // Press, then verify — never trust the press. do_action returns true on the INNER duplicate row too, where
  // Chromium silently swallows it; the probe presses the outer node, but "it returned true" is
  // worth nothing either way.
  let gone = null, attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    const p = atspiProbe(['--press-entry-card', lastFour]);
    if (p.code === 2 && attempts > 1) { gone = await waitGone(); break; } // row gone on the retry ⇒ press 1 landed
    if (p.code !== 0) fail(p.err);
    gone = await waitGone();
    if (gone.gone) break;
  }
  if (!gone.gone)
    fail('pressed the card row ending ' + lastFour + ' twice and the popup is STILL showing after '
      + PROMPT_VERIFY_MS + 'ms each time — ' + JSON.stringify(gone.remaining)
      + '. Nothing was accepted; the page is untouched');

  // VERIFY BY EFFECT. The popup closing is not the proof — Escape closes it too. The proof is that the page
  // now holds fields the BROWSER filled, which is what :autofill marks and a page script cannot fake.
  let post;
  try { post = await cardVerifyProbe(tcdp); }
  catch (e) { fail('the popup closed but ' + (e.message || e)); }
  const newlyAutofilled = post.autofilled - pre.autofilled;
  const newlyNonEmpty = post.nonEmpty - pre.nonEmpty;
  if (newlyAutofilled <= 0 && newlyNonEmpty <= 0)
    fail('the popup closed but NOTHING on the page changed — no field went from empty to filled, so the press '
      + 'was swallowed (or it landed on a row that fills nothing). '
      + (pre.nonEmpty ? 'Some fields were ALREADY filled before the press, so they could not serve as proof '
        + 'either — clear the card fields before raising the popup. ' : '')
      + 'The page is in whatever state the popup left it; do not submit it blind');
  // The marker could not be evaluated anywhere AND the only evidence is a non-empty field: say so rather than
  // report a browser fill we did not actually witness.
  const proof = newlyAutofilled > 0 ? 'autofill-marker' : 'non-empty';

  return { chose: 'card ••••' + lastFour, cardLastFour: lastFour, in: target.name, role: target.role,
           gone: true, attempts, filled: true, fieldsFilled: Math.max(newlyAutofilled, newlyNonEmpty), proof,
           ...(pre.nonEmpty ? { wasAlreadyFilled: pre.nonEmpty } : {}),
           ...(post.markerUnknown ? { markerUnknown: post.markerUnknown } : {}),
           remaining: gone.remaining };
}

async function restartBrowser() {
  const t0 = Date.now();
  const deadline = t0 + BUDGET_MS;                        // ONE wall-clock budget for the whole verb
  const left = () => deadline - Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. read the current tab set. A DOWN browser is not an error here: there is simply nothing to read.
  // But a browser that ANSWERS yet won't hand over its tab list is a different animal — restarting then would
  // destroy tabs with no record of them, so a timeout dies instead of being filed as "down". Each step is
  // capped (8+12+12s) so this phase cannot eat the budget. wsBefore is the OLD browser's identity (the
  // per-start UUID in webSocketDebuggerUrl) — gate 1 refuses to accept the old browser as the new one.
  let browser = null, targets = [], down = null, wsBefore = null;
  try {
    wsBefore = (await cdpHttpJSON('/json/version', 8000)).webSocketDebuggerUrl || null;
    browser = await withTimeout(connectBrowser(), 12000, 'connecting to the browser');
    targets = await withTimeout(listPageTargets(browser), 12000, 'listing the open tabs');
  } catch (e) {
    const m = errText(e);
    if (/timed out|timeout/i.test(m))
      die('restart-browser: could not read the tab list before restarting (' + m + ') — the browser answers but '
        + 'not usably, so a restart would destroy tabs with no record of them. Retry, or fix the browser first.');
    down = m;
  }
  const map = loadMap();
  const owner = {}; for (const [k, v] of Object.entries(map)) owner[v] = k;   // targetId → owning session
  const sessions = [];
  for (const t of targets) { const s = owner[t.targetId]; if (s && !sessions.includes(s)) sessions.push(s); }
  const nAgent = targets.filter((t) => owner[t.targetId]).length;
  const token = planToken(targets.map((t) => t.targetId));

  // ---- 2. no --yes ⇒ SHOW, don't do. Report on stderr + exit non-zero, so the tool-wide contract holds
  // (non-zero ⇒ stdout is empty and must be discarded) and no caller can mistake a dry run for a restart.
  if (!flags.yes) {
    if (browser) browser.close();
    const L = (s) => fs.writeSync(2, s + '\n');
    L('restart-browser BLAST RADIUS — nothing was restarted. This is what --yes would do:');
    L('  browser:             ' + (down ? 'DOWN (' + down + ') — a restart is the fix' : 'up'));
    L('  tabs open:           ' + targets.length + ' — Chromium restores its own saved session, so these come '
      + 'back by themselves; this verb reopens nothing and CHECKS every URL below comes back');
    L('  agent/session-owned: ' + nAgent + (sessions.length ? ' (sessions: ' + sessions.join(', ') + ')' : '')
      + ' — the tab survives but its targetId does not: every session is unregistered and mints a fresh tab on demand');
    L('  tab list:');
    for (const t of targets) L('      ' + (redactUrl(t.url) || '(no url)'));
    L('  plan token:          ' + token + '  (of the ' + targets.length + ' tabs above; --yes refuses a stale one)');
    die('restart-browser: refusing without --yes — it TEARS DOWN every open tab (' + targets.length + '), a tab '
      + 'a human is using included, and a tab that fails to restore is gone. When the list above is '
      + 'acceptable, re-run:  browse restart-browser --yes ' + token);
  }

  // ---- 2b. the approval must be for the tab set that was SHOWN. Otherwise the window between the dry run and
  // the apply (another session opening a tab, a human closing one) silently changes what gets destroyed.
  if (flags.yes !== token)
    die('restart-browser: the tab set changed since you looked (plan token is now ' + token + ', you passed '
      + flags.yes + ') — re-run without --yes to see the current blast radius, then approve THAT token.');

  // ---- 3. WRITE THE SNAPSHOT BEFORE ANYTHING IS KILLED. Session restore is reliable but it is not a
  // guarantee, and the tab list otherwise lives only in this process's memory: a restart that comes back wrong
  // (or a wrapper SIGKILL) would take the tabs AND the record of them with it. Every failure message from here
  // on names this path, so a failed restart is always recoverable by hand.
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const snapshot = path.join(RESTORE_DIR, 'browse-restore-' + stamp + '.json');
  // CREDENTIAL-BEARING BY DESIGN: this file holds REAL, unredacted URLs on purpose — reopening a missing tab
  // from it is its whole purpose, and a redacted URL can't be pasted back into a browser. Only this file's
  // PATH is ever printed (see the failure/verdict messages below); the tab list a human actually SEES (blast
  // radius, missing/extra) goes through redactUrl. It lives in the state dir beside the session map, so keep
  // that dir readable only by the agent's own account.
  try {
    fs.mkdirSync(RESTORE_DIR, { recursive: true });
    fs.writeFileSync(snapshot, JSON.stringify({ ts: new Date().toISOString(), sessions,
      tabs: targets.map((t) => ({ targetId: t.targetId, url: t.url, title: t.title == null ? null : t.title })) }, null, 2),
      { mode: 0o600 });
  } catch (e) {
    die('restart-browser: cannot write the pre-restart snapshot to ' + snapshot + ' (' + (e.message || e) + ') — '
      + 'refusing to restart: without it a restart that goes wrong loses the tab list with no record anywhere.');
  }
  // Everything past this point has already torn down, or is about to tear down, the tabs.
  const lost = (why) => die('restart-browser: ' + why + ' — the old browser is GONE and whatever Chromium did or '
    + 'did not restore is unverified. The pre-restart tab list is saved at ' + snapshot + ' (its "tabs" array is '
    + 'the list to reopen by hand).');
  const budget = (what) => { if (left() <= 0) lost('ran out of its ' + Math.round(BUDGET_MS / 1000) + 's wall-clock budget at ' + what); };

  // ---- 4. restart. Drop our own sockets first: they die with the browser either way.
  if (browser) { try { browser.close(); } catch (_) {} }
  // The command must NOT leave a child holding stdout/stderr (spawnSync waits on the pipes, not just the pid) —
  // `schtasks` doesn't, and a test's injected respawn should redirect its child to /dev/null.
  const rc = spawnSync('cmd.exe', ['/c', RESTART_CMD], { encoding: 'utf8', timeout: RESTART_CMD_MS, killSignal: 'SIGKILL' });  // WINDOWS: cmd.exe, not /bin/sh
  if (rc.error) lost('the restart command failed (' + RESTART_CMD + '): ' + (rc.error.message || rc.error));
  if (rc.status !== 0)
    lost('the restart command ' + (rc.signal ? 'was killed by ' + rc.signal + ' after the ' + RESTART_CMD_MS + 'ms cap'
      : 'exited ' + rc.status) + ' (' + RESTART_CMD + '): ' + String(rc.stderr || rc.stdout || '').trim().slice(0, 300));

  // ---- 5. wait for GENUINE readiness, in three gates, all bounded by the one budget. Reporting ready early is
  // the classic bug here: the HTTP endpoint answers seconds before the browser is usable, and the next verb
  // then fails on a browser this verb just declared healthy.
  const tReady = Date.now();
  const gateEnd = (ms) => Math.min(Date.now() + ms, deadline);
  //   GATE 1 — a NEW browser answers the CDP HTTP endpoint. Not merely "something answers": the old browser is
  //   still listening for the moment it takes to die, and a restart command that silently NO-OPS (a wrong unit
  //   name, a neutered BROWSE_RESTART_CMD) would otherwise sail through every gate and be reported as a healthy
  //   restart that never happened. The per-start UUID in webSocketDebuggerUrl must change. (No baseline when the
  //   browser was already down — then any answer is a new browser.)
  budget('gate 1 (a new browser answering)');
  for (const d = gateEnd(READY_MS); ;) {
    try {
      const ws = (await cdpHttpJSON('/json/version', READY_POLL_MS)).webSocketDebuggerUrl || null;
      if (ws && ws !== wsBefore) break;
    } catch (_) {}
    if (Date.now() >= d) lost('the restart command ran but a NEW browser never answered within '
      + Math.round((d - tReady) / 1000) + 's (CDP ' + CDP + (wsBefore ? ', still the pre-restart browser' : '')
      + '; check: ' + RESTART_CMD + ')');
    await sleep(250);
  }
  //   GATE 2 — the TAB COUNT is back to what it was, and has stopped moving. Session restore reopens the tabs
  //   in waves, so a single poll catches it mid-flight; three matching polls in a row is the "it has settled"
  //   signal. A COUNT gate, deliberately: it is the cheap "have the tabs finished arriving" wait, not the
  //   verdict — step 7 compares the URLs themselves and decides.
  const want = targets.length;
  let after = -1, seen = -1, stable = 0;
  budget('gate 2 (the tabs coming back)');
  for (const d = gateEnd(READY_MS); ;) {
    try {
      const n = (await cdpHttpJSON('/json', READY_POLL_MS)).filter((t) => t.type === 'page').length;
      stable = (n === seen) ? stable + 1 : 0;
      seen = n;
    } catch (_) { stable = 0; seen = -1; }
    if (stable >= 2 && seen >= want) break;
    if (Date.now() >= d) break;
    await sleep(400);
  }
  after = seen;
  //   GATE 3 — the exact handshake every OTHER verb performs: a browser-level websocket plus a Target.getTargets
  //   round-trip. Until this succeeds the browser is not usable, whatever HTTP says. Its tab list is also the
  //   authoritative `after` count — same source every other verb reads.
  let nb = null, afterTabs = [];
  budget('gate 3 (a usable CDP websocket)');
  for (const d = gateEnd(20000); ;) {
    try {
      nb = await withTimeout(connectBrowser(), 8000, 'gate 3 connect');
      afterTabs = await withTimeout(listPageTargets(nb), 8000, 'gate 3 getTargets');
      after = afterTabs.length;
      break;
    } catch (e) {
      if (nb) { try { nb.close(); } catch (_) {} nb = null; }
      if (Date.now() >= d) lost('the browser restarted but never accepted a CDP websocket within '
        + Math.round((d - tReady) / 1000) + 's');
      await sleep(250);
    }
  }
  //   GATE 3b — settle the URL comparison. A tab that has just been restored exists as a target a beat before
  //   its navigation commits, so ONE read can show a tab as "missing" that is merely still arriving. Re-read
  //   while anything looks missing, briefly and bounded by the same budget. This cannot mask a real loss: a tab
  //   that did not come back never appears, however many times it is asked for.
  let missing = [], extra = [];
  for (const d = gateEnd(Math.min(6000, Math.max(0, left()))); ;) {
    ({ missing, extra } = urlDiff(targets.map((t) => t.url), afterTabs.map((t) => t.url)));
    if (!missing.length || Date.now() >= d) break;
    await sleep(500);
    try {
      afterTabs = await withTimeout(listPageTargets(nb), 8000, 'gate 3b getTargets');
      after = afterTabs.length;
    } catch (_) { /* keep the last good read; the loop's deadline ends it */ }
  }
  try { nb.close(); } catch (_) {}
  const readyMs = Date.now() - tReady;

  // ---- 6. every targetId in the map died with the old browser — the TAB came back, its id did not. Clearing
  // is what makes each session mint a fresh tab instead of addressing a dead id.
  try { saveMap({}); } catch (_) {}

  // ---- 7. the verdict, decided on the URLs (the same list the snapshot holds), not on the count. A tab that
  // did not come back is a FAILURE, not a field in a success object — only the operator can tell whether the
  // missing tab mattered — so: non-zero, with the report on stderr so the "non-zero ⇒ stdout is empty and must
  // be discarded" contract that every other verb honors is not broken by the one verb that tears things down.
  // The count shortfall is kept as a cheap early signal (and it still names `lost:<n>`), but `missing` is the
  // authoritative test: it catches the count-blind case where one tab drops while a human opens another during
  // the readiness polls. `extra` is reported and is NOT an error — that human's tab, or a session restored by a
  // browser that was already down before this process ever saw it.
  // urlDiff above ran on the REAL urls (it must, to match correctly); everything printed from here on is the
  // redacted view — the snapshot file (real urls, path only ever named) is the recovery path for the actual value.
  const o = { restarted: true, tabs: { before: want, after }, sessions, snapshot,
              missing: missing.map(redactUrl), extra: extra.map(redactUrl), elapsedMs: Date.now() - t0, readyMs };
  if (down) o.note = 'the browser was already DOWN before the restart (' + down + ') — no pre-restart tab list to compare against';
  if (missing.length || after < want) {
    let msg = 'ERR restart-browser: ';
    if (after < want) {
      o.lost = want - after;
      msg += 'the browser came back with ' + after + ' tab(s), not the ' + want + ' it had — ' + (want - after)
           + ' did NOT restore.';
    } else {
      msg += 'the browser came back with the right NUMBER of tabs (' + after + '), but not the same ones.';
    }
    msg += '\n  did NOT come back (' + missing.length + '):\n' + missing.map((u) => '      ' + redactUrl(u)).join('\n');
    if (extra.length) msg += '\n  came back that was not open before (' + extra.length + ', benign — someone '
      + 'opened it while the browser was restarting):\n' + extra.map((u) => '      ' + redactUrl(u)).join('\n');
    msg += '\nReopen the missing tab(s) by hand; the full pre-restart list is at ' + snapshot;
    fs.writeSync(2, msg + '\n' + JSON.stringify(o) + '\n');
    return finish(1);
  }
  out(o);
  return finish(0);
}

// Reproduce Playwright page.goto({waitUntil:'load'})'s {url,title,status} over raw CDP:
//   Page.enable + Network.enable BEFORE navigating; resolve on Page.loadEventFired (90s) OR navigate errorText.
//   status = the FINAL main-frame Document response (frameId == the navigated main frame, type == 'Document');
//   keep the LAST such response so a 302→200 reports 200. status = null (no Document response: about:blank/
//   data:/download) must NOT hang — gate on loadEventFired-or-short-settle, not solely on a response event.
async function rawGoto(tcdp, url) {
  await tcdp.send('Page.enable');
  await tcdp.send('Network.enable');

  // Buffer EVERY Document responseReceived by frameId — the response can arrive BEFORE Page.navigate
  // resolves (localhost is fast), so we can't filter on the main frame id until afterwards. Keep the LAST
  // Document status per frame so a 302→200 chain reports the final 200.
  const docByFrame = new Map(); // frameId → last Document response status
  let loaded = false;
  let settled = false; // set once the load race resolves → stops the readyPoll from running a stray eval
  let resolveLoad;
  const loadFired = new Promise((res) => { resolveLoad = res; });

  tcdp.on('Network.responseReceived', (p) => {
    if (p.type === 'Document') docByFrame.set(p.frameId, p.response.status);
  });
  tcdp.on('Page.loadEventFired', () => { loaded = true; resolveLoad(); });

  let mainFrameId;
  let hardTimer; // 90s hard cap — hoisted so we ALWAYS clearTimeout it once the race settles (no dangling timer)
  try {
    const nav = await tcdp.send('Page.navigate', { url });
    if (nav.errorText && nav.errorText !== 'net::ERR_ABORTED') throw new Error('navigate: ' + nav.errorText);
    mainFrameId = nav.frameId;

    // Settle the wait on loadEventFired OR document.readyState==='complete' (90s hard cap). The readyState poll
    // is the no-hang gate: about:blank/data: pages may not (re-)fire a load event after navigate, but they reach
    // 'complete' instantly — so we never block the full 90s on them while still letting a real page run to load.
    const deadline = Date.now() + 90000;
    const readyPoll = (async () => {
      while (!loaded && !settled && Date.now() < deadline) {
        const rs = await evalInTarget(tcdp, 'document.readyState').catch(() => ({ value: null }));
        if (settled) return; // race already won by another arm — don't eval/poll further
        if (rs.value === 'complete') return;
        await new Promise((res) => setTimeout(res, 100));
      }
    })();
    const hardCap = new Promise((res) => { hardTimer = setTimeout(res, 90000); });
    await Promise.race([loadFired, readyPoll, hardCap]);
    settled = true; // stop the readyPoll loop from issuing any more evals on this tab
    if (!loaded && Date.now() >= deadline) throw new Error('open-url: timed out after 90s loading ' + url);

    const title = (await evalInTarget(tcdp, 'document.title').catch(() => ({ value: null }))).value;
    const finalUrl = (await evalInTarget(tcdp, 'location.href').catch(() => ({ value: url }))).value;
    const status = docByFrame.has(mainFrameId) ? docByFrame.get(mainFrameId) : null;
    return { url: finalUrl, title: title == null ? null : title, status };
  } finally {
    settled = true;
    if (hardTimer) clearTimeout(hardTimer);
    // leave no enabled domains on a PERSISTENT tab — every open-url would otherwise stack another
    // Network/Page subscription, and the buffered events would grow unbounded across calls.
    await tcdp.send('Network.disable').catch(() => {});
    await tcdp.send('Page.disable').catch(() => {});
  }
}
