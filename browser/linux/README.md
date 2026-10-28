# browse on an always-on Linux machine

A dedicated Linux machine (a VM or container on any hypervisor, a spare computer, a cloud server) runs Google Chrome on a virtual screen, around the clock. You sign in to each site once through a VNC viewer; from then on AI agents drive that signed-in Chrome with `browse`, from the machine itself or over ssh from your own computer. Your own browser and your own logins are never involved, and nothing ever pops up on your screen. Built from setups tested on Debian 13 (trixie), on amd64 and arm64; this guide as a whole has not been re-run end to end.

## What each part does
- Xorg `:99` with the dummy driver: a fake 1680x1050 monitor. Chrome draws here; no screen hardware needed.
- Openbox: a minimal window manager, so Chrome has a window to maximize.
- A VNC server: shares `:99` so a human can watch, sign in, or take over.
- Google Chrome stable, run as user `browser` with its sandbox on, DevTools port on 127.0.0.1:9222 only.
- `/root/agent-browser/browse`: the entry point. One call at a time, 240s cap, runs `browse.js` (the agent's remote control) as root against port 9222.
- AT-SPI accessibility: the only way to read Chrome's own pop-ups (permission bubbles, the saved-password chooser), which CDP, page JavaScript and X11 cannot see.

## Prerequisites
- Debian 13, root shell, systemd as PID 1. Debian 12 and Ubuntu 24.04 should work (untested). Docker containers do not fit (no systemd); LXC containers and VMs do.
- Memory: the browser unit caps Chrome at 6 GB; set the cap to about 75% of the machine's RAM (step 7). Disk: a few GB for the stack, plus Chrome's profile and cache (cache capped at 256 MB).
- This repo's `browser/` folder on the machine (`git clone`, or copy it over).
- Exposure: whoever can run commands as root or as `browser` on this machine can use every site signed in here. Keep the DevTools port on 127.0.0.1 and reach it over ssh; never publish it. Use the machine for this alone.

## 1. Know where you are
```bash
cd /path/to/knowledge-worker-stack/browser    # every step below runs from here, as root
```

## 2. Install Google Chrome stable
```bash
apt update && apt install -y wget ca-certificates
install -d -m 0755 /etc/apt/keyrings
wget -qO /etc/apt/keyrings/google-chrome.asc https://dl.google.com/linux/linux_signing_key.pub
chmod 644 /etc/apt/keyrings/google-chrome.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
apt update && apt install -y google-chrome-stable
google-chrome-stable --version
rm /etc/apt/keyrings/google-chrome.asc                # Chrome's install replaced the list above with its own repo + key
apt update && apt-cache policy google-chrome-stable   # Chrome's own repo must appear here, or Chrome never updates
```
- Google Chrome, not Chromium: sites see the brand "Google Chrome", the most common fingerprint.

## 3. Install the rest
```bash
apt install -y nodejs node-ws xorg xserver-xorg-video-dummy xauth x11-xserver-utils openbox xdotool at-spi2-core gir1.2-atspi-2.0 python3-gi dbus-user-session iproute2
node -v                                             # 18 or newer
node -e 'console.log(require("ws/package.json").version)'    # a version number, e.g. 8.x
```
- `node-ws` is browse.js's only dependency, from Debian's own packages. `xdotool` operates the screen; `at-spi2-core`, `gir1.2-atspi-2.0` and `python3-gi` read Chrome's pop-ups.

## 4. Create the browser user
```bash
useradd -r -m -d /home/browser -s /usr/sbin/nologin browser
install -d -o browser -g browser /home/browser/browser-profiles /home/browser/browser-profiles/main /home/browser/Downloads /home/browser/agent-browser
loginctl enable-linger browser                  # gives `browser` a session bus at boot, with nobody logged in
runuser -u browser -- unshare --user echo ok    # must print ok, or Chrome's sandbox cannot start
```
- No `ok`: the machine blocks user namespaces (common in containers). Enable nesting / user namespaces in your hypervisor's settings for this guest and retry. Do not paper over it with `--no-sandbox`.
- Linger is state no file shows. Check it with `loginctl show-user browser --property=Linger` (`Linger=yes`).

## 5. The virtual screen and the window manager
```bash
install -D -m 644 linux/xorg-dummy-display.conf /etc/X11/xorg.conf.d/10-dummy.conf
install -m 644 linux/xorg99.service linux/openbox.service /etc/systemd/system/
mkdir -p /root/.config/openbox
[ -f /root/.config/openbox/rc.xml ] || cp /etc/xdg/openbox/rc.xml /root/.config/openbox/rc.xml
sed -i 's|<number>4</number>|<number>1</number>|' /root/.config/openbox/rc.xml   # one desktop: extra ones only hide windows
```

## 6. The VNC server (x11vnc)
x11vnc: free and open source, from Debian's own packages. Tested in the [OrbStack](../orbstack/README.md) build of this same setup. Bound to localhost (not in the tested unit; its traffic is unencrypted), so you reach it through an ssh tunnel, which encrypts it.
```bash
apt install -y x11vnc
x11vnc -storepasswd /etc/x11vnc.pass                  # VNC uses only the first 8 characters
install -m 644 linux/agent-browser-vnc-x11vnc.service /etc/systemd/system/agent-browser-vnc.service
```
- Other VNC servers (TigerVNC's `x0vncserver`, for one) can share an existing display too. Untested here.

## 7. Install the toolset, the Chrome policy and the browser unit
```bash
install -d -m 700 /root/agent-browser
install -m 644 browse.js linux/browse-drive-native-browser-prompts.py /root/agent-browser/
install -m 755 linux/browse-atspi-as-browser-user.py /root/agent-browser/
install -m 755 linux/browse-run-one-at-a-time.sh /root/agent-browser/browse
install -o root -g root -m 755 linux/agent-browser-fix-session-restore.sh /home/browser/agent-browser/
install -D -m 644 linux/agent-browser-chrome-policy.json /etc/opt/chrome/policies/managed/agent-browser.json
sed "s/@UID@/$(id -u browser)/g" linux/agent-browser.service > /etc/systemd/system/agent-browser.service
grep -c @UID@ /etc/systemd/system/agent-browser.service    # 0
node --check /root/agent-browser/browse.js && echo ok      # ok
```
- `MemoryMax=6G` in the unit: about 75% of RAM is right. Edit `/etc/systemd/system/agent-browser.service`.
- The policy file: no "Sign in to Chrome" (sign in to SITES, never to the browser), no sync, no metrics, saved-card autofill on, typed-text history off (`AutofillAddressEnabled: false`, which also turns off address autofill). Check it at `chrome://policy`.

## 8. Start everything, in order
```bash
systemctl daemon-reload
systemctl enable --now xorg99.service
DISPLAY=:99 xdpyinfo | grep -m1 dimensions                 # dimensions: 1680x1050 pixels
systemctl enable --now openbox.service
pgrep -x openbox                                           # a pid
systemctl enable --now agent-browser-vnc.service
ss -ltnp | grep 5900                                       # LISTEN
systemctl enable --now agent-browser.service
wget -qO- http://127.0.0.1:9222/json/version               # "Browser": "Chrome/..."
```
- `enable --now`, never `start`: `start` loses the stack at the next reboot.

## 9. Sign in to your sites, once
- Open the tunnel, `ssh -L 5901:localhost:5900 root@<machine>`, then connect a VNC viewer (TigerVNC Viewer is free and open source) to `localhost:5901`. macOS's built-in Screen Sharing at `vnc://localhost:5901` should work too (untested).
- In Chrome, sign in to each site the agent should use and let Chrome save the password.
- Sign in on THIS machine, where the profile lives: copying cookies from another computer tends to trigger new two-factor prompts or get signed out.

## 10. Drive it from your own computer
- An ssh entry that logs in as root with a key, and drops dead connections in about a minute instead of hanging the caller. In `~/.ssh/config`:
```text
Host agent-browser
  HostName <machine address>
  User root
  ServerAliveInterval 15
  ServerAliveCountMax 4
```
- Then put the wrapper on your PATH as `browse`:
```bash
mkdir -p ~/bin && install -m 755 linux/browse-over-ssh.sh ~/bin/browse
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc    # zsh; use ~/.bashrc for bash; then open a new terminal
browse open-url https://example.com
```
- `AGENT_BROWSER_BOX=<ssh host>` points it at a different machine. Each Claude Code session gets its own tab; any other caller sets `BROWSE_SESSION=<name>` to keep one tab across calls.
- Files the verbs write (screenshots, PDFs, downloads) are on the browser machine, in `/home/browser/Downloads`. Fetch them with `scp`.
- Agents running on the machine itself call `/root/agent-browser/browse` directly.

## 11. Optional: cookie auto-delete
Deletes a site's cookies 20 minutes after its last tab closes, unless whitelisted ([details](../README.md#cookie-auto-delete)). Not run end to end on this setup; the tool itself was tested against a scratch Chromium.
```bash
install -m 644 browse-cookie-auto-delete.js /root/agent-browser/
install -m 600 browse-cookie-whitelist.example.json /root/agent-browser/browse-cookie-whitelist.json
nano /root/agent-browser/browse-cookie-whitelist.json                          # list the domains to keep
node /root/agent-browser/browse-cookie-auto-delete.js --show-whitelist        # "ok":true and your domains
install -m 644 linux/agent-browser-cookie-auto-delete.service linux/agent-browser-cookie-auto-delete.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now agent-browser-cookie-auto-delete.timer
systemctl list-timers agent-browser-cookie-auto-delete.timer                  # next run within 20 minutes
```
- It starts as a dry run. `/root/agent-browser/browse-cookie-auto-delete.log` gets a `WOULD-DELETE` line per domain, with its age. When those look right, arm it:
```bash
sed -i 's|auto-delete.js --quiet|auto-delete.js --arm --quiet|' /etc/systemd/system/agent-browser-cookie-auto-delete.service
systemctl daemon-reload
```
- Signed in to a site by hand in the VNC viewer? Add it to the whitelist, or hold it for a while: `node /root/agent-browser/browse-cookie-auto-delete.js --hold example.com --hold-minutes 1440`.

## Test it
```bash
browse open-url https://example.com
browse get-text                      # the page's text
browse screenshot test.png           # prints its path, under /home/browser/Downloads
browse native-browser-prompts-view   # {"prompts":[],"a11y":true}: a11y:false means Chrome's pop-ups are unreadable
browse list-tabs
```
- `a11y:false`: Chrome started before its session bus existed. Check `Linger=yes` (step 4), then `systemctl restart agent-browser`.
- In the VNC viewer, `chrome://sandbox` reads the namespace sandbox as on, and `chrome://policy` lists every key with no error.
- Reboot the machine: everything comes back, tabs included, with no hand step.

## Remove it
```bash
systemctl disable --now agent-browser-cookie-auto-delete.timer 2>/dev/null; rm -f /etc/systemd/system/agent-browser-cookie-auto-delete.{service,timer}
systemctl disable --now agent-browser.service agent-browser-vnc.service openbox.service xorg99.service
rm /etc/systemd/system/{agent-browser,agent-browser-vnc,openbox,xorg99}.service /etc/X11/xorg.conf.d/10-dummy.conf /etc/opt/chrome/policies/managed/agent-browser.json
systemctl daemon-reload
loginctl disable-linger browser
systemctl stop user@$(id -u browser).service   # userdel fails while the user's session runs
userdel -r browser                   # deletes the Chrome profile: every login and saved password on this machine
rm -r /root/agent-browser /root/.config/openbox
rm -f /etc/x11vnc.pass
apt purge -y google-chrome-stable
apt purge -y x11vnc
apt autoremove -y
```

## Known limits
- `save-page` needs the SingleFile extension, not covered here; use `print2pdf`.
- `upload-file` must point at a file the `browser` user can read (`/tmp` at mode 0644, or `/home/browser/Downloads`). A file under `/root` uploads as an EMPTY file and the verb still reports success; check `files[0].size` with `run-js`.
- `--password-store=basic`: saved passwords are encrypted with a fixed key, so anyone with a copy of the profile can read them. Guard backups of `/home/browser` accordingly.
- Chrome updates only when you run `apt update && apt upgrade`; afterwards `systemctl restart agent-browser`, because an upgrade under a running Chrome can break new tabs.
- From a Mac viewer, Cmd shortcuts arrive as Super, not Ctrl; use Ctrl in the viewer.
- A page `alert()` freezes its tab. Find frozen tabs with `browse dismiss-dialog --probe-only`, then clear them with `browse dismiss-dialog`.
