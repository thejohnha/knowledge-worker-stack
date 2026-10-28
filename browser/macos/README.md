# browse on a Mac's own Chromium

`browse` drives a Chromium on your Mac, on its normal profile, with every login it holds. No second machine, no VNC: sign in to a site once in your own browser and the agent can use it. The trade is exposure (read "Know the exposure" before turning it on) and a few verbs that need Linux.

- Chromium, never Google Chrome: Chrome refuses the remote-control port on its normal profile ("DevTools remote debugging requires a non-default data directory"); Chromium opens it.
- Never takes your focus: on macOS browse.js refuses `Target.activateTarget` and `Page.bringToFront`, opens every agent tab in its own background window, and never sends an OS keystroke. You see those windows only when you switch to Chromium. Activating a tab yourself brings Chromium in front at once.
- Own window, not a background tab, for speed: a background tab is "hidden", so Chromium throttles its timers and skips animation frames, and many sites stall. The front tab of a window behind other apps runs at full speed, screen locked included.

## Know the exposure before turning it on
- While the port is open, ANY program on that Mac can drive Chromium with every login in it, and can open `file://` pages to read any file you can read, your SSH private keys included. That means programs running as you, programs under another macOS account on the same Mac, and possibly a container or VM that can reach the Mac's localhost: the port has no password and no check of who is calling.
- The port is bound to 127.0.0.1, which keeps the network out, but nothing on the Mac itself. NEVER forward port 9222 off the Mac (ssh -L/-R, a VM, a container, a proxy): that hands every login and every readable file to the far end.
- Want the agent's logins kept apart from yours? Use the [Linux setup](../linux/README.md) or, on this Mac, the [OrbStack setup](../orbstack/README.md).

## What each part does
- Chromium: started with `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`, which only takes effect when Chromium is not already running.
- `~/agent-browser/node`: the official Node.js build from nodejs.org. Links only macOS system libraries and stays off your PATH, so nothing else comes to rely on it.
- `~/agent-browser/browse.js`: the agent's remote control, unchanged; its Mac behavior keys on `process.platform`.
- `~/agent-browser/browse`: `browse-run-one-at-a-time-macos.sh`, renamed on install. One call at a time, 240s cap; state and captures under `~/agent-browser`.
- `~/agent-browser/browse-start-chromium-with-port-macos.sh`: starts Chromium with the port if it is not running. Leaves a Chromium running without the port alone, because restarting it would close your windows.

## Prerequisites
- macOS on Apple silicon. Intel Macs: use `darwin-x64` in step 2 (untested).
- A Chromium build installed as `/Applications/Chromium.app`: `brew install --cask ungoogled-chromium` installs one there, notarized and updated by `brew upgrade` (Homebrew's plain `chromium` cask was disabled in September 2026 for failing Apple's Gatekeeper check). It has no Google sync and no Widevine, neither of which browse uses.
- A copy of this repo, for `browser/browse.js` and the two scripts in this folder.

## 1. Know where you are
```bash
cd /path/to/knowledge-worker-stack/browser    # this repo's browser/ folder; every step below runs from here
```

## 2. Install Node.js
The nodejs.org build rather than Homebrew's node, which brings many libraries. Nothing updates it: re-run this block with a newer LTS from https://nodejs.org/dist/index.json.
```bash
V=v24.22.0; A=darwin-arm64
mkdir -p ~/agent-browser
T=$(mktemp -d)
curl -sfo "$T/n.tar.xz" https://nodejs.org/dist/$V/node-$V-$A.tar.xz
(cd "$T" && curl -sf https://nodejs.org/dist/$V/SHASUMS256.txt | grep " node-$V-$A.tar.xz$" | sed "s/node-$V-$A.tar.xz/n.tar.xz/" | shasum -a 256 -c)    # n.tar.xz: OK
tar -xf "$T/n.tar.xz" -C "$T"
install -m 755 "$T/node-$V-$A/bin/node" ~/agent-browser/node
PATH="$T/node-$V-$A/bin:$PATH" npm install --prefix ~/agent-browser --no-save --no-package-lock --no-audit --no-fund ws@8.21.3
rm -r "$T"
~/agent-browser/node -e 'console.log(process.version, require(process.env.HOME + "/agent-browser/node_modules/ws/package.json").version)'    # v24.22.0 8.21.3
codesign -dv ~/agent-browser/node 2>&1 | grep TeamIdentifier    # HX7739G8FX, the Node.js project
```
- `ws` is browse.js's only dependency. The tarball's npm is used once and deleted with it.

## 3. Install the toolset
```bash
install -m 644 browse.js ~/agent-browser/browse.js
install -m 755 macos/browse-run-one-at-a-time-macos.sh ~/agent-browser/browse
install -m 755 macos/browse-start-chromium-with-port-macos.sh ~/agent-browser/
~/agent-browser/node --check ~/agent-browser/browse.js && echo ok    # ok
mkdir -p ~/bin && ln -sf ~/agent-browser/browse ~/bin/browse
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc    # then open a new terminal
```

## 4. Start Chromium with the port
```bash
~/agent-browser/browse-start-chromium-with-port-macos.sh; echo "exit $?"    # 0: port answers
```
- Exit 1 with "running without the remote-control port": quit Chromium (Cmd+Q) and run it again. Chromium brings its windows back if "Continue where you left off" is set in its settings.
- Starting Chromium brings it to the front, so do this while nobody is typing.

## 5. Start it at login
Unquoted `EOF` on purpose: launchd cannot expand `$HOME`, so the shell writes your real path into the file now.
```bash
mkdir -p ~/agent-browser/state
cat > ~/Library/LaunchAgents/local.agent-browser.chromium-port.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>local.agent-browser.chromium-port</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/agent-browser/browse-start-chromium-with-port-macos.sh</string>
  </array>
  <key>StandardErrorPath</key>
  <string>$HOME/agent-browser/state/start-chromium.log</string>
</dict>
</plist>
EOF
plutil -lint ~/Library/LaunchAgents/local.agent-browser.chromium-port.plist    # OK
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.agent-browser.chromium-port.plist
launchctl kickstart gui/$(id -u)/local.agent-browser.chromium-port            # run it now, without logging out
```
- If macOS reopens Chromium at login ("Reopen windows when logging back in") before this runs, Chromium is up without the port and the script leaves it alone; quit Chromium and run step 4.

## 6. Test it
```bash
browse open-url https://example.com
browse get-text
browse screenshot test.png         # lands in ~/agent-browser/Downloads
browse list-tabs
```
- An agent tab opens as its own Chromium window, behind whatever is in front.
- Focus check, in a second terminal while you run the commands above; the app name must never turn to Chromium:
```bash
while :; do lsappinfo info -only name "$(lsappinfo front)"; sleep 0.5; done
```
- Each Claude Code session gets its own tab from its session id. Any other caller: set `BROWSE_SESSION=<name>` to keep one tab across calls; with no name each call gets a throwaway tab.
- Screenshots and PDFs land in `~/agent-browser/Downloads`. The `download` verb leaves Chromium's own download folder in force, normally `~/Downloads`.

## 7. Open a link for yourself without losing focus (optional)
`macOS_open_chromium_no_focus_steal.sh URL [URL...]` opens links in your Chromium for you to look at later, while you keep typing where you are. Chromium pulls itself to the front on every new tab even under `open -g`; the script puts the app you were in back in front at once.
```bash
install -m 755 macos/macOS_open_chromium_no_focus_steal.sh ~/bin/
```
- Another Chromium-family browser: `OPEN_NO_FOCUS_APP="Brave Browser"` in front of the command.
- The first run may ask to let your terminal control System Events; allow it.
- Chromium can flash in front for a split second.

## Remove it
```bash
launchctl bootout gui/$(id -u)/local.agent-browser.chromium-port
rm ~/Library/LaunchAgents/local.agent-browser.chromium-port.plist
rm -f ~/bin/browse ~/bin/macOS_open_chromium_no_focus_steal.sh
rm -r ~/agent-browser
```
- Then quit Chromium and start it from the Dock: no port.

## Known limits
- `save-page`: refuses. It needs an OS keystroke for the SingleFile extension. `print2pdf` and `screenshot` work.
- `dismiss-dialog`: the browser's own dialog command still runs; the last step, a Return keystroke, reports the tab still stuck instead.
- `native-browser-prompts-view|dismiss|choose` and the native-prompt half of `session-state`: answer `a11y:false`, "cannot see", never an empty all-clear. They need Linux's accessibility bus.
- `restart-browser`: shows its plan; `--yes` fails, because it would quit your Chromium.
- Cookie auto-delete (`browse-cookie-auto-delete.js`) does not run here: it needs `flock`, `/proc` and `/run`, which macOS lacks.
- Up only while the Mac is awake and you are logged in.

Tested on macOS 26 with Chromium 155: the version of `browse.js` this was packaged from passed its own self-test (not shipped) on this setup. Not tested: Intel Macs, and this packaged copy of `browse.js`, which was only syntax-checked after its last edits.
