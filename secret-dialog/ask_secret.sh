#!/usr/bin/env bash
# ask_secret.sh — ask the human at this Mac for a secret in a hidden-answer dialog and print it to stdout.
# The value goes straight into the next command through a pipe, so it never appears in the agent's
# transcript, the shell history, a command's arguments, or the process list.
#
#   ask_secret.sh "sudo password — installing KeePassXC" | sudo -k -S -p "" <command>
#   ask_secret.sh "Password for Example Site" | some_tool --password-stdin
#
# It also works as SSH_ASKPASS, because ssh calls it with its own prompt text as $1 (see README).
# Cancel exits 1 with nothing printed. Needs a person at the Mac: it cannot work over ssh or from cron.
set -u
prompt=${1:-Enter the password}
# The prompt goes in as an argument, not spliced into the AppleScript, so a quote in it cannot break the script.
exec /usr/bin/osascript \
  -e 'on run argv' \
  -e 'display dialog (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK" with title "Password needed"' \
  -e 'return text returned of result' \
  -e 'end run' \
  "$prompt"
