#!/usr/bin/env node
// browse-cookie-auto-delete.js - whitelisted cookie auto-delete for the browser `browse.js` drives.
//
// A site's cookies (and its localStorage / IndexedDB) are deleted once no tab has been open on it for a grace
// period, unless the site is whitelisted. It does over CDP what the Cookie AutoDelete extension did before
// Chrome's Manifest V3 enforcement disabled it. Run it on a schedule (the Linux setup uses a systemd timer).
//
// Install: next to browse.js, with `ws` resolvable from this file's directory, plus a whitelist file
//   (browse-cookie-whitelist.json; start from browse-cookie-whitelist.example.json).
// Invoke:  node browse-cookie-auto-delete.js [--arm] [flags]      (--help lists them)
//
// DRY RUN IS THE DEFAULT AND ARMING TAKES AN EXPLICIT FLAG (--arm). A tool that silently deletes session
// state costs a human a sign-in and a second factor per mistake, so it lists what it WOULD delete and nothing
// else until someone has read its log for a while and passes --arm.
//
// THE FIVE THINGS THAT KEEP IT FROM EATING A LIVE SESSION:
//   1. THE WHITELIST IS MATCHED AT THE REGISTRABLE DOMAIN (eTLD+1), never at the origin. Cookies are set
//      on domains, usually with a leading dot, so whitelisting accounts.google.com while purging
//      mail.google.com would take out the shared .google.com session - the exact failure this tool exists to
//      prevent. Whitelist and purge at the same granularity or not at all.
//   2. A GRACE PERIOD OF WALL-CLOCK TIME since a tab was last open on the domain (--grace-minutes, default 20,
//      floor 5). A domain becomes a purge CANDIDATE the moment no open tab is on it, but is not purged until
//      it has been in that state for the grace period. An OAuth bounce, a 3-D-Secure step-up or a payment
//      redirect leaves the origin for seconds at a time, and cutting the cookies there breaks the login it
//      was in the middle of.
//      WALL-CLOCK TIME, NOT A COUNT OF ABSENT SWEEPS: with a sweep count the real protection is a side effect
//      of the schedule, and tightening the timer silently shrinks it. A duration is the same however often
//      the sweep runs, so the schedule only decides how PROMPTLY a purge happens, never WHETHER a live session
//      survives it. Do not "simplify" it back to a counter.
//   3. THE GLOBAL BROWSE LOCK. The sweep re-execs itself under `flock -n` on the lock the browse wrapper takes,
//      so it never runs while an agent call is in flight. On a conflict it skips the whole sweep and purges
//      nothing: a busy hour costs a delayed purge rather than a purge during a redirect chain.
//   4. THE RESTART GUARD. During session restore no tab has reopened yet, so EVERY domain looks abandoned and
//      a sweep landing in that window would condemn everything protected only by an open tab. Three cheap,
//      independent signals, any one of which HOLDS the sweep: see restartGuard().
//   5. THE TIME-LIMITED HOLD LIST. Temporary protection with a wall-clock expiry, for what the permanent
//      whitelist cannot cover: a site someone signed into BY HAND, and a third-party auth origin that only
//      appears at runtime (an SSO host, an identity provider). `browse login` adds every domain its login
//      walked through, so the auth chain protects itself. See "the hold list" below.
//
// WHY EVERY FUZZY EDGE LEANS TOWARD NOT DELETING: an extra protected domain costs some stale cookies nobody
// purged. A missing one costs a session, and getting it back costs a human a sign-in and a second factor. So
// the public-suffix table below fails SHORT rather than long, and every PRIVATE address is protected by RULE
// rather than by enumeration.
//
// THE PURGE MECHANISM WAS MEASURED, NOT CHOSEN, against three cookies planted on one registrable domain - a
// host cookie on a.group.test, a Domain=.group.test cookie set from it, and a host cookie on b.group.test:
//   * Storage.clearDataForOrigin(origin, "cookies") deleted ONE of the three, the exact-host cookie for the
//     origin named. The Domain=.group.test cookie and the sibling subdomain's cookie both SURVIVED. That
//     residue is the session: a shared .google.com cookie is exactly that shape, so a purge built on it would
//     report success and delete nothing that mattered.
//   * Per-cookie Network.deleteCookies({name, domain, path}) deleted all three. That is what ships, and the
//     sweep re-reads the jar afterwards and logs any survivor rather than trusting the call.
// THE DELETION CALLS NEED A PAGE SESSION. Storage.clearDataForOrigin answers "Internal error" (-32603) at
// BROWSER scope, while Storage.getCookies works there fine. So the sweep BORROWS a session: it attaches to an
// existing page target, deletes through it, and detaches. It never navigates, activates or closes the tab it
// borrowed. Only if no page target exists at all does it open its own about:blank tab, and then it closes the
// tab IT created and nothing else.
//
// localStorage / IndexedDB GO WITH THE COOKIES, with one gap: Storage.clearDataForOrigin is ORIGIN-scoped
// including the PORT, and a cookie records no port. The sweep clears the default-port origins it can name
// (https://host and http://host for every cookie host and for the registrable domain), which is every real
// site, and leaves storage on a non-default port alone. Cookies are the session; this bucket is hygiene.
// --cookies-only turns it off entirely.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');

const CDP = process.env.BROWSE_CDP || 'http://localhost:9222';   // override for a scratch browser
const CDP_URL = new URL(CDP);
const WHITELIST_FILE = process.env.BROWSE_PURGE_WHITELIST || path.join(__dirname, 'browse-cookie-whitelist.json');
const STATE = process.env.BROWSE_PURGE_STATE || '/run/agent-browser-cookie-auto-delete.state.json';
// THE HOLD LIST LIVES ON DISK, NOT IN /run. /run is tmpfs: a reboot would drop every hold silently, and a hold
// is the only thing standing between a hand-signed-in site and the next armed sweep. The last-seen-open
// timestamps can live in tmpfs precisely because losing them is the SAFE direction (every domain starts its
// grace period again); losing a hold is not.
const HOLDS = process.env.BROWSE_PURGE_HOLDS || path.join(__dirname, 'browse-cookie-auto-delete-holds.json');
const LOG = process.env.BROWSE_PURGE_LOG || path.join(__dirname, 'browse-cookie-auto-delete.log');
const LOG_MAX = Number(process.env.BROWSE_PURGE_LOG_MAX_BYTES) || 2 * 1024 * 1024;   // truncate-to-tail past this
const LOCK = process.env.BROWSE_LOCK || '/run/browse.lock';
const GRACE_MINUTES_DEFAULT = Number(process.env.BROWSE_PURGE_GRACE_MINUTES) || 20;
// THE FLOOR. NON-ZERO IS THE LOAD-BEARING PART: no setting may turn this into purge-on-tab-close. Five minutes
// clears both a redirect (seconds) and a human-paced step-up such as reading a code off a phone (a minute or
// two). A floor below the hold window is safe because a held domain has its clock refreshed on every sweep it
// is held through, so hold and grace run in series, never in competition. A test wanting a shorter effective
// grace ages the state file instead.
const GRACE_MINUTES_MIN = 5;
const LOCK_BUSY_EXIT = 75;                                        // flock -E: EX_TEMPFAIL, distinct from any child exit code
const HOLD_MINUTES_DEFAULT = Number(process.env.BROWSE_PURGE_HOLD_MINUTES) || 60;
const UNIT = process.env.BROWSE_PURGE_UNIT || 'agent-browser';    // systemd unit, the fallback uptime source
// HOW LONG THE BROWSER MUST HAVE BEEN UP before the sweep trusts the tab list. A session restore takes well
// under a minute; ten minutes costs at most one skipped sweep after a restart, and being wrong the other way
// costs several sessions, so the headroom is deliberately lopsided.
const UPTIME_MIN_S = Number(process.env.BROWSE_PURGE_UPTIME_MIN_S) || 600;
// How many recent sweeps the open-domain watermark looks back over - see restartGuard().
const OPEN_DOMAIN_WINDOW = 6;
// WHAT SIZE OF GROWTH IN THE TARGET LIST IS A RESTORE RATHER THAN SOMEBODY OPENING TABS. Both have to hold.
// On a browser several agents share, ordinary churn moves the count by up to about x1.5 and +8 between sweeps.
// A restore repopulates the whole tab set at once against a previous reading of one or two, so it clears x3
// by construction. The absolute floor stops a small count manufacturing a large ratio: 2 -> 5 means nothing.
const GROWTH_RATIO_MIN = Number(process.env.BROWSE_PURGE_GROWTH_RATIO_MIN) || 3;
const GROWTH_ABS_MIN = Number(process.env.BROWSE_PURGE_GROWTH_ABS_MIN) || 8;
// WHICH RESTART-GUARD LAYERS ARE LIVE. All three by default. Each layer has to be testable ALONE: a scratch
// test browser is by definition seconds old, so with everything on a test would only ever measure the guard.
// Setting it EMPTY turns the guard off, for tests of the purge itself.
const GUARD_LAYERS = new Set(String(process.env.BROWSE_PURGE_RESTART_GUARD ?? 'uptime,growth,watermark')
  .split(',').map((s) => s.trim()).filter(Boolean));
for (const l of GUARD_LAYERS) if (!['uptime', 'growth', 'watermark'].includes(l))
  die('BROWSE_PURGE_RESTART_GUARD: unknown layer "' + l + '" (uptime, growth, watermark)');

// DOMAINS THE SWEEP REFUSES TO ARM WITHOUT. Name the sessions you could least afford to lose (your mail
// provider, say). Most matter only when no tab is ever kept open on them: such a domain is a purge candidate
// on every single sweep, so a line deleted from the whitelist by mistake would cost it at the first armed
// sweep. A domain named here and missing from the whitelist is a hard refusal to arm, not a warning.
const WHITELIST_INVARIANTS = String(process.env.BROWSE_PURGE_REQUIRE || '').split(',')
  .map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---- flags -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = { arm: false, dryRun: false, graceMinutes: GRACE_MINUTES_DEFAULT, cookiesOnly: false,
                noLock: false, quiet: false, help: false,
                hold: null, dropHold: null, listHolds: false, holdMinutes: HOLD_MINUTES_DEFAULT,
                showWhitelist: false, ignoreRestartGuard: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => { const v = argv[++i]; if (v === undefined) die('flag ' + a + ' needs a value'); return v; };
  if (a === '--arm') flags.arm = true;
  else if (a === '--dry-run') flags.dryRun = true;
  else if (a === '--grace-minutes') flags.graceMinutes = Number(val());
  else if (a === '--cookies-only') flags.cookiesOnly = true;
  else if (a === '--no-lock') flags.noLock = true;
  else if (a === '--quiet') flags.quiet = true;
  else if (a === '--hold') flags.hold = val();
  else if (a === '--drop-hold') flags.dropHold = val();
  else if (a === '--list-holds') flags.listHolds = true;
  else if (a === '--hold-minutes') flags.holdMinutes = Number(val());
  else if (a === '--show-whitelist') flags.showWhitelist = true;
  else if (a === '--ignore-restart-guard') flags.ignoreRestartGuard = true;
  else if (a === '-h' || a === '--help') flags.help = true;
  else die('unknown flag ' + a + ' (try --help)');
}
function die(msg) { process.stderr.write('ERR browse-cookie-auto-delete: ' + msg + '\n'); process.exit(2); }
if (flags.help) {
  process.stdout.write([
    'browse-cookie-auto-delete.js - whitelisted cookie auto-delete over CDP. DRY RUN BY DEFAULT.',
    '',
    '  --arm            actually delete. Without it the sweep only reports what it WOULD delete.',
    '  --dry-run        explicit form of the default (refused together with --arm).',
    '  --grace-minutes M  MINUTES since a tab was last open on a domain before its cookies are purged',
    '                   (default ' + GRACE_MINUTES_DEFAULT + ', minimum ' + GRACE_MINUTES_MIN + ').',
    '                   A domain never yet seen with a tab open starts its clock at first observation,',
    '                   so third-party cookies are aged out rather than purged on the first sweep.',
    '  --cookies-only   leave localStorage / IndexedDB / service workers alone; purge cookies only.',
    '  --no-lock        skip the flock re-exec. For a test against a scratch browser ONLY.',
    '  --quiet          no stdout JSON line (the log file is still written).',
    '  --ignore-restart-guard   sweep even inside the browser-restart window. Diagnostics only.',
    '',
    'The hold list - temporary protection, expiring on wall-clock time. No sweep is run by these:',
    '  --hold a.com,b.com       protect these registrable domains for --hold-minutes (default '
      + HOLD_MINUTES_DEFAULT + ').',
    '  --hold-minutes N         how long a --hold lasts. Extends an existing hold, never shortens it.',
    '  --drop-hold a.com        release a hold early.',
    '  --list-holds             what is held right now, and until when.',
    '',
    'PERMANENT protection is the whitelist file (' + WHITELIST_FILE + '),',
    'a plain list of registrable domains. Private addresses (LAN, loopback) are protected by rule.',
    '  --show-whitelist         every protected domain and the required-domain check. No browser, no lock,',
    '                           no sweep. Exits 3 if a required domain is missing.',
    '',
    'Env: BROWSE_CDP BROWSE_PURGE_WHITELIST BROWSE_PURGE_REQUIRE BROWSE_PURGE_STATE BROWSE_PURGE_HOLDS',
    '     BROWSE_PURGE_LOG BROWSE_LOCK BROWSE_PURGE_GRACE_MINUTES BROWSE_PURGE_HOLD_MINUTES',
    '     BROWSE_PURGE_UPTIME_MIN_S BROWSE_PURGE_UNIT BROWSE_PURGE_RESTART_GUARD',
    ''].join('\n'));
  process.exit(0);
}
if (flags.arm && flags.dryRun) die('--arm and --dry-run are opposites; pass one or neither');
if (!Number.isFinite(flags.graceMinutes) || flags.graceMinutes < GRACE_MINUTES_MIN)
  die('--grace-minutes must be a number >= ' + GRACE_MINUTES_MIN + ' - anything shorter can fire inside an '
    + 'OAuth bounce or a payment redirect, which is the flow this grace period exists to survive');
const GRACE_MS = flags.graceMinutes * 60000;
if (!Number.isInteger(flags.holdMinutes) || flags.holdMinutes < 1 || flags.holdMinutes > 60 * 24 * 30)
  die('--hold-minutes must be an integer between 1 and ' + 60 * 24 * 30 + ' (30 days). A hold is TEMPORARY '
    + 'protection - anything that should be permanent belongs in the whitelist file');
// The hold verbs manage a file and never touch the browser, so they take no lock, connect to no CDP endpoint
// and run no sweep. Keeping them out of the sweep path is also what keeps the hold file single-writer.
// --show-whitelist is in the same family: it reads a file and answers, and touches nothing.
const HOLD_MODE = flags.hold !== null || flags.dropHold !== null || flags.listHolds;
if (HOLD_MODE && flags.showWhitelist)
  die('--show-whitelist reports; the hold verbs edit. Run them separately');
const LIST_MODE = HOLD_MODE || flags.showWhitelist;
if (LIST_MODE && flags.arm) die('--arm is a sweep flag; the hold verbs and --show-whitelist run no sweep');

// ---- log ---------------------------------------------------------------------------------------------
const TS = (t) => new Date(t === undefined ? Date.now() : t).toISOString().replace(/\.\d+Z$/, 'Z');
// A DURATION A HUMAN READS AT A GLANCE - "6d3h", "45m". The log is what a human reads to decide whether to
// arm, and a sweep count or a raw millisecond figure says nothing they can act on.
function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return hrs + 'h' + (mins % 60 ? String(mins % 60) + 'm' : '');
  return Math.floor(hrs / 24) + 'd' + (hrs % 24 ? String(hrs % 24) + 'h' : '');
}
function logLine(msg) {
  try {
    if (fs.existsSync(LOG)) {                            // truncate-to-tail before appending
      const sz = fs.statSync(LOG).size;
      if (sz > LOG_MAX) {
        const fd = fs.openSync(LOG, 'r');
        const keep = Math.floor(LOG_MAX / 2);
        const buf = Buffer.alloc(keep);
        fs.readSync(fd, buf, 0, keep, sz - keep);
        fs.closeSync(fd);
        fs.writeFileSync(LOG + '.tmp', buf);
        fs.appendFileSync(LOG + '.tmp', TS() + '  --- log truncated to tail, ' + (sz - keep) + ' bytes discarded ---\n');
        fs.renameSync(LOG + '.tmp', LOG);
      }
    }
    fs.appendFileSync(LOG, TS() + '  ' + msg + '\n');
  } catch (e) {
    // A log that cannot be written must never FAIL the sweep - but it must never be silent either.
    process.stderr.write('WARN browse-cookie-auto-delete: cannot write ' + LOG + ' (' + (e && e.message ? e.message : e) + ')\n');
  }
}

// ---- the global browse lock, taken by re-execing under flock(1) --------------------------------------
// Node has no flock(2) binding, and testing the lock then acting on the result is a race. Re-exec instead:
// flock holds it for the child's whole life and releases it on exit however we exit. -E 75 makes "the lock
// was busy" distinguishable from anything the child itself could return.
if (!LIST_MODE && !flags.noLock && !process.env.BROWSE_PURGE_LOCK_HELD) {
  const r = spawnSync('flock', ['-n', '-E', String(LOCK_BUSY_EXIT), LOCK, process.execPath, __filename, ...argv],
    { stdio: 'inherit', env: { ...process.env, BROWSE_PURGE_LOCK_HELD: '1' } });
  if (r.error) die('cannot re-exec under flock (' + r.error.message + ')');
  if (r.status === LOCK_BUSY_EXIT) {
    // An agent call is in flight. Skipping costs only promptness: ages keep running whether or not anyone
    // reads them, so the purge simply happens later.
    logLine('skip  the browse lock is held by another call - sweep not run, nothing deleted');
    if (!flags.quiet) process.stdout.write(JSON.stringify({ ok: true, skipped: 'lock-held' }) + '\n');
    process.exit(0);
  }
  process.exit(r.status === null ? 1 : r.status);
}

// ---- eTLD+1 ------------------------------------------------------------------------------------------
// A self-contained public-suffix table, so the tool needs no package beyond `ws`. IT IS DELIBERATELY
// ICANN-ONLY AND DELIBERATELY INCOMPLETE, and the direction of the error is the whole argument: a MISSING
// suffix makes registrableDomain() return something SHORTER, which groups more hosts together -
// over-protective on the whitelist side and coarser on the purge side, both safe. A suffix that is too LONG
// is the dangerous direction, since it would split accounts.google.com from mail.google.com, so the PRIVATE
// section of the real list (github.io, blogspot.com, s3.amazonaws.com...) is intentionally absent.
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.jp', 'ne.jp', 'or.jp', 'go.jp', 'ac.jp', 'ad.jp', 'lg.jp',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
  'com.sg', 'com.my', 'com.tw', 'com.ph', 'com.vn', 'co.th', 'co.id', 'co.kr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.uy', 'com.ve', 'cl.cl',
  'co.za', 'org.za', 'gov.za', 'co.ke', 'com.ng', 'com.eg',
  'com.tr', 'gov.tr', 'com.sa', 'com.kw', 'co.il', 'org.il', 'ac.il', 'gov.il',
  'com.ua', 'com.ru', 'com.pl', 'com.es', 'com.pt', 'com.gr', 'com.cy',
  'gc.ca', 'qc.ca', 'on.ca',
]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
// Returns the key everything in this tool is grouped by. IP literals and single-label hosts (localhost, an
// intranet name) have no public suffix and are their own key, which keeps a bare hostname from collapsing
// into nothing.
function registrableDomain(host) {
  if (!host) return null;
  let h = String(host).trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('.')) h = h.slice(1);                 // cookie domains carry a leading dot
  if (h.startsWith('[') || h.includes(':')) return h;    // IPv6 literal
  if (IPV4.test(h)) return h;
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 1) return h || null;
  const last2 = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_LABEL_SUFFIXES.has(last2)) return parts.slice(-3).join('.');
  return last2;
}
const domainOfUrl = (u) => { try { return registrableDomain(new URL(u).hostname); } catch (_) { return null; } };

// ---- the private-address whitelist RULE ----------------------------------------------------------------
// A RULE and not a list: a home or office network gains and loses hosts constantly (router admin pages,
// hypervisor consoles, a NAS), and a rule covers every one of them with nothing to hand-maintain. Over-inclusive
// on purpose, in the direction this whole tool leans: there is no third party on the far end of an RFC1918
// address to leak a stale cookie to. NOTE THE eTLD+1 INTERACTION: an IP has no public suffix, so
// registrableDomain() returns the literal unchanged and each address is its own key. Never let the two-label
// fallback near one - "10.0.0.5" would collapse to "0.5", which matches nothing.
const octets = (h) => { const p = h.split('.'); return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255) ? p.map(Number) : null; };
function isPrivateAddress(host) {
  if (!host) return false;
  const h = String(host).trim().toLowerCase().replace(/^\.|\.$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '[::1]') return true;                   // IPv6 loopback, the one IPv6 literal worth naming
  const o = octets(h);
  if (!o) return false;
  if (o[0] === 10) return true;                                    // 10.0.0.0/8
  if (o[0] === 127) return true;                                   // 127.0.0.0/8 loopback
  if (o[0] === 192 && o[1] === 168) return true;                   // 192.168.0.0/16
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;       // 172.16.0.0/12
  return false;
}

// ---- CDP transport -----------------------------------------------------------------------------------
// The same shape browse.js uses: one raw websocket, no Playwright. connectOverCDP attaches to EVERY target
// and can wedge a shared browser on one heavy tab.
function cdpHttpJSON(p, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: CDP_URL.hostname, port: CDP_URL.port || 80, path: p, timeout: timeoutMs }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad JSON from ' + p)); } });
    });
    req.on('timeout', () => { req.destroy(new Error('CDP ' + p + ' timed out')); });
    req.on('error', reject);
  });
}
class CDPClient {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    const failAll = (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const { reject, timer } of this.pending.values()) { if (timer) clearTimeout(timer); try { reject(e); } catch (_) {} }
      this.pending.clear();
    };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id === undefined || !this.pending.has(m.id)) return;
      const { resolve, reject, timer } = this.pending.get(m.id); this.pending.delete(m.id);
      if (timer) clearTimeout(timer);
      if (m.error) reject(new Error(m.error.message || JSON.stringify(m.error)));
      else resolve(m.result);
    });
    ws.on('close', () => failAll(new Error('CDP socket closed')));
    ws.on('error', (e) => failAll(e instanceof Error ? e : new Error(String(e))));
  }
  // sessionId routes the call to an attached target instead of the browser. It is not optional decoration:
  // the deletion calls answer "Internal error" without it, and a build that omitted it reported cookies
  // purged while deleting none.
  send(method, params = {}, timeoutMs = 30000, sessionId = null) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP ' + method + ' timed out')); }
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }
  close() { try { this.ws.removeAllListeners(); this.ws.close(); } catch (_) {} }
}
async function connectBrowser() {
  const v = await cdpHttpJSON('/json/version');
  if (!v || !v.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl from CDP ' + CDP);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl, { handshakeTimeout: 30000, maxPayload: 64 * 1024 * 1024 });
    const onErr = (e) => { try { ws.terminate(); } catch (_) {} reject(e); };
    ws.once('open', () => { ws.removeListener('error', onErr); resolve(new CDPClient(ws)); });
    ws.once('error', onErr);
  });
}

// ---- the whitelist ---------------------------------------------------------------------------------------
// ONE FILE of domains plus one RULE (isPrivateAddress above). It is deliberately separate from the `browse
// login` recipe file: enrolling a site for `login` says the agent can sign into it, not that its cookies are
// worth keeping.
// File shape: { "domains": ["example.com", ...] }, matched at the registrable domain. Why a domain is listed
// belongs in your own notes or version control, not in the file.
// IT FAILS LOUD AND STOPS THE SWEEP. An unreadable or malformed whitelist is the one condition under which
// this tool must not run at all: every domain on it would read as unprotected. A refused sweep deletes nothing.
function loadWhitelistFile() {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8')); }
  catch (e) {
    const msg = 'cannot read the whitelist ' + WHITELIST_FILE + ' (' + (e.message || e) + ') - refusing to run: '
      + 'every protected domain would read as unprotected';
    logLine('ERROR  ' + msg);
    die(msg);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.domains)) {
    const msg = WHITELIST_FILE + ' must be an object with a "domains" array of registrable domains';
    logLine('ERROR  ' + msg);
    die(msg);
  }
  // Keyed by registrable domain, so a subdomain written into the file is normalized to the same key the sweep
  // groups cookies by rather than silently protecting nothing.
  const map = new Map();
  for (const raw of doc.domains) {
    const d = registrableDomain(raw);
    if (!d) { logLine('WARN  the whitelist entry "' + raw + '" is not a domain and protects nothing'); continue; }
    map.set(d, new Set(['whitelist']));
  }
  return map;
}

// ---- the hold list - temporary protection with a wall-clock expiry -------------------------------------
// Cookie AutoDelete's greylist, which it cleared at browser restart. A browser that runs for weeks makes the
// restart boundary meaningless, so the expiry is wall-clock instead. Two holes it closes:
//   * A HAND LOGIN. Signing in by hand adds nothing to the whitelist, so the site is protected by nothing but
//     its own open tab, and closing that tab starts the clock on it.
//   * A THIRD-PARTY AUTH ORIGIN that only exists at runtime - an SSO host, an identity provider. Cookie
//     AutoDelete never solved this and told users to whitelist the auth origin by hand (its issue #1438).
//     This list is populated by `browse login` itself, so the chain protects itself.
// File shape: { version: 1, holds: { "<registrable domain>": { "until": ISO, "why": "..." } } }.
// EXPIRED ENTRIES ARE DROPPED ON READ, so an expired hold can never protect anything even if the file is
// never rewritten, and the sweep never has to write this file at all.
function loadHolds(now = Date.now()) {
  const live = new Map();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(HOLDS, 'utf8')); }
  catch (e) {
    // NO FILE is the ordinary case and says nothing. A file that EXISTS and will not parse means every hold
    // in it has stopped protecting anything; it cannot fail the sweep, but it must never be silent.
    if (e && e.code !== 'ENOENT')
      logLine('WARN  the hold file ' + HOLDS + ' will not parse (' + (e.message || e) + ') - every hold in it '
        + 'is being ignored this sweep. Check it, or delete it to start clean.');
    return live;
  }
  const h = raw && typeof raw === 'object' && raw.holds && typeof raw.holds === 'object' ? raw.holds : {};
  for (const [d, e] of Object.entries(h)) {
    const until = e && typeof e.until === 'string' ? Date.parse(e.until) : NaN;
    // An unparseable expiry is treated as EXPIRED, not as forever. A hold that never dies is a whitelist
    // entry nobody chose, and this file is written by tooling rather than reviewed by a human.
    if (!Number.isFinite(until) || until <= now) continue;
    live.set(d, { until: new Date(until).toISOString(), why: typeof e.why === 'string' ? e.why : '' });
  }
  return live;
}
// The ONLY writer. Temp file plus rename, so a write killed midway never leaves a truncated file.
function writeHolds(live) {
  const holds = {};
  for (const [d, e] of [...live.entries()].sort((a, b) => a[0].localeCompare(b[0]))) holds[d] = e;
  const tmp = HOLDS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, holds }, null, 1) + '\n');
  fs.renameSync(tmp, HOLDS);
}
const parseDomainList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => registrableDomain(x.replace(/^https?:\/\//i, '').split('/')[0])).filter(Boolean)
  .filter((x, i, a) => a.indexOf(x) === i);   // a login flow hands in the same domain repeatedly
// EXTENDS, NEVER SHORTENS. Two overlapping login flows must not have the shorter one cut the longer one's
// protection out from under it.
function addHolds(domains, minutes, why) {
  const now = Date.now();
  const live = loadHolds(now);
  const until = new Date(now + minutes * 60000).toISOString();
  const applied = [];
  for (const d of domains) {
    const prev = live.get(d);
    if (prev && Date.parse(prev.until) >= Date.parse(until)) { applied.push({ domain: d, until: prev.until, extended: false }); continue; }
    live.set(d, { until, why: why || (prev && prev.why) || 'manual' });
    applied.push({ domain: d, until, extended: true });
  }
  writeHolds(live);
  return applied;
}
function dropHolds(domains) {
  const live = loadHolds();
  const dropped = domains.filter((d) => live.delete(d));
  writeHolds(live);
  return dropped;
}

// THE EFFECTIVE WHITELIST CHECK - the one place that answers "is this domain protected, and by what". Every
// caller goes through it, the required-domain check included, so a domain can never be protected by one code
// path and purged by another. Returns the reason string, or null.
// THE ORDER IS PERMANENCE, LONGEST FIRST - the file, then the rule, then a hold. PASS NULL FOR THE HOLDS to
// ask the narrower question the required-domain check asks: is the file alone protecting this. A hold must
// never answer for a required domain, or the sweep would arm today and lose that session when the hold expired.
function whitelistReason(map, holds, d) {
  if (map.has(d)) return [...map.get(d)].join(',');
  if (isPrivateAddress(d)) return 'rule:private-address';
  const h = holds && holds.get(d);
  if (h) return 'hold:until ' + h.until + (h.why ? ' (' + h.why + ')' : '');
  return null;
}

// ---- state -------------------------------------------------------------------------------------------
// ONE TIMESTAMP PER DOMAIN, `lastSeenOpen`: the most recent sweep at which a tab, an iframe or a worker was
// open on that domain. The purge test is `now - lastSeenOpen >= the grace duration`.
// A DOMAIN NEVER SEEN OPEN IS SEEDED AT FIRST OBSERVATION, NOT READ AS INFINITELY OLD. Most of the jar is
// third-party cookies no tab was ever open on, plus everything set before this tool was installed. Treating
// "unknown" as "abandoned forever" would purge all of it on the first armed sweep, on the strength of a record
// the tool never had. Seeding costs at most one grace period of delay on a domain that really was abandoned.
// THE FILE LIVES IN /run (tmpfs). Losing it re-seeds every domain as just-seen, which DELAYS every purge by a
// grace period - the cheap failure. A machine rebooting more often than once per grace period would never
// purge anything, which the log shows the same day.
const STATE_VERSION = 2;
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s && typeof s === 'object' && s.version === STATE_VERSION && s.seen && typeof s.seen === 'object') return s;
  } catch (_) {}
  return { version: STATE_VERSION, sweeps: 0, seen: {} };
}
function saveState(s) {
  // Temp file plus rename: a truncated state file would re-seed every domain and silently re-grant the grace.
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1) + '\n');
  fs.renameSync(tmp, STATE);
}

// ---- the browser-restart / session-restore guard ---------------------------------------------------------
// While Chrome is restoring a session no tab has reopened yet, so every domain looks abandoned, and an armed
// sweep landing in that window would take out everything protected only by an open tab.
// The timestamps cover most of that window - a domain whose tab was open until the restart reads as minutes
// old - but not all of it: the last sweep can be a full schedule interval behind the restart, so with a short
// grace a domain whose tab was open the whole time can be at or past its threshold before the restore starts.
// That case is the guard's alone. Do not thin these layers on the argument that the grace period covers them.
// Cookie AutoDelete's own guard sniffs for a Firefox-only `about:sessionrestore` tab and has no Chrome
// equivalent, so none of it is copied here.
// THREE INDEPENDENT SIGNALS, ANY ONE OF WHICH HOLDS THE SWEEP. Each is cheap and each fails differently: the
// uptime read needs /proc or systemd; the growth and watermark checks need only the target list but are blind
// to the very first sweep after a restart if the state file was lost with it.
// READ THE BROWSER'S START TIME FROM THE ctime OF /proc/<pid>/, NOT FROM /proc/<pid>/stat field 22. Inside a
// container field 22 is keyed to the HOST's boot while /proc/uptime may be virtualized to the container's, so
// the subtraction goes negative, clamps to zero, and every sweep is held forever. The directory ctime is a
// wall-clock instant and needs no second source to subtract from.
function procStartSeconds(pid) {
  try {
    const st = fs.statSync('/proc/' + pid);
    const age = (Date.now() - st.ctimeMs) / 1000;
    return age >= 0 ? age : null;
  } catch (_) { return null; }
}
// THE BROWSER WE ARE TALKING TO IS THE AUTHORITY, not the unit name: asking systemd first would report the
// live browser's uptime even when BROWSE_CDP points at a scratch one. The unit is only the fallback.
async function browserUptimeSeconds(browser) {
  try {
    const { processInfo } = await browser.send('SystemInfo.getProcessInfo', {}, 8000);
    const b = (processInfo || []).find((p) => p.type === 'browser');
    if (b && b.id) { const s = procStartSeconds(b.id); if (s !== null) return { seconds: s, via: 'proc:' + b.id }; }
  } catch (_) { /* SystemInfo is not enabled on every build - fall through */ }
  // The unit's start instant as WALL CLOCK - never the Monotonic form, for the reason above. date(1) parses
  // systemd's "Fri 2026-01-02 12:14:45 UTC" form, which Date.parse does not accept.
  try {
    const r = spawnSync('sh', ['-c', 'date -d "$(systemctl show -p ActiveEnterTimestamp --value '
      + UNIT + ')" +%s'], { encoding: 'utf8' });
    const epoch = Number(String(r.stdout || '').trim());
    if (Number.isFinite(epoch) && epoch > 0) {
      const age = Date.now() / 1000 - epoch;
      if (age >= 0) return { seconds: age, via: 'systemd:' + UNIT };
    }
  } catch (_) {}
  // UNKNOWN degrades rather than failing: blocking forever would let a /proc breakage disable the tool, and
  // sweeping regardless is what the other two signals are for.
  return { seconds: null, via: 'unavailable' };
}
function restartGuard(uptime, targetCount, openDomainCount, state) {
  if (GUARD_LAYERS.has('uptime')) {
    if (uptime.seconds !== null && uptime.seconds < UPTIME_MIN_S)
      return 'browser up only ' + Math.round(uptime.seconds) + 's (< ' + UPTIME_MIN_S + 's, via ' + uptime.via + ')';
    if (uptime.seconds === null)
      logLine('WARN  browser uptime unreadable (' + uptime.via + ') - the restart guard is running on its '
        + 'target-count and open-domain signals only');
  }
  // A TARGET LIST REPOPULATING FROM ALMOST NOTHING IS A RESTORE IN PROGRESS. Any growth at all is NOT: several
  // agents open and close tabs continuously, and a rule that held on any growth would suppress the purge
  // indefinitely while the log showed nothing but HOLD lines, which reads as working. So the growth has to be
  // restore-SHAPED, in proportion and in absolute size both - see GROWTH_RATIO_MIN.
  if (GUARD_LAYERS.has('growth') && Number.isInteger(state.lastTargets)) {
    const grew = targetCount - state.lastTargets;
    if (grew >= GROWTH_ABS_MIN && targetCount >= state.lastTargets * GROWTH_RATIO_MIN)
      return 'target count grew ' + state.lastTargets + ' -> ' + targetCount + ' since the previous sweep, '
        + 'which is restore-shaped (+' + grew
        + (state.lastTargets ? ' and x' + (targetCount / state.lastTargets).toFixed(1) : ' from an empty list')
        + ', against the +' + GROWTH_ABS_MIN + ' and x' + GROWTH_RATIO_MIN + ' a restore has to clear)';
  }
  if (!GUARD_LAYERS.has('watermark')) return null;
  // A COLLAPSE IN OPEN DOMAINS against a WINDOWED maximum. An ALL-TIME maximum would lock the sweep out
  // forever, since ad iframes and short-lived tabs make the count swing every sweep and it would only ever
  // ratchet up. A maximum over the last OPEN_DOMAIN_WINDOW sweeps decays instead, so a genuine mass tab-close
  // holds the sweep for at most that many sweeps and then the tool resumes by itself.
  const hist = Array.isArray(state.openDomainHistory) ? state.openDomainHistory.filter(Number.isInteger) : [];
  if (hist.length >= 2) {
    const peak = Math.max(...hist);
    if (peak >= 2 && openDomainCount * 2 < peak)
      return 'open domains collapsed to ' + openDomainCount + ' against a recent peak of ' + peak
        + ' over the last ' + hist.length + ' sweeps';
  }
  return null;
}

// ---- borrowing a page session ----------------------------------------------------------------------------
// The deletion calls need a session attached to a target (see the header). Borrowing an existing tab -
// attach, delete, detach, with no navigation, activation or close - costs a human watching the screen nothing,
// where opening our own tab would flicker on every armed sweep.
async function borrowStorageSession(browser, targets) {
  const pages = targets.filter((t) => t.type === 'page');
  // An inert tab first, then any other page. A wedged renderer cannot block these calls (they are served by
  // the browser process), but an idle tab is still the better neighbor to borrow.
  const ranked = [...pages.filter((t) => /^(about:blank|chrome:\/\/newtab)/.test(t.url || '')),
                  ...pages.filter((t) => !/^(about:blank|chrome:\/\/newtab)/.test(t.url || ''))];
  for (const t of ranked) {
    try {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, 10000);
      return { sessionId, borrowedFrom: t.targetId, created: null };
    } catch (_) { /* try the next tab */ }
  }
  // Nothing borrowable - open our own. We created it, so we are the one allowed to close it.
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }, 15000);
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true }, 10000);
  return { sessionId, borrowedFrom: null, created: targetId };
}
async function releaseStorageSession(browser, sess) {
  if (!sess) return;
  try { await browser.send('Target.detachFromTarget', { sessionId: sess.sessionId }, 10000); } catch (_) {}
  if (sess.created) { try { await browser.send('Target.closeTarget', { targetId: sess.created }, 10000); } catch (_) {} }
}

// ---- the purge -------------------------------------------------------------------------------------------
// Cookies go one at a time, by name + domain + path, the only form measured to clear a domain completely (see
// the header). partitionKey is passed through when the cookie carries one - a partitioned (CHIPS) cookie is
// not matched by a delete that omits it - and the call is retried without it on a Chrome that rejects the
// parameter, so an unsupported field degrades instead of failing the sweep.
const STORAGE_BUCKETS = 'local_storage,indexeddb,service_workers,cache_storage,file_systems';
async function purgeDomain(browser, sessionId, domain, cookies, cookiesOnly) {
  let deleted = 0, failed = 0;
  for (const c of cookies) {
    const base = { name: c.name, domain: c.domain, path: c.path };
    try {
      if (c.partitionKey !== undefined) {
        try { await browser.send('Network.deleteCookies', { ...base, partitionKey: c.partitionKey }, 15000, sessionId); }
        catch (_) { await browser.send('Network.deleteCookies', base, 15000, sessionId); }
      } else {
        await browser.send('Network.deleteCookies', base, 15000, sessionId);
      }
      deleted++;
    } catch (_) { failed++; }
  }
  let origins = 0;
  if (!cookiesOnly) {
    // Default-port origins only - a cookie records no port, and clearing is port-exact. See the header.
    const hosts = new Set([domain]);
    for (const c of cookies) { const h = String(c.domain || '').replace(/^\./, ''); if (h) hosts.add(h); }
    // THE www. VARIANT: a cookie set on `.example.com` names no host at all, so a site whose localStorage
    // lives on `www.example.com` would be missed by the set above. Only `www.` is added: a leading-dot string
    // is not a valid origin.
    for (const h of [...hosts]) if (!/^www\./.test(h) && !IPV4.test(h) && h.includes('.')) hosts.add('www.' + h);
    for (const h of hosts) for (const scheme of ['https://', 'http://']) {
      try { await browser.send('Storage.clearDataForOrigin', { origin: scheme + h, storageTypes: STORAGE_BUCKETS }, 15000, sessionId); origins++; }
      catch (_) { /* an origin the browser has never seen is not an error worth failing a sweep over */ }
    }
  }
  return { deleted, failed, origins };
}

// ---- the sweep -----------------------------------------------------------------------------------------
async function main() {
  const whitelist = loadWhitelistFile();
  const holds = loadHolds();
  const isKept = (d) => whitelistReason(whitelist, holds, d) !== null;
  // THE REQUIRED DOMAINS ARE CHECKED AGAINST THE FILE ALONE - note the null where the hold list would go. A
  // one-hour hold that happened to name one would let the sweep arm and expire an hour later with the
  // whitelist line still missing.
  const missing = WHITELIST_INVARIANTS.filter((d) => whitelistReason(whitelist, null, d) === null);
  if (missing.length) {
    // Refuse to ARM, but still report: a dry run that says a required domain fell off the whitelist is exactly
    // the warning worth having, and a hard exit would hide it.
    logLine('REQUIRED MISSING  ' + missing.join(',') + ' not in the effective whitelist - refusing to arm');
    if (flags.arm) die('required domain missing from the whitelist: ' + missing.join(', ') + '. Arming is refused '
      + '(BROWSE_PURGE_REQUIRE). Put it back in ' + WHITELIST_FILE + ' and re-run.');
  }
  const armed = flags.arm && !missing.length;

  const browser = await connectBrowser();
  let out;
  try {
    const { targetInfos } = await browser.send('Target.getTargets');
    // Every target with a url counts as "open", not just type page: an iframe, a worker or a background page
    // on a domain means that domain is in use. Over-inclusive on purpose - see the header.
    const openDomains = new Map();
    for (const t of targetInfos) {
      if (!/^https?:\/\//i.test(t.url || '')) continue;      // chrome://, chrome-extension:// and devtools:// hold no cookies
      const d = domainOfUrl(t.url);
      if (!d) continue;
      openDomains.set(d, (openDomains.get(d) || 0) + 1);
    }

    const { cookies } = await browser.send('Storage.getCookies');
    const byDomain = new Map();
    for (const c of cookies) {
      const d = registrableDomain(c.domain);
      if (!d) continue;
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d).push(c);
    }

    const state = loadState();
    state.sweeps = (state.sweeps || 0) + 1;
    const seen = state.seen || (state.seen = {});
    const now = Date.now();                                  // one `now` for the whole sweep

    // ---- THE RESTART GUARD, evaluated before anything can be purged ------------------------------------
    const uptime = await browserUptimeSeconds(browser);
    const guardReason = restartGuard(uptime, targetInfos.length, openDomains.size, state);
    // HELD IS NOT SKIPPED. The sweep still reads the jar, still logs, and still REFRESHES the timestamp of
    // every domain whose tab is back, which moves a domain AWAY from deletion. What it refuses to do is purge.
    const held = guardReason !== null && !flags.ignoreRestartGuard;
    if (guardReason && flags.ignoreRestartGuard)
      logLine('WARN  restart guard OVERRIDDEN by --ignore-restart-guard: ' + guardReason);

    // EVERY OPEN DOMAIN IS REFRESHED FIRST, whether or not the sweep is held and whether or not the domain
    // carries a cookie today, so a domain whose tab has been open all week reads as age zero the instant that
    // tab closes.
    for (const d of openDomains.keys()) seen[d] = { lastSeenOpen: TS(now), why: 'open-tab' };

    const candidates = [], pending = [], doomed = [], saved = [];
    for (const [d, cs] of byDomain) {
      const keptBy = whitelistReason(whitelist, holds, d);
      if (keptBy || openDomains.has(d)) {
        // The domains the WHITELIST alone is holding back - protected, with cookies, and no open tab. This
        // is the negative control running in production: "saved-by-whitelist" going to zero means the
        // protection has stopped working.
        if (!openDomains.has(d)) {
          saved.push({ domain: d, cookies: cs.length, why: keptBy });
          // PROTECTION REFRESHES THE CLOCK TOO. It matters most for a HOLD: without this, a hold would
          // suspend the purge for its hour and then hand back a domain still carrying its old age, destroying
          // the session the login had just created. This is also what lets the grace floor sit below the
          // hold window - see GRACE_MINUTES_MIN.
          seen[d] = { lastSeenOpen: TS(now), why: 'protected' };
        }
        continue;
      }
      candidates.push(d);
      // FIRST OBSERVATION SEEDS THE CLOCK - see the state section above.
      const rec = seen[d] || (seen[d] = { lastSeenOpen: TS(now), why: 'first-observation' });
      // An unparseable timestamp reads as `now`, i.e. it grants a fresh grace period rather than an instant purge.
      const ageMs = Math.max(0, now - (Date.parse(rec.lastSeenOpen) || now));
      const x = { domain: d, cookies: cs, ageMs, lastSeenOpen: rec.lastSeenOpen, why: rec.why };
      (!held && ageMs >= GRACE_MS ? doomed : pending).push(x);
    }
    // Forget a domain with neither cookies nor a tab. Should it come back it is seeded afresh, which delays
    // its purge - the safe direction, and what keeps this file bounded.
    for (const d of Object.keys(seen)) if (!byDomain.has(d) && !openDomains.has(d)) delete seen[d];
    // The two restart signals are recorded on EVERY sweep, held or not: a hold that never updated its own
    // inputs could never clear itself.
    state.lastTargets = targetInfos.length;
    state.openDomainHistory = [...(Array.isArray(state.openDomainHistory) ? state.openDomainHistory : []),
                               openDomains.size].slice(-OPEN_DOMAIN_WINDOW);

    const purged = [];
    if (armed && doomed.length) {
      const sess = await borrowStorageSession(browser, targetInfos);
      try {
        for (const x of doomed)
          purged.push({ domain: x.domain, cookies: x.cookies.length, ageMs: x.ageMs,
                        lastSeenOpen: x.lastSeenOpen, why: x.why,
                        ...(await purgeDomain(browser, sess.sessionId, x.domain, x.cookies, flags.cookiesOnly)) });
        // VERIFY THE PROPERTY, NOT THE CALL. Re-read the jar and count what is left on each domain just purged:
        // a delete that silently matched nothing (a partitioned cookie, a domain form we got wrong) would
        // otherwise be logged as a success.
        const after = (await browser.send('Storage.getCookies')).cookies;
        for (const p of purged) p.survivors = after.filter((c) => registrableDomain(c.domain) === p.domain).length;
      } finally { await releaseStorageSession(browser, sess); }
      // Drop only what really went. A domain with survivors KEEPS its timestamp, so the next sweep tries again
      // rather than starting a fresh grace period on a jar we failed to empty.
      for (const p of purged) if (!p.survivors) delete seen[p.domain];
    }
    saveState(state);

    // THE LOG: one summary line per sweep, one line per domain that was or would be purged. Domain and cookie
    // COUNT only - never a cookie name, never a value. Every line carries the domain's age against the grace.
    const storageNote = flags.cookiesOnly ? '' : ' +storage';
    const ageNote = (x) => '  age=' + fmtAge(x.ageMs) + '/' + fmtAge(GRACE_MS)
      + ' last-open=' + x.lastSeenOpen + '(' + x.why + ')';
    if (held) logLine('HOLD  restart guard: ' + guardReason + ' - nothing deleted, '
      + candidates.length + ' candidate domain(s) left where they were');
    if (armed) for (const p of purged)
      logLine((p.survivors ? 'INCOMPLETE' : 'DELETE') + '  ' + p.domain + '  cookies=' + p.cookies
        + ' deleted=' + p.deleted + (p.survivors ? ' SURVIVORS=' + p.survivors : '') + storageNote + ageNote(p));
    else for (const x of doomed)
      logLine('WOULD-DELETE  ' + x.domain + '  cookies=' + x.cookies.length + storageNote + ageNote(x));
    const oldestWaiting = pending.reduce((m, x) => Math.max(m, x.ageMs), -1);
    logLine('sweep ' + (held ? 'HELD   ' : armed ? 'ARMED  ' : 'dry-run') + '  targets=' + targetInfos.length
      + ' open-domains=' + openDomains.size + ' cookie-domains=' + byDomain.size
      + ' whitelisted=' + [...byDomain.keys()].filter(isKept).length
      + ' candidates=' + candidates.length + ' grace=' + fmtAge(GRACE_MS)
      + ' waiting-out-grace=' + pending.length
      + (oldestWaiting >= 0 ? ' oldest-waiting=' + fmtAge(oldestWaiting) : '')
      + ' ' + (armed ? 'purged=' : 'would-purge=') + doomed.length
      + '  saved-by-whitelist=' + saved.length + ' [' + saved.map((s) => s.domain).join(' ') + ']'
      + (holds.size ? '  holds=' + holds.size : ''));

    // Ages go out in MINUTES (a number an agent can compare with the setting) and in the human form.
    const ageFields = (x) => ({ ageMinutes: Math.round(x.ageMs / 600) / 100, age: fmtAge(x.ageMs),
                                lastSeenOpen: x.lastSeenOpen, seededBy: x.why });
    out = {
      ok: true, mode: held ? 'held' : armed ? 'armed' : 'dry-run',
      graceMinutes: flags.graceMinutes, grace: fmtAge(GRACE_MS),
      ...(held ? { heldBy: guardReason } : {}),
      browserUptimeS: uptime.seconds === null ? null : Math.round(uptime.seconds), uptimeVia: uptime.via,
      holds: [...holds.entries()].map(([domain, h]) => ({ domain, until: h.until, why: h.why })),
      sweep: state.sweeps, whitelistDomains: whitelist.size, cookieDomains: byDomain.size,
      whitelist: [...whitelist.keys()].sort(),
      // The rule protects an unbounded set, so it is named rather than listed.
      whitelistRules: ['private-address: RFC1918 (192.168/16, 10/8, 172.16/12), 127/8, localhost, ::1'],
      savedByWhitelist: saved,
      openDomains: [...openDomains.keys()].sort(),
      waitingOutGrace: pending.map((x) => ({ domain: x.domain, cookies: x.cookies.length, ...ageFields(x) })),
      [armed ? 'purged' : 'wouldPurge']: armed
        ? purged.map(({ ageMs, why, lastSeenOpen, ...p }) => ({ ...p, ...ageFields({ ageMs, why, lastSeenOpen }) }))
        : doomed.map((x) => ({ domain: x.domain, cookies: x.cookies.length, ...ageFields(x) })),
      ...(missing.length ? { requiredMissing: missing } : {}),
    };
  } finally { browser.close(); }
  if (!flags.quiet) process.stdout.write(JSON.stringify(out) + '\n');
}

// ---- the hold verbs ------------------------------------------------------------------------------------
// NO BROWSER, NO LOCK, NO SWEEP - these only edit a small JSON file, which is why `browse login` can call them
// at the end of a login it just finished. They exit before main() ever runs.
function holdVerbs() {
  if (flags.listHolds) {
    const live = loadHolds();
    process.stdout.write(JSON.stringify({ ok: true, holds: [...live.entries()]
      .map(([domain, h]) => ({ domain, until: h.until, why: h.why })) }) + '\n');
    return true;
  }
  if (flags.dropHold !== null) {
    const domains = parseDomainList(flags.dropHold);
    if (!domains.length) die('--drop-hold needs at least one domain');
    const dropped = dropHolds(domains);
    logLine('hold-drop  ' + (dropped.join(',') || '(none matched)'));
    if (!flags.quiet) process.stdout.write(JSON.stringify({ ok: true, dropped, asked: domains }) + '\n');
    return true;
  }
  if (flags.hold !== null) {
    const domains = parseDomainList(flags.hold);
    if (!domains.length) die('--hold needs at least one domain');
    const applied = addHolds(domains, flags.holdMinutes, process.env.BROWSE_PURGE_HOLD_WHY || 'manual');
    logLine('hold  ' + domains.join(',') + '  minutes=' + flags.holdMinutes
      + '  why=' + (process.env.BROWSE_PURGE_HOLD_WHY || 'manual'));
    if (!flags.quiet) process.stdout.write(JSON.stringify({ ok: true, held: applied, minutes: flags.holdMinutes }) + '\n');
    return true;
  }
  return false;
}

// ---- --show-whitelist ------------------------------------------------------------------------------------
// NO BROWSER, NO LOCK, NO SWEEP. "What does this machine protect right now", asked of the machine: the honest
// answer to "did my edit take", since a domain typed as a url or into the wrong key would load and protect
// nothing. EXITS NON-ZERO when a required domain is missing, so no script reads a failed check as OK.
function showWhitelistVerb() {
  if (!flags.showWhitelist) return false;
  const map = loadWhitelistFile();
  const domains = [...map.keys()].sort();
  const required = WHITELIST_INVARIANTS.map((domain) => {
    const by = whitelistReason(map, null, domain);           // the file alone, as the sweep asks it
    return { domain, protected: by !== null, by };
  });
  const ok = required.every((i) => i.protected);
  process.stdout.write(JSON.stringify({ ok, file: WHITELIST_FILE, count: domains.length, domains,
    rules: ['private-address: RFC1918 (192.168/16, 10/8, 172.16/12), 127/8, localhost, ::1'],
    required }) + '\n');
  if (!ok) {
    process.stderr.write('ERR browse-cookie-auto-delete: a required domain is NOT protected - '
      + required.filter((i) => !i.protected).map((i) => i.domain).join(', ')
      + ' - so the sweep will refuse to arm\n');
    process.exit(3);
  }
  return true;
}

if (!holdVerbs() && !showWhitelistVerb())
  main().catch((e) => { logLine('ERROR  ' + (e && e.message ? e.message : String(e))); die(e && e.message ? e.message : String(e)); });
