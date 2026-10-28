# agent-browser on Windows with Microsoft Edge

One always-on Edge browser on a Windows machine that any number of AI agent sessions can drive at once,
each in its own tab, without colliding. It is ordinary Edge with an ordinary profile: not
automation-flagged, not headless, not a stripped-down engine. Some sites block automated Chrome; this
runs ordinary Edge instead.

`browse <verb>` covers `open-url`, `get-text`, `get-html`, `get-values`, `click`, `enter-text`,
`press-key`, `snapshot` (stable element refs), `screenshot`, `print2pdf`, `save-page`, `download`,
`upload-file`, `run-js`, `list-tabs`, `close-tabs`, `restart-browser` and the native-prompt verbs. Data
verbs print one JSON line; capture verbs write a file and print its path. Each session is identified by
`BROWSE_SESSION` and keeps its own tab, so two agents never see each other's pages.

This is a fork of the Linux/Chrome version, adapted for Windows. It is meant to be edited for the
machine it runs on and does not track upstream.

## Files

| File | Role |
|---|---|
| `install-agent-browser-windows.ps1` | Installer, and the manifest: every URL, version and SHA-256 lives here |
| `browse.ps1` | Entry point: one call at a time (named mutex), 240 s cap per call, loads `browse.env.ps1` if present |
| `browse.js` | The tool: speaks the Chrome DevTools Protocol to Edge over a WebSocket |
| `browse-drive-native-browser-prompts.ps1` | OS layer: reads Edge's own UI via UI Automation, sends guarded keystrokes |
| `browse-ssh-entry.sh` | Optional: lets agents on another machine call the box over SSH |

## Prerequisites

- Windows 10 or 11 with a desktop session. Edge and Windows PowerShell 5.1 are already there.
- An administrator account to run the installer. The browser itself runs as that logged-on user.
- Internet access for the pinned Node.js 24.20.0 zip and OpenSSH 9.5.0.0 MSI (or both files placed beside
  the installer) and for `npm install ws@8.21.3`. No `winget` needed.
- Sizing: allow at least 4 CPU cores and 6 GB of RAM if several heavy pages will be open at once.

## Install

Run every step in an **elevated** Windows PowerShell on the Windows machine, from the folder holding
these files. Script execution is usually blocked by default, hence `-ExecutionPolicy Bypass`.

1. Run the installer. Add `-AuthorizedKey "ssh-ed25519 AAAA... you@laptop"` if agents will reach the box
   over SSH (this also turns SSH password sign-in off), or `-SkipOpenSSH` if they will not.

       powershell -NoProfile -ExecutionPolicy Bypass -File .\install-agent-browser-windows.ps1

   To use Windows' built-in OpenSSH instead of the pinned MSI, run this first and add `-SkipOpenSSH`. It
   pulls from Windows Update, so it can be slow and fails offline:

       Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

   It creates `C:\agent-browser` and `C:\agent-browser\state`, installs Node to `C:\nodejs` (machine
   PATH) and `ws@8.21.3` into `C:\agent-browser`, and locks both folders so only administrators can change
   them (the browser's profile and state folder are writable, and readable, by your account alone). It
   installs and starts sshd, opens inbound TCP 22 to the local subnet on private and domain networks only
   (never on a network Windows calls public), and registers
   the scheduled task `AgentBrowserEdge`, which starts Edge at logon with a dedicated profile and
   `--remote-debugging-port=9222`. It is idempotent; re-run it after a failure.

2. Copy the runtime files into place.

       Copy-Item browse.js, browse.ps1, browse-drive-native-browser-prompts.ps1 C:\agent-browser\

3. Start the browser and prove CDP answers. `Browser` must begin `Edg/`.

       schtasks /Run /TN AgentBrowserEdge
       (Invoke-WebRequest http://localhost:9222/json/version -UseBasicParsing).Content

4. In the Edge window that opened, set `edge://settings/startHomeNTP` > **On startup** to **Open tabs
   from the previous session**. `restart-browser` relies on Edge's own session restore to bring tabs back.
   Set it in the page: the `RestoreOnStartup` policy is ignored on a machine not joined to a domain.

5. Turn on Windows auto-logon for that account, so the task fires
   and Edge comes back in a real desktop session after a reboot.

6. Optional: a `browse.cmd` on PATH for the short form.

       @powershell -NoProfile -ExecutionPolicy Bypass -File C:\agent-browser\browse.ps1 %*

7. Optional: per-box settings in `C:\agent-browser\browse.env.ps1`. Every path is an environment
   variable: `BROWSE_HOME`, `BROWSE_STATE`, `BROWSE_DOWNLOADS`, `BROWSE_CDP`, `BROWSE_NODE`,
   `BROWSE_RESTART_TASK`. Guard each one so a value set by the caller still wins:

       if (-not $env:BROWSE_DOWNLOADS) { $env:BROWSE_DOWNLOADS = 'D:\captures' }

### Agents on another machine

Copy `browse-ssh-entry.sh` to that machine as `browse` on PATH (it needs `ssh` and `python3`). It passes
the calling session's id through as `BROWSE_SESSION`, which is what gives each session its own tab, and
ships the arguments as base64 so selectors and JavaScript survive three shells' quoting. Point it at the
box with an SSH config entry; `BROWSE_WINDOWS_HOST` selects a different entry name.

    Host agent-browser-windows
      HostName <the Windows machine>
      User <the Windows account>
      IdentityFile ~/.ssh/<your key>

Copy files onto the box with `scp -O`. Plain `scp` uses SFTP and fails against this OpenSSH build with a
bare `Connection closed`.

## Test

On the Windows machine, as the logged-on user (`browse` is the step 6 wrapper, or the full
`powershell ... -File C:\agent-browser\browse.ps1` form):

    browse open-url https://example.com
    browse get-text
    browse screenshot
    browse native-browser-prompts-view

Expect a JSON line with `"status":200`, the page text, a PNG path under `%USERPROFILE%\Downloads`, and
a prompt list (usually empty) with `"a11y":true`. Repeat the first three from the remote machine if you set one up; there
`native-browser-prompts-view` answers `"a11y":false` by design (see Known limits).

## Remove

In an elevated Windows PowerShell:

    schtasks /End /TN AgentBrowserEdge; Unregister-ScheduledTask AgentBrowserEdge -Confirm:$false
    Remove-NetFirewallRule -Name agent-browser-sshd
    $p = [Environment]::GetEnvironmentVariable('Path','Machine') -replace ';C:\\nodejs',''
    [Environment]::SetEnvironmentVariable('Path', $p, 'Machine')
    Remove-Item C:\agent-browser, C:\nodejs -Recurse -Force

`C:\agent-browser` holds the agent's Edge profile, including any saved sign-ins. If the installer put
OpenSSH on the machine, uninstall it from Settings > Apps and delete your key line from
`C:\ProgramData\ssh\administrators_authorized_keys`. If you keep OpenSSH and want passwords back, delete
the `PasswordAuthentication no` line at the top of `C:\ProgramData\ssh\sshd_config` and restart sshd.
Turn auto-logon off if you turned it on.

## Known limits

- **The OS layer needs the desktop session.** `dismiss-dialog`, `save-page` and the
  `native-browser-prompts-*` verbs use UI Automation and real keystrokes, which only reach windows in
  the caller's own Windows session. Over SSH they say they cannot see (`"a11y":false` or a non-zero exit) or
  skip the keystroke; they never report "no prompts". Every CDP verb works from anywhere. Run agents on the Windows machine itself
  to get all of them.
- **Keystrokes are refused unless Edge owns the foreground window.** Someone may be using the machine,
  and a mis-aimed key lands in whatever they are typing in. Do not remove that check.
- **`--out` does not survive `powershell -File`**: PowerShell binds it as its own `-OutVariable`. Captures
  land in `%USERPROFILE%\Downloads`; use the path the verb prints.
- **`login`, `login --list` and `session-state` need a site registry** (`browse-site-login-recipes.json`
  beside `browse.js`, schema in `loadLoginRegistry`). None ships, so they fail closed until you write one.
- **`save-page` needs the SingleFile extension** in the agent's Edge profile, on its default `Ctrl+Shift+Y`.
- **"cannot connect to CDP" while Edge is running** means a plain Edge window without the debugging port
  is up. `Start-ScheduledTask AgentBrowserEdge` starts the agent Edge alongside it (separate profile).
- **An administrator's SSH key lives in `C:\ProgramData\ssh\administrators_authorized_keys`**, not
  `~/.ssh/authorized_keys`, and sshd silently ignores it unless only SYSTEM and Administrators can access
  it. The installer sets both.
- **The state folder holds tab URLs**, and the pre-restart snapshot keeps them unredacted. The installer
  makes `C:\agent-browser\state` readable only by the agent's account and administrators; keep it that way.
- **`run-js` can read a filled password field.** No verb prints one, but that is a convention, not a wall.
- **Park idle tabs on `about:blank`.** A heavy page left open can hold every core.
- **No cookie auto-delete.** `browse-cookie-auto-delete.js` is Linux-only, and this copy of `browse.js` adds no holds after `login`.
- **No test suite ships with this copy.**

Tested: this setup was built and run on a scratch Windows machine with Edge. Not tested in this
packaged form: the installer as it stands now (its folder lock-down, firewall scope and
password switch-off were added for publication, after that run) and this copy of `browse.js`, which was
only syntax-checked after its last edits.
