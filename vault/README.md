# Agent vault

A password store just for your AI agent: a separate KeePassXC database holding only the logins you choose to give it. It opens with a key file and no master password, so the agent can read it without asking you. `agent_get_credential` reads one value at a time, exact title or nothing, and the agent pipes that value straight into the program that needs it instead of displaying it.

Don't give an agent your main password manager. This vault holds only what you put in it.

## Install (macOS)
From this folder:
```bash
brew install --cask keepassxc
mkdir -p ~/bin && cp agent_get_credential ~/bin/ && chmod 755 ~/bin/agent_get_credential
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```
KeePassXC and the script also work on Linux (install `keepassxc` from your package manager).

## Create the vault (once)
```bash
mkdir -p ~/agent-vault ~/.config/agent-vault && chmod 700 ~/agent-vault ~/.config/agent-vault
keepassxc-cli db-create -q --set-key-file ~/.config/agent-vault/agent-vault.keyx ~/agent-vault/agent-vault.kdbx
chmod 600 ~/.config/agent-vault/agent-vault.keyx
```
- Keep the key file away from the database. Never put the key file in a folder that syncs to the cloud, and never email it.
- Back up both. Losing the key file means losing the vault.
- Other locations: set `CRED_DB` and `CRED_KEYFILE`.

## Add entries
In the KeePassXC app, open the database, choose "Key File" instead of a password, then add a title, username, password and URL. You can also have the agent add one, with the value going in through stdin rather than on the command line ([`ask_secret.sh`](../secret-dialog/) asks you for it):
```bash
ask_secret.sh "Password for Example Site" | keepassxc-cli add -q --no-password \
  -k ~/.config/agent-vault/agent-vault.keyx -u alice --url example.com -p ~/agent-vault/agent-vault.kdbx 'Example Site'
```

## Use
```bash
agent_get_credential list                       # entry titles only
P=$(agent_get_credential 'Example Site')      # into a variable, never printed
agent_get_credential 'Example Site' username
agent_get_credential totp 'Example Site'      # current 2FA code, if the entry has one
agent_get_credential hash 'Example Site'      # checks the value without showing it
```
- Exact title or nothing: a misspelled or partial title returns nothing and fails, so the agent never gets the wrong login by accident. Find titles with `list` or `find`.
- The Notes field is always refused, in any capitalization. Notes is free text, and there is no way to read it to see what's inside without exposing what's inside.
- `find` matches titles only. KeePassXC's own search also looks in notes, usernames and URLs, and its `n:`/`p:` prefixes search one field, so a yes/no answer could reveal a value piece by piece; prefixes are refused.

## Remove
Delete `~/bin/agent_get_credential`, `~/agent-vault/` and `~/.config/agent-vault/` (back them up first if you might want them again).

Tested on macOS 26 with KeePassXC 2.8: every command above, against a throwaway vault.
