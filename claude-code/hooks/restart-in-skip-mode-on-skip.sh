#!/usr/bin/env bash
# UserPromptSubmit hook: a prompt that is exactly "skip" (trimmed, any case) restarts THIS session in skip
# mode. It arms claude_restart_session.sh <uuid> --dangerously-skip-permissions (which detaches its own watcher, so it outlives the
# quit, and tells the resumed session to carry on) and then BLOCKS the prompt: the word never reaches the
# model, the session stays idle, and the restart's two-idle-reads check passes. The notice goes out as the
# block reason, which the user sees and the model does not, so the hook costs zero context tokens; every other
# prompt exits at the first test with no output.
# Claude Code puts a blocked prompt back in the input box; --clear-draft lets the restart wipe that word.
# Already in skip mode, or a restart already armed for this session: blocked with a notice, nothing armed.
# Fail-open: anything unparseable exits 0 and the prompt goes through untouched.
payload=$(cat)
shopt -s nocasematch
[[ $payload == *skip* ]] || exit 0
p=$(jq -r '.prompt // empty' <<<"$payload" 2>/dev/null) || exit 0
p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"
[[ $p == skip ]] || exit 0
shopt -u nocasematch

block() { jq -cn --arg r "$1" '{decision:"block", reason:$r}'; exit 0; }
sid=$(jq -r '.session_id // empty' <<<"$payload")
[[ $sid =~ ^[0-9a-f-]{36}$ ]] || exit 0
[[ $(jq -r '.permission_mode // empty' <<<"$payload") == bypassPermissions ]] && block "Already in skip mode — nothing to restart."
pgrep -f "claude_restart_session.sh --watch $sid" >/dev/null && block "A restart is already armed for this session — it happens once the session is idle."
# Effort off the last reply: $CLAUDE_EFFORT is not in a hook's environment.
tp=$(jq -r '.transcript_path // empty' <<<"$payload")
eff=$([[ -f $tp ]] && tail -c 400000 "$tp" | grep '"type":"assistant"' | grep -o '"effort":"[a-z]*"' | tail -1 | cut -d'"' -f4)
if out=$("$HOME/bin/claude_restart_session.sh" "$sid" --dangerously-skip-permissions --clear-draft "$p" ${eff:+--effort "$eff"} 2>&1); then
  block "Restarting in skip mode once idle — back in a few seconds, then it carries on by itself. Log: ${out##*-> }"
fi
block "Skip-mode restart NOT armed: $out"
