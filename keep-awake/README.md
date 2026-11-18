# Keep the Mac awake, lid closed too

The chief of staff, the comms manager and the phone bridge only work while the Mac is awake; a sleeping Mac answers nothing. Type `zz` and the Mac stays awake, also with the lid closed, until you type `zzz`. The screen still turns off on its usual timer and when you close the lid.

- **`zz`**: blocks all system sleep (`pmset -a disablesleep 1`), idle and lid-closed alike, and says what the Mac does now.
- **`zzz`**: normal sleep again (`pmset -a disablesleep 0`).
- **`keep_awake_watchdog.sh`**: the block does not survive a restart, and other apps that write the same setting (a battery app's calibration, for one) can leave it off. While `zz` is on, this puts the block back, at login, every minute and whenever the power settings change.

`zz` writes its choice to `~/.config/knowledge-worker-stack/keep-awake` before it changes the setting: the change itself wakes the watchdog, which must already see the new choice, or it would undo it. The file exists while `zz` is on.

Changing the setting needs administrator rights. With the sudo rule in step 2, `zz` and `zzz` need no password and the watchdog can do its job; without it, `sudo` asks for your password each time and the watchdog only logs, once, that it could not put the block back.

## Install
Not in the default install. From the repo folder: `./install.sh --only keep-awake` (step 1; it never runs sudo, so it prints step 2 for you). By hand:

### 1. The commands and the watchdog
From this folder:
```bash
mkdir -p ~/bin ~/Library/Logs/knowledge-worker-stack && install -m 755 zz zzz keep_awake_watchdog.sh ~/bin/
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
cat > ~/Library/LaunchAgents/local.knowledge-worker-stack.keep-awake-watchdog.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.knowledge-worker-stack.keep-awake-watchdog</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/keep_awake_watchdog.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
  <key>WatchPaths</key><array><string>/Library/Preferences/com.apple.PowerManagement.plist</string></array>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/keep_awake_watchdog.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/keep_awake_watchdog.log</string>
</dict>
</plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.knowledge-worker-stack.keep-awake-watchdog.plist
```

### 2. The sudo rule (you, once)
Paste into your own Terminal window; it asks for your Mac password once. It writes the rule to a temporary file, checks it with `visudo`, and installs it only if the check passes, because a broken file in `/etc/sudoers.d` can lock you out of `sudo`:
```bash
f=$(mktemp) && printf '%s\n' 'Cmnd_Alias KWS_KEEP_AWAKE = /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0' '%admin ALL=(root) NOPASSWD: KWS_KEEP_AWAKE' > "$f" && /usr/sbin/visudo -cf "$f" && sudo install -m 440 -o root -g wheel "$f" /etc/sudoers.d/knowledge-worker-stack-keep-awake; rm -f "$f"
```
It allows exactly those two commands, for any admin account, and nothing else. Then:
```bash
zz                                 # no password asked
pmset -g | grep SleepDisabled      # 1 = sleep blocked
zzz                                # unless you want it on now
```

## Use
- Before you leave the Mac running with the lid closed: `zz`. Before you put it in a bag: `zzz`.
- After a restart there is no need to type `zz` again while the watchdog runs; it puts the block back about a minute after login.
- The watchdog writes to `~/Library/Logs/knowledge-worker-stack/keep_awake_watchdog.log` only when it does something.

## Know the risks
- **Heat and battery.** A Mac that cannot sleep keeps running with the lid closed, in a bag too, where it can overheat and drain the battery flat. Nothing turns sleep back on by itself, not even a low battery. Run `zzz` before you pack it.
- **The sudo rule** lets any program running as an admin user turn sleep blocking on or off without a password. It allows only those two exact commands.

## Remove it
Run `zzz` first: removing the watchdog while sleep is blocked leaves the block on until the next restart. `./install.sh --uninstall` refuses while `zz` is on, for that reason. By hand:
```bash
zzz
launchctl bootout gui/$(id -u)/local.knowledge-worker-stack.keep-awake-watchdog
rm ~/Library/LaunchAgents/local.knowledge-worker-stack.keep-awake-watchdog.plist ~/bin/zz ~/bin/zzz ~/bin/keep_awake_watchdog.sh
rm -f ~/Library/Logs/knowledge-worker-stack/keep_awake_watchdog.log
sudo rm /etc/sudoers.d/knowledge-worker-stack-keep-awake      # the rule from step 2, if you added it
```

## Known limits
- With FileVault on, a restarted Mac waits at the disk-unlock screen, with no network, until someone types the password at its keyboard. For a planned restart, `sudo fdesetup authrestart` skips that screen once.
- If something turns the block off, the watchdog acts on the power settings change at once; if that is missed, the Mac can sleep for up to a minute before the next check, and a Mac already asleep stays asleep.
- `zz` from Claude Code without the sudo rule fails: there is no Terminal for `sudo` to ask in. Add the rule, or run `zz` in your own Terminal.

Tested on macOS 26 in a throwaway home folder with stand-ins for `sudo` and `pmset` that remember the setting: `zz` and `zzz` with and without the sudo rule (the password fallback, and a refused password leaving the choice as it was), the marker existing at the moment of each setting change, the watchdog putting the block back after a simulated restart, staying silent when the block is on or `zz` is off, and logging once without the rule; the installer part (left out by default, installed with `--only`, a second run with no changes, dry run writing nothing, uninstall refusing while `zz` is on and removing everything after `zzz`), the plist through `plutil -lint`, and the sudo rule through `visudo -cf`. Not tested: a real `pmset` change, the installed sudo rule, a real restart, and the LaunchAgent firing on schedule or on a power settings change.
