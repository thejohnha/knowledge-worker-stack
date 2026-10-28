# hg — the herdr grid. Source this file from ~/.zshrc (works in zsh and bash):
#   hg        go to the grid: makes its workspace if missing, starts it if its pane is at a shell, focuses it
#   hg run    draw the grid in the current pane
hg() {
  herdr_session_grid.py "$@" || return
  # Bare `hg` from a plain terminal while the herdr server runs but no client is attached: the grid was
  # placed on the server and nothing shows here, so attach the client in this terminal.
  if [ $# -eq 0 ] && [ -z "${HERDR_ENV:-}" ] && ! pgrep -qf '^(/[^ ]*/)?herdr$'; then
    command herdr; local rc=$?
    # Detaching can leave mouse, focus and bracketed-paste reporting on; turn them back off.
    printf '\033[?1000l\033[?1002l\033[?1003l\033[?1004l\033[?1006l\033[?2004l\033[?1049l\033[?25h'
    stty sane 2>/dev/null
    return $rc
  fi
}
