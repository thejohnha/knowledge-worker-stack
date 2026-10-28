# Secret dialog (macOS)

When the agent needs something only you know, such as your Mac's admin password or a one-time login, it runs `ask_secret.sh`. A box with a hidden text field pops up, and what you type goes straight into the command that needs it. The value never appears in the agent's transcript, the shell history, a command's arguments, or the process list.

## Install
From this folder:
```bash
mkdir -p ~/bin && cp ask_secret.sh ~/bin/ && chmod 755 ~/bin/ask_secret.sh
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```

## Use
```bash
# admin (sudo) password
ask_secret.sh "Mac admin password — installing XYZ" | sudo -k -S -p "" <command>

# the admin password of another machine, for a command run there
ask_secret.sh "Admin password on server — restarting the web service" | ssh server 'sudo -k -S -p "" <command>'

# ssh itself reads passwords from the keyboard, not a pipe, so it calls the dialog itself instead
SSH_ASKPASS=~/bin/ask_secret.sh SSH_ASKPASS_REQUIRE=force \
  ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password user@host 'command'
```
- Make the dialog say exactly what the password is for. It is the last thing you see before approving the action.
- The agent writes that text, so an agent steered by something it read could ask for a password under a plausible label. Never type your Mac login password unless you started the task that needs it.
- Cancel exits 1 with nothing on stdout (osascript notes the cancel on stderr).
- `sudo -k` makes sudo read the password even when it remembers a recent one; without it, the password would flow into `<command>` instead.
- It only works while you are at the Mac. For anything unattended, the secret has to be in the [vault](../vault/).
- Don't use `read -s` or "paste this command" instead: when Claude Code runs a command, nothing is there to type into, so those prompts get skipped silently and the command runs with an empty password.
- `SSH_ASKPASS_REQUIRE=force` needs OpenSSH 8.4 or newer, which current macOS includes.
- Tested on macOS 26: the dialog script and its handling of quotes in the prompt text.
