# browse — a real browser for AI agents

`browse.js` lets an agent drive a real, logged-in Chrome or Chromium over the DevTools protocol (CDP). Each agent session gets its own background tab, so several agents can share one browser without clobbering each other. Calls are meant to run one at a time, behind a lock. Every verb prints one JSON line on stdout; errors go to stderr with a non-zero exit.

- Needs: Node.js 18+, the `ws` package where Node can resolve it from `browse.js`'s directory, and a browser started with `--remote-debugging-port`.
- Run: `BROWSE_SESSION=<agent session id> node browse.js <verb> [args] [flags]`. Without `BROWSE_SESSION`, a call gets a throwaway tab that closes afterward.
- Wrap it: run every call under one lock with a hard time cap, e.g. `flock /tmp/browse.lock timeout -k 10 240 node browse.js "$@"`. The setup folders below ship a wrapper.
- No credentials pass through it by design: `login` relies on the browser's own saved passwords, and no verb prints a password or autofilled field's value or its length. That is a convention, not a wall: `run-js` runs with the page's full access and can read a filled password field, so an agent following instructions it read on a page could still use it.
- Tested: the version of `browse.js` this was packaged from passes its own self-test (not shipped) on the Linux and macOS setups. This copy was only syntax-checked after its last edits (the password-field and browser-internal-page refusals, file permissions), which have not been run against a browser. Each setup folder says what was tested there.

## Choose a setup
| Folder | Where the browser runs | Pick it when |
|:---|:---|:---|
| `linux/` | An always-on Linux machine: VM, container, spare computer or cloud server | You want a browser that is up around the clock |
| `orbstack/` | A Linux machine inside your Mac, via OrbStack | You have a Mac and want the Linux setup without a second machine |
| `macos/` | Your Mac's own Chromium, driven directly | You want the agent to use the logins you already have; it works in background windows and never takes your focus |
| `windows/` | Edge on Windows (separate code) | You are on Windows |

- Zero-install alternative: Google's [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) with `--autoConnect` attaches an MCP client to the Chrome you already have open.

## Verbs
### Look
- `open-url <url>`: navigate and wait for load. Returns `{url,title,status}`. Check the content too; a sign-in page can return 200. Refuses browser-internal pages (`chrome://`, `edge://`, `devtools://`, `view-source:`, `javascript:`, `about:` other than `about:blank`), which show saved passwords and settings.
- `get-text [selector]`: visible text of the page or of one element.
- `get-html [selector]`: raw HTML of the page or of one element.
- `get-values <sel[==expected]>…`: live field values. Exits non-zero on a mismatch. Password and autofilled fields are withheld.
- `snapshot [scopeSelector]`: the interactive elements, each with a stable `ref` for later `--ref <n>` calls.
- `screenshot [path]`: full-page PNG.
- `print2pdf [path]`: PDF of the page.
- `save-page [url] [name]`: one self-contained `.html` file. Linux only; needs the SingleFile extension and `xdotool`.
- `download <url|selector>`: fetch a file into the browser's own download folder. Returns its path.
- `highlight-text <selector>`: select text on screen for a human watching.
- `run-js <code>`: run JavaScript in the page and return the value of its last expression.

### Act
- `click <selector>` or `click --ref <n>`: a trusted mouse click. It reports whether the page changed (`effect`) and names anything covering the target.
- `enter-text <selector> <text>`: clear a field and type into it. The typed value is not echoed back; on a password or autofilled field, even errors say only whether the field holds a value.
- `press-key <selector> <key>`: send one control key: Enter, Tab, Escape, arrows, Home/End, PageUp/PageDown, Backspace, Delete or Space.
- `upload-file <selector> <path>`: attach a local file to an `<input type=file>`.
- `click-and-await-fill <clickSel> <targetSel> [ms]`: prove the browser autofilled a saved password without reading it.

### Sign in
- `login <site>`: sign in with the browser's saved password, using a recipe from the login registry. `login --list` lists the enrolled sites.
- `login-state`: classifies the current tab as LOGGED_IN, SIGN_IN_SELF_SERVE, SIGN_IN_HUMAN or UNRESOLVED.
- `session-state [site]`: asks the site's server whether the session is still alive.
- `native-browser-prompts-view` / `-dismiss --button <name>` / `-choose --username <u>|--card <last4>`: read or press the browser's own pop-ups. Linux only; needs AT-SPI plus two helpers from `linux/`: `browse-drive-native-browser-prompts.py` next to `browse.js`, and `browse-atspi-as-browser-user.py` named by `BROWSE_ATSPI_PROBE` (the linux wrapper sets it). Without it these verbs say they cannot see the pop-ups; they never report an all-clear.

### Manage the browser
- `browser-status`: is the browser up, and which tab is this session's.
- `list-tabs`: every tab, with its owning session and its `targetId`.
- `close-tabs`: closes this session's tab. `--agents` closes all agent tabs; `--stale` closes `file://` leftovers; `--target <id>` closes one named tab.
- `dismiss-dialog [--probe-only]`: find, and clear, a tab frozen by a JavaScript alert/confirm/leave-page dialog.
- `restart-browser [--yes <token>]`: without `--yes`, shows which tabs would be lost and prints a token; `--yes <token>` restarts. Uses `BROWSE_RESTART_CMD`.

## Flags
- `--new`: use a throwaway tab for this call.
- `--out <path|->`: where a capture goes; `-` streams the bytes to stdout.
- `--ref <n>`: aim at an element from `snapshot` instead of at a selector.
- `--frame <iframe selector>`: act or read inside an iframe, cross-origin included.
- `--wait <ms>` / `--no-wait`: how long to wait for the target element. Reads wait only with `--wait`.
- `--expect <kind>:<value>`: click only. Fails unless the page shows the change: `url-contains`, `appears`, `disappears`, `text` or `value-changes`. `--expect-ms` sets the wait.
- `--expect-url <substring>`: refuse to act unless the tab's URL contains this.
- `--force`: click even when something covers the target.
- `--no-recheck`: click without re-checking the aim right before the press.
- `--no-activate-retry`: do not bring the tab forward and retry when a click or Enter changes nothing. Use it for anything that must not fire twice.
- `--raw-urls`: show URLs unredacted. By default query values, the `#` fragment and any `user:password@` are masked; a token inside the path itself (a reset or sign-in link like `/reset/<token>`) is shown as is.
- `--account <email>`: `login` only; which saved account to pick when a site has several.
- `--no-effect`: click only; skip the before/after change check.
- `--echo-value`: enter-text only; print the value that landed in the field (debugging; never on a password or autofilled field).
- `--no-preflight`: click-and-await-fill only; skip the no-click autofill proof and always click, then poll.
- `--resolve`: login-state only; spend one trusted click on the password field to settle an UNRESOLVED verdict.
- `--stay-front`: screenshot only; leave the captured tab in front instead of handing the foreground back.
- `--any-session`: close-tabs with `--target` only; allow closing a tab another session owns.

## Settings
- `BROWSE_CDP`: the browser's DevTools endpoint. Default `http://localhost:9222`.
- `BROWSE_SESSION`: this agent's session id, which keys its tab.
- `BROWSE_SESSION_MAP`: the session-to-tab file. Default `/run/browse-sessions.json`.
- `BROWSE_REF_MAP`: where `snapshot` refs are stored. Default `/run/browse-refs.json`.
- `BROWSE_DOWNLOADS`: where screenshots, PDFs and saved pages go. Default `/root/Downloads`.
- `BROWSE_LOGIN_REGISTRY`: the login recipe file. Default `browse-site-login-recipes.json` next to `browse.js`.
- `BROWSE_RESTART_CMD`: how `restart-browser` restarts the browser. Default `systemctl restart agent-browser`.
- `BROWSE_ATSPI_PROBE`: the program the native-prompt verbs run. Default `browse-drive-native-browser-prompts.py` next to `browse.js`; the linux wrapper points it at `browse-atspi-as-browser-user.py`.
- `BROWSE_RESTORE_DIR`: where `restart-browser` saves the list of open tabs before restarting. Default `/run`.
- `BROWSE_DISPLAY`: the X display the browser runs on, for keystroke fallbacks. Default `:99`.
- `BROWSE_PRESS_TIMEOUT_MS`: default wait for a target element. Default 30000.
- `BROWSE_EFFECT_MS` / `BROWSE_EXPECT_MS`: how long a click is watched for a change: 400 normally, 5000 with `--expect`.
- `BROWSE_EVAL_TIMEOUT_MS`: cap on one in-page evaluation. Default 90000.
- `BROWSE_SAVEPAGE_MS`: cap on one `save-page`. Default 150000.
- `BROWSE_RESTART_BUDGET_MS` / `BROWSE_READY_MS`: `restart-browser`'s total time limit (default 195000) and its wait for the new browser to answer (default 45000).
- The `/run` defaults assume the Linux setup running as root. Anywhere else, point the paths at a folder you can write to.

## Login recipes
No recipe file ships. Until you write one, `login`, `login --list` and `session-state` (with or without a site) fail closed with an error. The default path is `browse-site-login-recipes.json` next to `browse.js`; `BROWSE_LOGIN_REGISTRY` overrides it.
A recipe file holds CSS selectors and URLs only: never a username, password or account. Unknown keys are an error.
```json
{ "sites": {
  "example": {
    "entry": "https://example.com/login",
    "password": "input[type=password]",
    "submit": "button[type=submit]",
    "signal": { "urlContains": "/dashboard", "noPasswordFields": true },
    "session": { "probe": "/api/me", "ok": [200], "no": [401, 403], "okContentType": "json" }
  },
  "example-blocked": { "blocked": "BLOCKED_403", "note": "CAPTCHA wall before any form" }
} }
```
- `entry`: the URL a person would start signing in at.
- `password` / `submit`: selectors for the password field and the sign-in button.
- `signal`: how to tell the sign-in worked: `urlContains`, `titleContains`, `selector`, `noPasswordFields`. Every condition given must hold.
- `session`: optional. A same-origin endpoint that needs the session, used by `session-state`.
- Optional: `settleMs`, `verifyMs`, `rounds` (1-3, for two-step sign-ins), `submitReady`, `afterSubmit` (up to 3 `{urlContains, click}` steps), `username` (a selector for sites with several saved accounts; pass `--account` at call time), `blocked` (a cause code: never navigate) and `note`.
- `login` uses the password the browser already has saved, so save it in the browser once, by hand, first.

## Cookie auto-delete
`browse-cookie-auto-delete.js` deletes a site's cookies, and its local storage, IndexedDB, service workers, Cache Storage and file-system storage (`--cookies-only` keeps those), once no tab has been open on it for 20 minutes, unless the site is whitelisted. It does what the Cookie AutoDelete extension did before Chrome's Manifest V3 switch disabled it.
- Dry run by default: each sweep logs what it would delete. `--arm` makes it delete. Read the log for a few days before arming.
- Whitelist: copy `browse-cookie-whitelist.example.json` to `browse-cookie-whitelist.json` next to the tool and list your domains. A domain covers all its subdomains (`example.com` keeps `mail.example.com`). No whitelist file, no sweep. Private addresses (LAN, localhost) are always kept.
- `BROWSE_PURGE_REQUIRE=a.com,b.com`: domains it refuses to arm without. Name the sessions you can least afford to lose, so a line deleted from the whitelist by mistake stops the sweep instead of signing you out.
- Holds: `--hold a.com` protects a domain for an hour (`--hold-minutes N` for longer); `--list-holds`, `--drop-hold a.com`. `login` holds every domain its sign-in passed through, so single-sign-on hops survive. After signing in to a site by hand, hold it or whitelist it.
- Safety: a sweep never runs during a `browse` call (same lock), and deletes nothing while the browser is restoring its tabs after a restart.
- `--show-whitelist` prints what is protected; `--help` lists every flag and setting.
- Where it runs: the Linux setup, including OrbStack, on a timer (see `linux/`). Not on macOS or Windows as shipped: it needs `flock`, `/proc` and `/run`.
- Tested against a scratch Chromium (dry run, armed sweep, whitelist, holds, `login`'s hold). The Linux timer has not been run.
