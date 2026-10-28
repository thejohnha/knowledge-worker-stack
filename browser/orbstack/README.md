# browse in a Linux machine on your Mac (OrbStack)

The [Linux setup](../linux/README.md), run in a small Linux machine inside your Mac instead of on a separate computer. Chrome draws on the machine's own invisible screen, so it never jumps in front of what you are typing (the macOS setup avoids that too, but any local program can use it). The machine sees none of your Mac's files, and its logins are its own. It runs only while the Mac is awake. Tested on macOS 26 with OrbStack 2.2.3.

## No spare computer?
- Mac: OrbStack, below, is what was tested. License: free for personal, non-commercial use; business and commercial use needs the Pro plan, $8 per user per month or $96 a year (orbstack.dev/pricing, checked October 2026). Free, open-source alternatives that can run the same Debian machine: Lima / Colima, or UTM. Untested.
- Windows: WSL2 can host the Linux setup (untested; it needs systemd enabled in WSL), or use the native [Windows setup](../windows/).
- Linux desktop: run the [Linux setup](../linux/README.md) on it directly, or in a VM to keep its logins apart from yours.
- Or drive a Chromium on your Mac: the [macOS setup](../macos/README.md). Simpler, with a real exposure trade-off.

## Prerequisites
- Apple silicon Mac with Homebrew, with RAM to spare for the machine: the browser unit caps Chrome at 6 GB, and that cap must fit inside `--memory` below (lower both together on a smaller Mac).
- This repo on the Mac.

## 1. Install OrbStack
```bash
brew install --cask orbstack
orbctl config set setup.use_admin false                  # no admin-password helper
orbctl config set machines.expose_ports_to_lan false     # default true: would put the browser's ports on your network
orbctl config set docker.expose_ports_to_lan false
orbctl config set docker.set_context false               # else it rewrites ~/.docker/config.json
orbctl config set machines.forward_ports false           # else the DevTools port answers on the Mac's localhost
orbctl config set app.start_at_login true                # else the machine stays down after a reboot
orbctl stop; orbctl start                                # settings apply on restart
```
- Any `orbctl` command starts OrbStack with its defaults, hence the restart.
- The app's first window asks Docker, Kubernetes or Linux; the answer only picks a starting tab.
- OrbStack may add an `Include ~/.orbstack/ssh/config` line to `~/.ssh/config` and a line to your shell profile. Neither is needed here.

## 2. Create the machine
Always a FRESH machine: an older one can refuse the user namespaces Chrome's sandbox needs (OrbStack issue 2478).
```bash
orb create --isolated --isolate-network --memory 8G --cpus 4 --disk 32G debian:trixie agent-browser    # example sizes
orb -m agent-browser -u root bash -c 'uname -m; ps -p 1 -o comm=; ls -d /mnt/mac /Users'    # aarch64, systemd, then two "No such file"
```
- `--isolated`: the machine shares no Mac files, your `~/.ssh` included.
- `--isolate-network` blocks your Mac's and other machines' addresses but NOT your home network. To keep Chrome off it too, add an nftables rule inside the machine that rejects private address ranges for the `browser` user only (`meta skuid`), leaving root free for apt.

## 3. Copy this repo's browser/ folder in
`orb push` does not work here: it writes through the shared folder an isolated machine does not have, and exits 0 having copied nothing.
```bash
cd /path/to/knowledge-worker-stack
COPYFILE_DISABLE=1 tar -cf - browser | orb -m agent-browser -u root tar -xf - -C /root --no-same-owner
orb -m agent-browser -u root ls /root/browser    # browse.js, linux/, ...
```

## 4. Build the Linux setup inside it
```bash
orb -m agent-browser -u root    # a root shell in the machine
cd /root/browser
```
- Follow [linux/README.md](../linux/README.md) steps 2 through 8 in that shell. Optional: step 11, cookie auto-delete, the same way; it sweeps only while the Mac is awake.
- Keep the VNC server bound to localhost, as shipped. Its password is short and its traffic unencrypted, so the only way in is an ssh tunnel (step 5).

## 5. Sign in to your sites, once
- With the `agent-browser` ssh entry from step 6 in place, open the tunnel in the background, then the viewer:
```bash
ssh -fN -L 5901:localhost:5900 agent-browser
open vnc://localhost:5901                    # macOS Screen Sharing; not yet tried with this server
```
- Type the VNC password. Any VNC viewer at `localhost:5901` works the same. Port 5901, not 5900: `localhost:5900` is the Mac's own Screen Sharing, if it is on.
- When done, close the tunnel: `pkill -f 'ssh -fN -L 5901'`.
- Sign in to each site in Chrome and let Chrome save the password.

## 6. Drive it from the Mac
- An ssh entry for the machine, through OrbStack's own ssh server and key. In `~/.ssh/config`:
```text
Host agent-browser
  User root@agent-browser
  HostName 127.0.0.1
  Port 32222
  IdentityFile ~/.orbstack/ssh/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ~/.orbstack/ssh/known_hosts
  ServerAliveInterval 15
  ServerAliveCountMax 4
```
- The keepalive lines end a dead connection in about a minute instead of leaving a call hanging.
```bash
ssh agent-browser hostname                              # agent-browser
mkdir -p ~/bin && install -m 755 browser/linux/browse-over-ssh.sh ~/bin/browse    # from the repo root
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc    # then open a new terminal
browse open-url https://example.com
```

## Test it
- From the Mac: `open-url` a public page, then `get-text`, `screenshot test.png`, `print2pdf test.pdf`, `native-browser-prompts-view` (`"a11y":true`).
- While those run, in a second terminal; the app name must never change:
```bash
while :; do lsappinfo info -only name "$(lsappinfo front)"; sleep 0.5; done
```
- Exposure, on the Mac: `curl -s localhost:9222/json/version` must fail. The DevTools port lives only inside the machine.
- `orb -m agent-browser -u root bash -c 'ps -o args -u browser | grep -c no-sandbox'`: 0.
- `orb restart agent-browser`, and after the Mac's next sleep and wake: `browse list-tabs` answers with no hand step.

## Remove it
```bash
orb delete -f agent-browser
brew uninstall --zap --cask orbstack    # only if nothing else uses OrbStack
rm ~/bin/browse
```
- Then delete the `Host agent-browser` entry in `~/.ssh/config` and the viewer's saved entry. `~/.docker/config.json` may carry `"currentContext": "orbstack"` from before `set_context` was off; delete that line if Docker is ever installed.

## Known limits
- Up only while the Mac is awake and OrbStack is running.
- Everything in the [Linux setup's known limits](../linux/README.md#known-limits).
