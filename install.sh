#!/bin/bash
# install.sh: set up knowledge-worker-stack on this Mac by doing what each folder's README says, and nothing more.
#
#   ./install.sh                         install the default set (below)
#   ./install.sh --dry-run               print every change it would make; change nothing
#   ./install.sh --only herdr,grid       just these parts
#   ./install.sh --skip comms            the default set minus these
#   ./install.sh --uninstall             undo what this script did (all parts, or --only/--skip ones)
#
# Parts, in install order (the later ones use the earlier ones):
#   secret-dialog      ask_secret.sh                                         default
#   vault              KeePassXC + agent_get_credential + an empty vault      default
#   browser-macos      browse on this Mac's own Chromium                      add with --only
#   browser-orbstack   browse in a Linux machine under OrbStack               add with --only
#   herdr              herdr, its server at login, the session tools          default
#   starter-claude-md  ~/.claude/CLAUDE.md, only if you have none             default
#   claude-code        status line, titles, skills, hooks, schedules          default
#   model-sync         keeps the /model list current under the token sign-in add with --only, after the token
#   google             Gmail, Drive, Sheets, Docs, Calendar via gws and g      add with --only
#   office             Excel workbook tools (xlsx surgery, formula cache)     add with --only
#   grid               hg and the ctrl+alt+g grid                             default
#   mattermost         Mattermost on this Mac, under OrbStack                 add with --only
#   comms              comms manager, chief of staff, Priorities list         default
#   imessage           wake sessions on incoming iMessage/SMS (comms guide)   add with --only (after comms)
#   phone-bridge       text the chief of staff from the Mattermost app        add with --only (after mattermost)
#
# Safe to run again: anything already in place is left alone. Every file it replaces, and settings.json
# and ~/.zshrc before any edit, are copied to ~/knowledge-worker-stack-backups/install/<time>/ first. What it adds is
# listed in ~/.config/knowledge-worker-stack/install-record.tsv, which is all --uninstall ever removes; removed files
# go to ~/knowledge-worker-stack-backups/uninstall-<time>/, not to oblivion, except saved sign-ins and message texts,
# which are deleted.
# Never: prints a secret, runs `claude setup-token`, touches the Keychain, edits crontab, or deletes your
# data (the vault, the browser machine, Mattermost's messages, the Priorities list).
set -u

REPO=$(cd "$(dirname "$0")" && pwd)
ALL="secret-dialog vault browser-macos browser-orbstack herdr starter-claude-md claude-code model-sync google office grid mattermost comms imessage phone-bridge"
DEFAULT="secret-dialog vault herdr starter-claude-md claude-code grid comms"
DRY=0 UNINSTALL=0 ONLY="" SKIP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --only) ONLY="${2:-}"; shift ;;
    --only=*) ONLY="${1#*=}" ;;
    --skip) SKIP="${2:-}"; shift ;;
    --skip=*) SKIP="${1#*=}" ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $1 (--help lists them)" >&2; exit 2 ;;
  esac
  shift
done
for c in $(echo "$ONLY,$SKIP" | tr ',' ' '); do
  case " $ALL " in *" $c "*) ;; *) echo "install.sh: no part called '$c'. Parts: $ALL" >&2; exit 2 ;; esac
done
if [ -n "$ONLY" ]; then BASE=" $(echo "$ONLY" | tr ',' ' ') "
elif [ "$UNINSTALL" = 1 ]; then BASE=" $ALL "
else BASE=" $DEFAULT "; fi
SEL=""
for c in $ALL; do
  case "$BASE" in *" $c "*) case ",$SKIP," in *",$c,"*) ;; *) SEL="$SEL $c" ;; esac ;; esac
done
FULL=0; [ -z "$ONLY$SKIP" ] && FULL=1
case " $SEL " in *" browser-macos "*) case " $SEL " in *" browser-orbstack "*)
  [ "$UNINSTALL" = 0 ] && { echo "install.sh: choose ONE browser setup; both install the command 'browse'" >&2; exit 2; } ;; esac ;; esac

TS=$(date +%Y%m%d_%H%M%S)
BK="$HOME/knowledge-worker-stack-backups/install/$TS"
CFG="$HOME/.config/knowledge-worker-stack"
REC="$CFG/install-record.tsv"
BLOCKS="$CFG/install-blocks"
SETTINGS="$HOME/.claude/settings.json"
LA="$HOME/Library/LaunchAgents"
UIDN=$(id -u)
T=$(printf '\t')
US=$(printf '\037')   # separates fields inside one record column; unlike a tab, read never merges empty ones
HUMAN="" FAILED="" MISSING="" CHANGES=0
mkdir -p "${TMPDIR:-/tmp}" 2>/dev/null

say()   { printf '%s\n' "$*"; }
SAID=""
act()   {   # a dry run says each would-be change once, however many parts ask for it
  if [ "$DRY" = 1 ]; then
    case "$SAID" in *"|$*|"*) return 0 ;; esac
    SAID="$SAID|$*|"; CHANGES=$((CHANGES+1)); say "  would: $*"
  else CHANGES=$((CHANGES+1)); say "  + $*"; fi
}
warn()  { say "  ! $*"; }
human() { HUMAN="$HUMAN$*
"; }
short() { printf '%s' "${1/#$HOME/~}"; }
# A backup copy, made once per run per file, before the first change to it.
bk() {
  local f=$1 d="$BK/${1#$HOME/}"
  [ -e "$f" ] || return 0
  [ -e "$d" ] && return 0
  mkdir -p "$(dirname "$d")" && cp -pR "$f" "$d"
}
rec() {   # rec <part> <kind> <a> [b]: what was added, for --uninstall
  [ "$DRY" = 1 ] && return 0
  local line; line=$(printf '%s\t%s\t%s\t%s' "$1" "$2" "$3" "${4:-}")
  if [ ! -d "$CFG" ]; then   # the record's own folder; ~/.config too when this made it
    local made=0; [ -d "$HOME/.config" ] || made=1
    mkdir -p "$CFG"
    [ "$made" = 1 ] && printf 'common\tdir\t%s\t\n' "$HOME/.config" >> "$REC"
  fi
  grep -qxF -- "$line" "$REC" 2>/dev/null || printf '%s\n' "$line" >> "$REC"
}

# ---- brew, python ---------------------------------------------------------------------------------
BREW=$(command -v brew 2>/dev/null)
if [ -z "$BREW" ]; then for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && BREW=$b && break; done; fi
BREWP=""
[ -n "$BREW" ] && BREWP=$("$BREW" --prefix 2>/dev/null)
[ -n "$BREWP" ] && PATH="$BREWP/bin:$BREWP/sbin:$PATH"
PATH="$HOME/bin:$HOME/.local/bin:$PATH"
export PATH
need_brew() {   # need_brew <part>: only reached if the early check below let a part through without brew
  [ -n "$BREW" ] && return 0
  warn "$1 needs Homebrew, which is not installed; skipped"
  return 1
}
brew_get() {    # brew_get <part> formula|cask <name>
  need_brew "$1" || return 1
  local flag="--formula"; [ "$2" = cask ] && flag="--cask"
  "$BREW" list $flag "$3" >/dev/null 2>&1 && return 0
  act "brew install $flag $3"
  [ "$DRY" = 1 ] && return 0
  "$BREW" install $flag "$3" || { warn "brew install $3 failed"; return 1; }
  rec "$1" brew "$flag" "$3"
}
# Homebrew missing and a chosen part needs it: stop before changing anything, with the one step that fixes it.
if [ "$UNINSTALL" = 0 ] && [ -z "$BREW" ]; then
  needs=""
  for c in $SEL; do case "$c" in vault|browser-macos|browser-orbstack|herdr|mattermost|google) needs="$needs $c" ;; esac; done
  case " $SEL " in *" claude-code "*) command -v jq >/dev/null || needs="$needs claude-code" ;; esac
  case " $SEL " in *" office "*) command -v uv >/dev/null || needs="$needs office" ;; esac
  if [ -n "$needs" ]; then
    say "Homebrew is not installed, and these parts need it:$needs. Nothing was changed."
    say "HUMAN STEP: in Terminal run"
    say '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
    say "type your Mac password when it asks, run the \"Next steps\" lines it prints at the end, then run ./install.sh again."
    exit 1
  fi
fi
if ! { xcode-select -p >/dev/null 2>&1 && python3 -c 1 >/dev/null 2>&1; }; then
  if [ "$UNINSTALL" = 0 ]; then
    say "python3 is missing: it comes with Apple's command line tools."
    say "HUMAN STEP: run   xcode-select --install   click Install in the window that opens, wait for it to finish, then run ./install.sh again."
    exit 1
  fi
fi

# ---- files ----------------------------------------------------------------------------------------
put() {   # put <part> <src> <dest> <mode>: copy if missing or different (the old one backed up first)
  local p=$1 src=$2 dest=$3 mode=$4
  [ -f "$src" ] || { warn "missing in this repo: $src"; MISSING="$MISSING $p"; return 1; }
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    if [ ! -L "$dest" ] && cmp -s "$src" "$dest"; then
      if [ "$(stat -f %Lp "$dest")" != "$mode" ]; then
        act "chmod $mode $(short "$dest")"; [ "$DRY" = 1 ] || chmod "$mode" "$dest"
      fi
      return 0
    fi
    act "replace $(short "$dest") (old one backed up)"
    [ "$DRY" = 1 ] && return 0
    bk "$dest"; rm -f "$dest"; install -m "$mode" "$src" "$dest"
    rec "$p" replaced "$dest" "$BK/${dest#$HOME/}$US$(md5 -q "$dest")"
  else
    act "add $(short "$dest")"
    [ "$DRY" = 1 ] && return 0
    mkparents "$p" "$(dirname "$dest")"; install -m "$mode" "$src" "$dest"
    rec "$p" file "$dest" "$(md5 -q "$dest")"
  fi
}
mkparents() {  # mkparents <part> <dir>: create it, recording each folder that did not exist, outermost first
  local p=$1 d=$2 todo=""
  while [ ! -d "$d" ] && [ "$d" != "$HOME" ] && [ "$d" != / ]; do todo="$d
$todo"; d=$(dirname "$d"); done
  [ -z "$todo" ] && return 0
  mkdir -p "$2"
  printf '%s' "$todo" | while IFS= read -r d; do [ -n "$d" ] && rec "$p" dir "$d"; done
}
putmany() {  # putmany <part> <srcdir> <destdir> <mode> <file>...
  local p=$1 s=$2 d=$3 m=$4; shift 4
  local f; for f in "$@"; do put "$p" "$s/$f" "$d/$(basename "$f")" "$m"; done
}
mkd() {   # mkd <part> <mode> <dir>...
  local p=$1 m=$2 d; shift 2
  for d in "$@"; do
    [ -d "$d" ] && continue
    act "create folder $(short "$d")"
    [ "$DRY" = 1 ] && continue
    mkparents "$p" "$d" && chmod "$m" "$d"
  done
}
# A line added once, guarded the way the READMEs guard it (a fixed string already in the file = done).
add_line() {  # add_line <part> <file> <guard> <line>
  local p=$1 f=$2 g=$3 l=$4
  grep -qF -- "$g" "$f" 2>/dev/null && return 0
  act "add to $(short "$f"): $l"
  [ "$DRY" = 1 ] && return 0
  bk "$f"; mkparents "$p" "$(dirname "$f")"; [ -e "$f" ] || rec "$p" newfile "$f"
  [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"
  printf '%s\n' "$l" >> "$f"
  rec "$p" line "$f" "$l"
}
add_block() { # add_block <part> <file> <guard> <id> <text>: append a README block once
  local p=$1 f=$2 g=$3 id=$4 t=$5
  grep -qF -- "$g" "$f" 2>/dev/null && return 0
  act "add to $(short "$f"): the $id block"
  [ "$DRY" = 1 ] && return 0
  bk "$f"; mkparents "$p" "$(dirname "$f")"; mkdir -p "$BLOCKS"; [ -e "$f" ] || rec "$p" newfile "$f"
  [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && echo >> "$f"
  printf '%s\n' "$t" >> "$f"
  printf '%s\n' "$t" > "$BLOCKS/$id"
  rec "$p" block "$f" "$id"
}
PATHLINE='export PATH="$HOME/bin:$PATH"'
path_line() { add_line common "$HOME/.zshrc" 'HOME/bin' "$PATHLINE"; }

# ---- settings.json: merge, never replace ----------------------------------------------------------
# stdin, one per line, tab-separated: hook<TAB>Event<TAB>matcher<TAB>command<TAB>timeout | allow<TAB>rule
# | statusline<TAB>command | outputstyle<TAB>name | key<TAB>name<TAB>json-value (each set only when absent). Prints what it added (ADDED ...) or why it left something (KEPT ...).
SETTINGS_PY='
import json, os, sys, shutil
path, mode, dry, bkpath = sys.argv[1:5]
spec = [l.rstrip("\n").split("\t") for l in sys.stdin if l.strip()]
try:
    data = json.load(open(path)) if os.path.exists(path) and os.path.getsize(path) else {}
    assert isinstance(data, dict)
except Exception as e:
    print("ERROR\t%s is not valid JSON (%s)" % (path, e)); sys.exit(3)
def key(cmd):
    for t in cmd.replace("\"", " ").replace("\x27", " ").split():
        if "/" in t and t.endswith((".sh", ".py")):
            return os.path.basename(t)
    return cmd
out = []
for s in spec:
    k = s[0]
    if k == "hook":
        ev, matcher, cmd, timeout = s[1], s[2], s[3], s[4]
        groups = data.get("hooks", {}).get(ev, [])
        hit = [(g, h) for g in groups for h in g.get("hooks", []) if key(h.get("command", "")) == key(cmd)]
        if mode == "add":
            if hit: continue
            h = {"type": "command", "command": cmd}
            if timeout: h["timeout"] = int(timeout)
            g = {"hooks": [h]}
            if matcher: g = {"matcher": matcher, "hooks": [h]}
            data.setdefault("hooks", {}).setdefault(ev, []).append(g)
            out.append("ADDED\thook\t%s\t%s\t%s\t%s" % (ev, matcher, cmd, timeout))
        else:
            for g, h in hit:
                if h.get("command") == cmd:
                    g["hooks"].remove(h); out.append("REMOVED\thook\t%s" % cmd)
            if ev in data.get("hooks", {}):
                data["hooks"][ev] = [g for g in groups if g.get("hooks")]
                if not data["hooks"][ev]: del data["hooks"][ev]
                if not data["hooks"]: del data["hooks"]
    elif k == "allow":
        allow = data.get("permissions", {}).get("allow", [])
        if mode == "add":
            if s[1] in allow: continue
            data.setdefault("permissions", {}).setdefault("allow", []).append(s[1])
            out.append("ADDED\tallow\t%s" % s[1])
        elif s[1] in allow:
            allow.remove(s[1]); out.append("REMOVED\tallow\t%s" % s[1])
            if not allow: del data["permissions"]["allow"]
            if not data["permissions"]: del data["permissions"]
    elif k == "outputstyle":
        cur = data.get("outputStyle")
        if mode == "add":
            if cur is None:
                data["outputStyle"] = s[1]; out.append("ADDED\toutputstyle\t%s" % s[1])
            elif cur != s[1]:
                print("KEPT\toutputstyle\tyou already have an output style (%s); left it" % cur)
        elif cur == s[1]:
            del data["outputStyle"]; out.append("REMOVED\toutputstyle\t%s" % s[1])
    elif k == "key":
        name, val = s[1], json.loads(s[2])
        if mode == "add":
            if name not in data:
                data[name] = val; out.append("ADDED\tkey\t%s\t%s" % (name, s[2]))
            elif data[name] != val:
                print("KEPT\tkey\tyou already set %s (%s); left it" % (name, json.dumps(data[name])))
        elif name in data and data[name] == val:
            del data[name]; out.append("REMOVED\tkey\t%s" % name)
    elif k == "statusline":
        cur = data.get("statusLine")
        if mode == "add":
            if cur is None:
                data["statusLine"] = {"type": "command", "command": s[1]}
                out.append("ADDED\tstatusline\t%s" % s[1])
            elif cur.get("command") != s[1]:
                print("KEPT\tstatusline\tyou already have a status line (%s); left it" % cur.get("command"))
        elif cur and cur.get("command") == s[1]:
            del data["statusLine"]; out.append("REMOVED\tstatusline\t%s" % s[1])
changed = [o for o in out if not o.startswith("KEPT")]
if changed and dry != "1":
    if os.path.exists(path) and not os.path.exists(bkpath):
        os.makedirs(os.path.dirname(bkpath), exist_ok=True); shutil.copy2(path, bkpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp-knowledge-worker-stack"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False); f.write("\n")
    os.replace(tmp, path)
for o in out: print(o)
'
settings() {  # settings <part> add|remove < spec
  local p=$1 mode=$2 line kind out rc
  [ "$mode" = add ] && [ "$DRY" = 0 ] && [ ! -e "$SETTINGS" ] && rec "$p" newfile "$SETTINGS"
  out=$(python3 -c "$SETTINGS_PY" "$SETTINGS" "$mode" "$DRY" "$BK/.claude/settings.json")
  rc=$?
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    kind=${line%%	*}
    case "$kind" in
      ERROR) warn "${line#*	}"; human "Fix ~/.claude/settings.json (it is not valid JSON; a backup is in ~/knowledge-worker-stack-backups/install/), then run ./install.sh again." ;;
      KEPT) warn "${line##*	}" ;;
      ADDED) act "settings.json: $(printf '%s' "${line#ADDED	}" | tr '\t' ' ')"; rec "$p" setting "$(printf '%s' "${line#ADDED	}" | tr '\t' '\037')" ;;
      REMOVED) say "  - settings.json: $(printf '%s' "${line#REMOVED	}" | tr '\t' ' ')" ;;
    esac
  done <<EOF
$out
EOF
  return $rc
}

# ---- LaunchAgents ---------------------------------------------------------------------------------
loaded() { launchctl print "gui/$UIDN/$1" >/dev/null 2>&1; }
agent() {  # agent <part> <label> <plist text>: write, lint, load; reload only when it changed
  local p=$1 label=$2 text=$3 f="$LA/$2.plist" new=0
  if [ -f "$f" ] && [ "$(cat "$f")" = "$text" ]; then
    :
  else
    new=1
    if [ -f "$f" ]; then act "update $(short "$f")"; else act "add $(short "$f")"; fi
    if [ "$DRY" = 0 ]; then
      bk "$f"; mkparents "$p" "$LA"
      if [ ! -f "$f" ]; then
        rec "$p" agent "$label"
        printf '%s\n' "$text" | sed -n 's|.*<key>Standard[A-Za-z]*Path</key>[[:space:]]*<string>\(.*\)</string>.*|\1|p; /<key>Standard[A-Za-z]*Path<\/key>$/{n;s|.*<string>\(.*\)</string>.*|\1|p;}' |
          sort -u | while IFS= read -r lg; do rec "$p" log "$lg"; done
      fi
      printf '%s\n' "$text" > "$f"
      # launchd does not create a log's folder; a job whose log folder is missing never starts
      printf '%s\n' "$text" | sed -n 's|.*<string>\(.*/Library/Logs/[^<]*\)/[^/<]*</string>.*|\1|p' | sort -u |
        while IFS= read -r ld; do mkparents "$p" "$ld"; done
      plutil -lint "$f" >/dev/null || { warn "$(short "$f") failed plutil -lint; not loaded"; return 1; }
    fi
  fi
  if ! loaded "$label"; then
    act "launchctl bootstrap $label"
    [ "$DRY" = 1 ] || launchctl bootstrap "gui/$UIDN" "$f" || warn "could not load $label"
  elif [ "$new" = 1 ]; then
    if [ "$label" = local.herdr.server ]; then
      warn "herdr's server job changed; it takes effect at your next login (reloading it now would close every herdr pane)"
    else
      act "reload $label"
      [ "$DRY" = 1 ] || { launchctl bootout "gui/$UIDN/$label" 2>/dev/null; launchctl bootstrap "gui/$UIDN" "$f" || warn "could not load $label"; }
    fi
  fi
  return 0
}
PH='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'

# ---- herdr config ---------------------------------------------------------------------------------
HCONF="$HOME/.config/herdr/config.toml"
herdr_reload() { [ "$DRY" = 1 ] && return 0; command -v herdr >/dev/null && herdr server reload-config >/dev/null 2>&1; return 0; }
key_grid() {
  add_block "$1" "$HCONF" 'ctrl+alt+g' herdr-key-grid "
[[keys.command]]
key = \"ctrl+alt+g\"
type = \"shell\"
command = \"PATH=$HOME/bin:${BREWP:-/opt/homebrew}/bin:/usr/bin:/bin $HOME/bin/herdr_session_grid.py go\""
}
key_chief() {
  add_block "$1" "$HCONF" 'ctrl+alt+c' herdr-key-chief "
[[keys.command]]
key = \"ctrl+alt+c\"
type = \"shell\"
command = \"$HOME/bin/claude_chief_of_staff_go.sh\""
}

# ===================================================================================================
c_secret_dialog() {
  put secret-dialog "$REPO/secret-dialog/ask_secret.sh" "$HOME/bin/ask_secret.sh" 755
  path_line
}

c_vault() {
  brew_get vault cask keepassxc || return 1
  put vault "$REPO/vault/agent_get_credential" "$HOME/bin/agent_get_credential" 755
  path_line
  local db="$HOME/agent-vault/agent-vault.kdbx" key="$HOME/.config/agent-vault/agent-vault.keyx"
  mkd vault 700 "$HOME/agent-vault" "$HOME/.config/agent-vault"
  if [ -e "$db" ] && [ -e "$key" ]; then return 0; fi
  if [ -e "$db" ] || [ -e "$key" ]; then
    warn "only one of $(short "$db") and $(short "$key") exists; left both alone"
    human "Find the missing half of the agent vault ($(short "$db") + $(short "$key")) or move the other aside, then run ./install.sh --only vault."
    return 1
  fi
  act "create the empty agent vault (key file, no password)"
  [ "$DRY" = 1 ] && return 0
  if ! command -v keepassxc-cli >/dev/null || ! keepassxc-cli db-create -q --set-key-file "$key" "$db" </dev/null; then
    warn "keepassxc-cli could not create the vault"
    human "Open KeePassXC once from Applications (click Open if macOS asks), quit it, then run ./install.sh --only vault."
    return 1
  fi
  chmod 600 "$key"
  rec vault data "$HOME/agent-vault" "$HOME/.config/agent-vault"
}

c_browser_macos() {
  local V=v24.22.0 A=darwin-arm64 AB="$HOME/agent-browser"
  [ "$(uname -m)" = x86_64 ] && A=darwin-x64
  if [ ! -d "$AB" ]; then   # the whole folder is this part's: node, node_modules, state, captures
    act "create folder ~/agent-browser"
    [ "$DRY" = 1 ] || { mkdir -p "$AB" && rec browser-macos tree "$AB"; }
  fi
  if ! { [ -x "$AB/node" ] && [ "$("$AB/node" -e 'console.log(process.version, require(process.env.HOME + "/agent-browser/node_modules/ws/package.json").version)' 2>/dev/null)" = "$V 8.21.3" ]; }; then
    act "install Node.js $V and ws 8.21.3 into ~/agent-browser (from nodejs.org, checksum verified)"
    if [ "$DRY" = 0 ]; then
      local t; t=$(mktemp -d)
      if curl -sfo "$t/n.tar.xz" "https://nodejs.org/dist/$V/node-$V-$A.tar.xz" &&
         (cd "$t" && curl -sf "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-$A.tar.xz$" | sed "s/node-$V-$A.tar.xz/n.tar.xz/" | shasum -a 256 -c >/dev/null) &&
         tar -xf "$t/n.tar.xz" -C "$t" &&
         install -m 755 "$t/node-$V-$A/bin/node" "$AB/node" &&
         PATH="$t/node-$V-$A/bin:$PATH" npm_config_cache="$t/npm-cache" npm install --prefix "$AB" --no-save --no-package-lock --no-audit --no-fund --no-update-notifier ws@8.21.3 >/dev/null; then
        rm -r "$t"
      else
        rm -r "$t"; warn "Node.js download or check failed"; return 1
      fi
    fi
  fi
  put browser-macos "$REPO/browser/browse.js" "$AB/browse.js" 644
  put browser-macos "$REPO/browser/macos/browse-run-one-at-a-time-macos.sh" "$AB/browse" 755
  put browser-macos "$REPO/browser/macos/browse-start-chromium-with-port-macos.sh" "$AB/browse-start-chromium-with-port-macos.sh" 755
  put browser-macos "$REPO/browser/macos/macOS_open_chromium_no_focus_steal.sh" "$HOME/bin/macOS_open_chromium_no_focus_steal.sh" 755
  mkd browser-macos 755 "$HOME/bin" "$AB/state"
  if [ "$(readlink "$HOME/bin/browse" 2>/dev/null)" != "$AB/browse" ]; then
    act "link ~/bin/browse -> ~/agent-browser/browse"
    if [ "$DRY" = 0 ]; then
      if [ -e "$HOME/bin/browse" ] || [ -L "$HOME/bin/browse" ]; then bk "$HOME/bin/browse"; rec browser-macos replaced "$HOME/bin/browse" "$BK/bin/browse"; else rec browser-macos file "$HOME/bin/browse"; fi
      ln -sf "$AB/browse" "$HOME/bin/browse"
    fi
  fi
  path_line
  [ -d /Applications/Chromium.app ] || brew_get browser-macos cask ungoogled-chromium || return 1
  agent browser-macos local.agent-browser.chromium-port "$PH
<plist version=\"1.0\">
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
</plist>"
  if [ "$DRY" = 0 ] && [ -d /Applications/Chromium.app ]; then
    local i=0; until curl -s -m 2 -o /dev/null http://127.0.0.1:9222/json/version; do
      i=$((i+1)); [ $i -ge 10 ] && { human "Chromium: open it once from Applications (click Open if macOS asks), then quit it with Cmd+Q. The agent then runs ~/agent-browser/browse-start-chromium-with-port-macos.sh, which starts it with the port browse needs."; break; }; sleep 1
    done
  fi
}

ORB_VM_BUILD='set -e
cd /root/browser
export DEBIAN_FRONTEND=noninteractive
if ! command -v google-chrome-stable >/dev/null; then
  apt update && apt install -y wget ca-certificates
  install -d -m 0755 /etc/apt/keyrings
  wget -qO /etc/apt/keyrings/google-chrome.asc https://dl.google.com/linux/linux_signing_key.pub
  chmod 644 /etc/apt/keyrings/google-chrome.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt update && apt install -y google-chrome-stable
  rm /etc/apt/keyrings/google-chrome.asc
  apt update
fi
apt install -y nodejs node-ws xorg xserver-xorg-video-dummy xauth x11-xserver-utils openbox xdotool at-spi2-core gir1.2-atspi-2.0 python3-gi dbus-user-session iproute2 x11vnc
id browser >/dev/null 2>&1 || useradd -r -m -d /home/browser -s /usr/sbin/nologin browser
install -d -o browser -g browser /home/browser/browser-profiles /home/browser/browser-profiles/main /home/browser/Downloads /home/browser/agent-browser
loginctl enable-linger browser
runuser -u browser -- unshare --user echo ok
install -D -m 644 linux/xorg-dummy-display.conf /etc/X11/xorg.conf.d/10-dummy.conf
install -m 644 linux/xorg99.service linux/openbox.service /etc/systemd/system/
mkdir -p /root/.config/openbox
[ -f /root/.config/openbox/rc.xml ] || cp /etc/xdg/openbox/rc.xml /root/.config/openbox/rc.xml
sed -i "s|<number>4</number>|<number>1</number>|" /root/.config/openbox/rc.xml
install -m 644 linux/agent-browser-vnc-x11vnc.service /etc/systemd/system/agent-browser-vnc.service
install -d -m 700 /root/agent-browser
install -m 644 browse.js linux/browse-drive-native-browser-prompts.py /root/agent-browser/
install -m 755 linux/browse-atspi-as-browser-user.py /root/agent-browser/
install -m 755 linux/browse-run-one-at-a-time.sh /root/agent-browser/browse
install -o root -g root -m 755 linux/agent-browser-fix-session-restore.sh /home/browser/agent-browser/
install -D -m 644 linux/agent-browser-chrome-policy.json /etc/opt/chrome/policies/managed/agent-browser.json
sed "s/@UID@/$(id -u browser)/g" linux/agent-browser.service > /etc/systemd/system/agent-browser.service
node --check /root/agent-browser/browse.js
systemctl daemon-reload
systemctl enable --now xorg99.service openbox.service
[ -s /etc/x11vnc.pass ] && systemctl enable --now agent-browser-vnc.service
systemctl enable --now agent-browser.service
for i in $(seq 1 30); do wget -qO- http://127.0.0.1:9222/json/version >/dev/null 2>&1 && exit 0; sleep 2; done
echo "Chrome did not answer on 9222" >&2; exit 1'
orb_setup() {   # orb_setup <part> <key=value>...: OrbStack + the README's settings, restarted once if any changed
  local p=$1 kv k v cur todo=""; shift
  brew_get "$p" cask orbstack || return 1
  [ "$DRY" = 1 ] && ! command -v orbctl >/dev/null && { act "orbctl config set $*"; return 0; }
  command -v orbctl >/dev/null || { human "Open OrbStack once from Applications and finish its first window, then run ./install.sh --only $p again."; return 1; }
  cur=$(orbctl config show 2>/dev/null)
  for kv in "$@"; do
    k=${kv%%=*} v=${kv#*=}
    printf '%s\n' "$cur" | grep -qE "^$k: *$v\$" || todo="$todo $kv"
  done
  [ -z "$todo" ] && return 0
  for kv in $todo; do
    act "orbctl config set ${kv%%=*} ${kv#*=}"
    [ "$DRY" = 1 ] || orbctl config set "${kv%%=*}" "${kv#*=}" || return 1
  done
  act "restart OrbStack so the settings apply"
  [ "$DRY" = 1 ] || { orbctl stop; orbctl start; } || return 1
}
c_browser_orbstack() {
  orb_setup browser-orbstack setup.use_admin=false machines.expose_ports_to_lan=false docker.expose_ports_to_lan=false \
    docker.set_context=false machines.forward_ports=false app.start_at_login=true || return 1
  if ! orb list 2>/dev/null | grep -qw agent-browser; then
    act "create the OrbStack machine agent-browser (Debian, isolated, 8G memory, 4 CPUs, 32G disk)"
    if [ "$DRY" = 0 ]; then
      orb create --isolated --isolate-network --memory 8G --cpus 4 --disk 32G debian:trixie agent-browser || { warn "orb create failed"; return 1; }
      rec browser-orbstack machine agent-browser
    fi
  fi
  if [ "$DRY" = 1 ] || ! orb -m agent-browser -u root test -d /root/browser 2>/dev/null; then
    act "copy browser/ into the machine"
    [ "$DRY" = 1 ] || (cd "$REPO" && COPYFILE_DISABLE=1 tar -cf - browser | orb -m agent-browser -u root tar -xf - -C /root --no-same-owner) || return 1
  fi
  if [ "$DRY" = 0 ] && ! orb -m agent-browser -u root test -s /etc/x11vnc.pass 2>/dev/null; then
    act "set the VNC password (a dialog asks you; only the first 8 characters count)"
    "$HOME/bin/ask_secret.sh" "VNC password for the agent browser (the first 8 characters count)" |
      orb -m agent-browser -u root bash -c 'IFS= read -r p; [ -n "$p" ] && x11vnc -storepasswd "$p" /etc/x11vnc.pass >/dev/null 2>&1' ||
      warn "no VNC password set; the viewer step waits for it (run ./install.sh --only browser-orbstack again)"
  fi
  if [ "$DRY" = 1 ] || ! orb -m agent-browser -u root bash -c 'wget -qO- http://127.0.0.1:9222/json/version' >/dev/null 2>&1; then
    act "build the Linux browser setup inside the machine (browser/linux/README.md steps 2-8; several minutes)"
    [ "$DRY" = 1 ] || printf '%s\n' "$ORB_VM_BUILD" | orb -m agent-browser -u root bash -s || { warn "the build inside the machine failed"; return 1; }
  fi
  mkd browser-orbstack 700 "$HOME/.ssh"
  add_block browser-orbstack "$HOME/.ssh/config" 'Host agent-browser' ssh-agent-browser "Host agent-browser
  User root@agent-browser
  HostName 127.0.0.1
  Port 32222
  IdentityFile ~/.orbstack/ssh/id_ed25519
  IdentitiesOnly yes
  UserKnownHostsFile ~/.orbstack/ssh/known_hosts
  ServerAliveInterval 15
  ServerAliveCountMax 4"
  put browser-orbstack "$REPO/browser/linux/browse-over-ssh.sh" "$HOME/bin/browse" 755
  path_line
  human "Sign in to your sites in the agent's Chrome: the agent runs 'ssh -fN -L 5901:localhost:5900 agent-browser', then 'open vnc://localhost:5901' (macOS Screen Sharing; not yet tried with this server); you type the VNC password, sign in to each site and let Chrome save the password. Afterwards the agent closes the tunnel with: pkill -f 'ssh -fN -L 5901'"
}

c_herdr() {
  brew_get herdr formula herdr || return 1
  command -v jq >/dev/null || brew_get herdr formula jq || return 1
  mkd herdr 755 "$HOME/.claude/hooks" "$HOME/Library/Logs"
  mkd herdr 700 "$HOME/.claude/state"
  if [ "$DRY" = 1 ] && ! command -v herdr >/dev/null; then act "herdr integration install claude"
  elif ! herdr integration status 2>/dev/null | grep -q '^claude: current'; then
    act "herdr integration install claude"
    if [ "$DRY" = 0 ]; then
      bk "$SETTINGS"; [ -e "$SETTINGS" ] || rec herdr newfile "$SETTINGS"
      herdr integration install claude >/dev/null && rec herdr integration claude
    fi
  fi
  putmany herdr "$REPO/herdr" "$HOME/bin" 755 h cr hr claude_session_transcript.sh herdr_session_manage.sh herdr_session_record_live.sh \
    herdr_session_resolve_tab.py herdr_session_restore.py herdr_session_restart_and_restore.py herdr_session_snapshot.sh claude_exit_session.sh
  put herdr "$REPO/herdr/record-herdr-tab.sh" "$HOME/.claude/hooks/record-herdr-tab.sh" 755
  put herdr "$REPO/herdr/prompt-suggestion-misread-guard.py" "$HOME/.claude/hooks/prompt-suggestion-misread-guard.py" 644
  path_line
  local bp=${BREWP:-/opt/homebrew}
  agent herdr local.herdr.server "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>local.herdr.server</string>
  <key>ProgramArguments</key>
  <array><string>$bp/bin/herdr</string><string>server</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:$HOME/bin:$bp/bin:$bp/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_server.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_server.log</string>
</dict>
</plist>"
  settings herdr add <<EOF
hook${T}SessionStart${T}${T}~/.claude/hooks/record-herdr-tab.sh${T}
hook${T}PreToolUse${T}Bash${T}python3 ~/.claude/hooks/prompt-suggestion-misread-guard.py${T}5
allow${T}Bash(claude_exit_session.sh:*)
EOF
  local job name script every
  for job in record-live:herdr_session_record_live.sh:60 snapshot:herdr_session_snapshot.sh:3600; do
    IFS=: read -r name script every <<<"$job"
    agent herdr "local.herdr.$name" "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>local.herdr.$name</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/$script</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/bin:$bp/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartInterval</key><integer>$every</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_$name.log</string>
</dict>
</plist>"
  done
  if [ "$DRY" = 0 ] && [ -f "$HOME/.config/herdr/session.json" ] && [ ! -d "$HOME/knowledge-worker-stack-backups/herdr" ]; then
    act "first herdr backup"; "$HOME/bin/herdr_session_snapshot.sh" >/dev/null 2>&1 || warn "first herdr backup did not succeed; the hourly job retries"
  fi
  # herdr's settings: a top-level key goes first in the file, a [keys] table only if there is none.
  if ! grep -q '^onboarding' "$HCONF" 2>/dev/null; then
    act "add to $(short "$HCONF"): onboarding = false"
    if [ "$DRY" = 0 ]; then
      bk "$HCONF"; mkparents herdr "$(dirname "$HCONF")"; [ -e "$HCONF" ] || rec herdr newfile "$HCONF"
      { echo "onboarding = false"; if [ -s "$HCONF" ]; then echo; cat "$HCONF"; fi; } > "$HCONF.tmp-knowledge-worker-stack" && mv "$HCONF.tmp-knowledge-worker-stack" "$HCONF"
      rec herdr topline "$HCONF" "onboarding = false"
    fi
  fi
  add_block herdr "$HCONF" '[keys]' herdr-keys '
[keys]
previous_tab = ["prefix+p", "alt+shift+left"]     # a binding REPLACES the default key: keep it in the list
next_tab = ["prefix+n", "alt+shift+right"]
previous_workspace = "alt+up"
next_workspace = "alt+down"
previous_agent = "ctrl+alt+up"                    # walk the sidebar'"'"'s agent list
next_agent = "ctrl+alt+down"'
  [ -x "$HOME/bin/herdr_session_grid.py" ] && key_grid herdr
  [ -x "$HOME/bin/claude_chief_of_staff_go.sh" ] && key_chief herdr
  herdr_reload
}

c_starter_claude_md() {
  if [ -e "$HOME/.claude/CLAUDE.md" ]; then
    grep -qF 'agent_get_credential' "$HOME/.claude/CLAUDE.md" ||
      say "  ~/.claude/CLAUDE.md exists, so the starter was not copied (claude-code/CLAUDE.starter.md: merge by hand)"
    return 0
  fi
  put starter-claude-md "$REPO/claude-code/CLAUDE.starter.md" "$HOME/.claude/CLAUDE.md" 644
}

c_claude_code() {
  local cc="$REPO/claude-code" s
  command -v jq >/dev/null || brew_get claude-code formula jq || return 1
  mkd claude-code 755 "$HOME/bin"
  mkd claude-code 700 "$HOME/.claude/state"
  path_line
  putmany claude-code "$cc/hooks" "$HOME/.claude/hooks" 755 tag-session-account.sh date-prefix-title.sh
  putmany claude-code "$cc/hooks" "$HOME/.claude/hooks" 755 pin-task-list-to-session.py restart-in-skip-mode-on-skip.sh \
    keep-skip-mode-across-resume.py session-prime-directive.py git-commit-pathspec-guard.py settings-silent-deny-explainer.py \
    load-context-md-chain.py load-progressive-discovery-command-context.py
  put claude-code "$cc/statusline.py" "$HOME/.claude/statusline.py" 644
  for s in retitle successor loose-ends prime-directive bro; do put claude-code "$cc/skills/$s/SKILL.md" "$HOME/.claude/skills/$s/SKILL.md" 644; done
  put claude-code "$cc/skills/wait-what/SKILL.md" "$HOME/.claude/skills/wait-what/SKILL.md" 644
  put claude-code "$cc/skills/wait-what/agents/openai.yaml" "$HOME/.claude/skills/wait-what/agents/openai.yaml" 644
  put claude-code "$cc/skills/wait-what/LICENSE" "$HOME/.claude/skills/wait-what/LICENSE" 644
  put claude-code "$cc/output-styles/rundown.md" "$HOME/.claude/output-styles/rundown.md" 644
  mkd claude-code 755 "$HOME/.claude/command-context"
  local st; for st in state_claude_cache_which_context_md_files_loaded.json state_claude_cache_which_progressive_discovery_tool_rules_loaded.json \
    state_claude_cache_command_context_markdown_index.json state_claude_memory_snapshot.log; do rec claude-code state "$HOME/.claude/state/$st"; done
  putmany claude-code "$cc/bin" "$HOME/bin" 755 claude_successor_read_state.sh claude_successor_first_prompt.py claude_successor_skill_handover.sh \
    claude_successor_retire_predecessor.sh claude_copy_task_list_to_successor.py claude_auto_successor.sh claude_session_lineage_latest.py \
    claude_restart_session.sh claude_session_prime_directive.sh \
    claude_fix_status_line_lost_on_scroll.py claude_continue_after_connection_loss.sh claude_memory_snapshot.sh agent_copy_to_clipboard
  settings claude-code add <<EOF
hook${T}SessionStart${T}${T}bash ~/.claude/hooks/tag-session-account.sh${T}5
statusline${T}python3 ~/.claude/statusline.py
outputstyle${T}Rundown
hook${T}UserPromptSubmit${T}${T}bash ~/.claude/hooks/date-prefix-title.sh${T}10
hook${T}SessionStart${T}${T}python3 ~/.claude/hooks/pin-task-list-to-session.py${T}10
allow${T}Bash(claude_successor_retire_predecessor.sh:*)
hook${T}UserPromptSubmit${T}${T}date '+Now: %Y-%m-%d %H:%M %Z (%a)'${T}5
hook${T}UserPromptSubmit${T}${T}bash ~/.claude/hooks/restart-in-skip-mode-on-skip.sh${T}20
hook${T}SessionStart${T}${T}python3 ~/.claude/hooks/keep-skip-mode-across-resume.py${T}10
hook${T}UserPromptSubmit${T}${T}python3 ~/.claude/hooks/session-prime-directive.py${T}5
hook${T}PreToolUse${T}Bash${T}python3 ~/.claude/hooks/git-commit-pathspec-guard.py${T}10
hook${T}PreToolUse${T}Bash${T}python3 ~/.claude/hooks/settings-silent-deny-explainer.py${T}5
hook${T}PostToolUse${T}Read${T}python3 ~/.claude/hooks/load-context-md-chain.py${T}5
hook${T}PreToolUse${T}Write|Edit|MultiEdit${T}python3 ~/.claude/hooks/load-context-md-chain.py${T}5
hook${T}PreToolUse${T}Bash${T}python3 ~/.claude/hooks/load-progressive-discovery-command-context.py${T}10
key${T}cleanupPeriodDays${T}36500
key${T}idleCompaction${T}false
EOF
  local bp=${BREWP:-/opt/homebrew}
  agent claude-code local.knowledge-worker-stack.claude-auto-successor "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-auto-successor</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_auto_successor.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/bin:$HOME/.local/bin:$bp/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>600</integer>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_auto_successor_launchd.log</string>
</dict>
</plist>"
  agent claude-code local.knowledge-worker-stack.claude-continue "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-continue</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_continue_after_connection_loss.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_continue_after_connection_loss_launchd.log</string>
</dict>
</plist>"
  local first=0; [ -f "$LA/local.knowledge-worker-stack.claude-memory-snapshot.plist" ] || first=1
  agent claude-code local.knowledge-worker-stack.claude-memory-snapshot "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-memory-snapshot</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/bin/claude_memory_snapshot.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/knowledge-worker-stack/claude_memory_snapshot_launchd.log</string>
</dict>
</plist>"
  if [ "$first" = 1 ] && [ "$DRY" = 0 ]; then
    act "first memory backup"; "$HOME/bin/claude_memory_snapshot.sh" >/dev/null 2>&1 || warn "first memory backup did not succeed; the hourly job retries"
  fi
}

c_model_sync() {
  put model-sync "$REPO/claude-code/bin/claude_model_picker_sync.py" "$HOME/bin/claude_model_picker_sync.py" 755
  mkd model-sync 700 "$HOME/.claude/state"
  agent model-sync local.knowledge-worker-stack.claude-model-picker-sync "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>local.knowledge-worker-stack.claude-model-picker-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/python3</string>
    <string>$HOME/bin/claude_model_picker_sync.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>10800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.claude/state/state_claude_model_picker_sync.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.claude/state/state_claude_model_picker_sync.log</string>
</dict>
</plist>"
  ls "$HOME"/.claude*/.oauth_token >/dev/null 2>&1 ||
    human "The model-list sync only does something under the token sign-in (claude-code/README.md piece 1); set that up, or remove this part with ./install.sh --uninstall --only model-sync."
}

c_google() {
  brew_get google formula googleworkspace-cli || return 1    # not `gws`: Homebrew's gws is a different program
  put google "$REPO/google/g" "$HOME/bin/g" 755
  put google "$REPO/google/gmail_message_to_pdf.py" "$HOME/bin/gmail_message_to_pdf.py" 755
  path_line
  mkd google 700 "$HOME/.config/gws"
  rec google signin "$HOME/.config/gws"
  # Its rules reach a session the first time it runs g or gws (claude-code piece 18), not every session.
  put google "$REPO/google/command-context-google.md" "$HOME/.claude/command-context/google.md" 644
  [ -f "$HOME/.claude/hooks/load-progressive-discovery-command-context.py" ] || { [ "$DRY" = 1 ] && in_sel claude-code; } ||
    warn "the rules in ~/.claude/command-context/google.md load only with claude-code's tool-rules hook: install the claude-code part"
  if [ "$DRY" = 0 ] && ! gws auth status 2>/dev/null | grep -q '"encrypted_credentials_exists": *true'; then
    human "Google: in the browser, signed in to the account Claude will use, do google/README.md 'One-time Google setup' steps 1-4 (create project, enable APIs, consent screen: Internal for a Workspace account, External plus yourself as a test user for @gmail.com, Desktop client, Download JSON); the agent does step 5 and starts step 6, you pick your account and click Allow."
  fi
}

c_office() {
  command -v uv >/dev/null || brew_get office formula uv || return 1
  # Both in one folder: the cache tool imports the surgery module from beside itself.
  put office "$REPO/office/agent_xlsx_surgery.py" "$HOME/bin/agent_xlsx_surgery.py" 644
  put office "$REPO/office/agent_xlsx_formula_cache.py" "$HOME/bin/agent_xlsx_formula_cache.py" 755
  path_line
}

c_grid() {
  local g="$REPO/herdr/grid" bp=${BREWP:-/opt/homebrew}
  putmany grid "$g" "$HOME/bin" 755 herdr_session_grid.py herdr_session_bookmarks.py claude_session_lineage_delete_or_archive.py
  put grid "$g/hg.sh" "$HOME/bin/hg.sh" 644
  path_line
  add_line grid "$HOME/.zshrc" 'bin/hg.sh' 'source "$HOME/bin/hg.sh"'
  key_grid grid
  herdr_reload
  agent grid local.herdr.grid-ensure "$PH
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>local.herdr.grid-ensure</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/herdr_session_grid.py</string><string>ensure</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/bin:$bp/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/herdr_grid-ensure.log</string>
</dict>
</plist>"
}

c_mattermost() {
  orb_setup mattermost setup.use_admin=false docker.expose_ports_to_lan=false machines.expose_ports_to_lan=false \
    docker.set_context=false app.start_at_login=true || return 1
  add_block mattermost "$HOME/.zshrc" 'orbstack/run/docker.sock' zshrc-docker-orbstack '# Docker: OrbStack'"'"'s CLI and engine, without changing the default Docker context
export PATH="$HOME/.orbstack/bin:$PATH" DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"'
  export PATH="$HOME/.orbstack/bin:$PATH" DOCKER_HOST="unix://$HOME/.orbstack/run/docker.sock"
  mkd mattermost 755 "$HOME/mattermost"
  put mattermost "$REPO/comms/mattermost/docker-compose.yml" "$HOME/mattermost/docker-compose.yml" 644
  if [ ! -f "$HOME/mattermost/.env" ]; then
    act "generate the database password into ~/mattermost/.env (never shown)"
    [ "$DRY" = 1 ] || { (umask 077; echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" > "$HOME/mattermost/.env") && rec mattermost data "$HOME/mattermost"; }
  fi
  [ -f "$CFG/mattermost.env" ] || human "Mattermost: open http://localhost:8065, create your account (the first one is the admin) and a team, then tell the agent your username and the team's URL name."
  if curl -fs http://localhost:8065/api/v4/system/ping >/dev/null 2>&1; then return 0; fi
  act "docker compose up -d (Mattermost + PostgreSQL), then wait for it to answer"
  [ "$DRY" = 1 ] && return 0
  docker compose -f "$HOME/mattermost/docker-compose.yml" up -d || { warn "docker compose up failed"; return 1; }
  rec mattermost compose "$HOME/mattermost/docker-compose.yml"
  local i=0
  until curl -fs http://localhost:8065/api/v4/system/ping >/dev/null 2>&1; do
    i=$((i+1)); [ $i -gt 120 ] && { warn "Mattermost did not answer within 10 minutes"; return 1; }; sleep 5
  done
}

c_comms() {
  local c="$REPO/comms" f changed=$CHANGES
  mkd comms 755 "$HOME/bin"
  mkd comms 700 "$HOME/.claude/state"
  putmany comms "$c" "$HOME/bin" 755 claude_frontdesk.py claude_frontdesk_checks.py mattermost_post.py priorities.py \
    $(cd "$c" && ls claude_chief_of_staff_*.py claude_chief_of_staff_*.sh)
  put comms "$c/chief-of-staff-nothing-waiting-guard.py" "$HOME/.claude/hooks/chief-of-staff-nothing-waiting-guard.py" 644
  put comms "$c/watch-use-frontdesk-guard.py" "$HOME/.claude/hooks/watch-use-frontdesk-guard.py" 644
  [ -f "$HOME/.claude/chief-of-staff.md" ] || put comms "$c/chief-of-staff.md" "$HOME/.claude/chief-of-staff.md" 644
  path_line
  if [ "$CHANGES" != "$changed" ] || [ ! -f "$CFG/frontdesk_checks.sha256.json" ]; then
    act "claude_frontdesk.py pin (records the check files as reviewed)"
    if [ "$DRY" = 0 ]; then
      [ -f "$CFG/frontdesk_checks.sha256.json" ] || rec comms file "$CFG/frontdesk_checks.sha256.json"
      "$HOME/bin/claude_frontdesk.py" pin >/dev/null || warn "pin failed"
    fi
  fi
  rec comms data "$CFG/priorities.json"   # the Priorities list: the chief writes it, uninstall keeps it
  rec comms secretfile "$HOME/.claude/state/state_claude_frontdesk_router.jsonl" "who wrote to you, and about what"
  rec comms secretdir "$HOME/.claude/state/state_claude_frontdesk" "watchers and the messages they fired on"
  rec comms secretdir "$CFG/outlook" "saved sign-ins"
  rec comms state "$HOME/.claude/state/state_claude_session_frontdesk_nudged.json"   # the watch hook's once-per-session memory
  settings comms add <<EOF
hook${T}Stop${T}${T}python3 "\$HOME/.claude/hooks/chief-of-staff-nothing-waiting-guard.py"${T}
hook${T}PreToolUse${T}Bash|CronCreate|Monitor${T}python3 "\$HOME/.claude/hooks/watch-use-frontdesk-guard.py"${T}5
EOF
  agent comms local.knowledge-worker-stack.claude-frontdesk "$PH
<plist version=\"1.0\"><dict>
  <key>Label</key><string>local.knowledge-worker-stack.claude-frontdesk</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>-I</string><string>$HOME/bin/claude_frontdesk.py</string><string>run</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardErrorPath</key><string>$HOME/.claude/state/state_claude_frontdesk.log</string>
</dict></plist>"
  agent comms local.knowledge-worker-stack.claude-chief-of-staff-wake "$PH
<plist version=\"1.0\"><dict>
  <key>Label</key><string>local.knowledge-worker-stack.claude-chief-of-staff-wake</string>
  <key>ProgramArguments</key><array><string>$HOME/bin/claude_chief_of_staff_wake.sh</string></array>
  <key>StartCalendarInterval</key><array>
$(for h in $(seq 9 17); do echo "    <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"; done)
  </array>
  <key>Umask</key><integer>63</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_wake.log</string>
</dict></plist>"
  key_chief comms
  herdr_reload
}

in_sel() { case " $SEL " in *" $1 "*) return 0 ;; esac; return 1; }
after_comms() {  # after_comms <file comms installs>: a dry run that also installs comms counts it as there
  [ -x "$1" ] || { [ "$DRY" = 1 ] && in_sel comms; } || { warn "install comms first"; return 1; }
}
IMX="$HOME/.claude/state/state_claude_frontdesk_imessage_export.json"
# Working = the export exists and the job's last run exited 0; an empty file is fine (no recent incoming text).
# launchd creates the file even when sqlite3 is refused, so existence alone does not prove the grant.
imessage_ok() { [ -e "$IMX" ] && launchctl print "gui/$UIDN/local.knowledge-worker-stack.imessage-export" 2>/dev/null | grep -q 'last exit code = 0'; }

c_imessage() {
  after_comms "$HOME/bin/claude_frontdesk.py" || return 1
  mkd imessage 700 "$HOME/.claude/state"
  local first=0; [ -f "$LA/local.knowledge-worker-stack.imessage-export.plist" ] || first=1
  agent imessage local.knowledge-worker-stack.imessage-export "$PH
<plist version=\"1.0\"><dict>
  <key>Label</key><string>local.knowledge-worker-stack.imessage-export</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/sqlite3</string><string>-readonly</string><string>-json</string>
    <string>$HOME/Library/Messages/chat.db</string>
    <string>SELECT m.guid AS key, m.date / 1000000 + 978307200000 AS ts, COALESCE(h.id, '') AS frm, NULLIF(m.text, '') AS body, CASE WHEN COALESCE(m.text, '') = '' THEN hex(m.attributedBody) END AS rich, COALESCE(NULLIF(c.display_name, ''), CASE WHEN c.style = 43 THEN (SELECT group_concat(h2.id, ', ') FROM chat_handle_join x JOIN handle h2 ON h2.ROWID = x.handle_id WHERE x.chat_id = c.ROWID) END, c.chat_identifier, h.id, '') AS thread FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id WHERE m.is_from_me = 0 AND m.item_type = 0 AND m.associated_message_type = 0 AND m.ROWID &gt; (SELECT MAX(ROWID) FROM message) - 300 GROUP BY m.ROWID ORDER BY m.ROWID</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>$HOME/.claude/state/state_claude_frontdesk_imessage_export.json</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/imessage-export.log</string>
</dict></plist>"
  rec imessage secretfile "$IMX" "your incoming texts"     # after agent(): uninstall deletes it before stashing logs
  if [ "$DRY" = 0 ] && ! imessage_ok; then
    [ "$first" = 1 ] && open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles" 2>/dev/null
    human "iMessage: in the Full Disk Access list ($([ "$first" = 1 ] && echo "now open in System Settings" || echo "System Settings > Privacy & Security > Full Disk Access")), click +, press Cmd+Shift+G, type /usr/bin/sqlite3, press Return, click Open and switch it on (this lets any program you run read protected data through sqlite3; see comms/email-texts-and-router.md). A minute later the agent runs ./install.sh --only imessage, which says whether it is reading messages."
  fi
}

c_phone_bridge() {
  local b="$HOME/bin/claude_chief_of_staff_phone_bridge.py"
  after_comms "$b" || return 1
  if [ ! -f "$CFG/mattermost.env" ]; then
    human "Phone bridge: finish Mattermost first (your account and team at http://localhost:8065), have the agent write ~/.config/knowledge-worker-stack/mattermost.env (comms/mattermost/README.md step 3), then run ./install.sh --only phone-bridge."
    return 1
  fi
  if ! agent_get_credential list 2>/dev/null | grep -qx 'Mattermost bot'; then
    act "create the Mattermost bot and put its token in the vault ($(short "$b") --setup)"
    [ "$DRY" = 1 ] || "$b" --setup || { warn "bot setup failed"; return 1; }
  fi
  if ! loaded local.knowledge-worker-stack.claude-chief-of-staff-phone-bridge; then
    act "phone bridge check (posts one test line to your Mattermost DM)"
    [ "$DRY" = 1 ] || "$b" --check || { warn "the bridge check failed; not started"; return 1; }
  fi
  agent phone-bridge local.knowledge-worker-stack.claude-chief-of-staff-phone-bridge "$PH
<plist version=\"1.0\"><dict>
  <key>Label</key><string>local.knowledge-worker-stack.claude-chief-of-staff-phone-bridge</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>-I</string><string>$HOME/bin/claude_chief_of_staff_phone_bridge.py</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/knowledge-worker-stack/claude_chief_of_staff_phone_bridge.log</string>
</dict></plist>"
}

# ===================================================================================================
# Uninstall: undo the record, newest first, for the chosen parts. Shared lines (the ~/bin PATH line)
# go only when everything is uninstalled.
UB="$HOME/knowledge-worker-stack-backups/uninstall-$TS"
stash() { # move a file we added out of the way, into the uninstall backup
  local f=$1 d="$UB/${1#$HOME/}"
  { [ -e "$f" ] || [ -L "$f" ]; } || return 0
  say "  - $(short "$f")"
  [ "$DRY" = 1 ] && return 0
  mkdir -p "$(dirname "$d")" && mv "$f" "$d"
}
TEXT_RM_PY='
import sys
f, text, top = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
s = open(f).read()
if top:
    lines = s.split("\n")
    if lines and lines[0] == text:
        lines = lines[1:]
        if lines and lines[0] == "": lines = lines[1:]
    out = "\n".join(lines)
else:
    t = text if text.endswith("\n") else text + "\n"
    i = s.rfind(t)
    out = s if i < 0 else s[:i] + s[i + len(t):]
if out != s: open(f, "w").write(out); print("removed")
'
text_rm() {  # text_rm <file> <text> <top 0|1>
  [ -f "$1" ] || return 0
  say "  - from $(short "$1"): $(printf '%s' "$2" | sed -n '/./{p;q;}')"
  [ "$DRY" = 1 ] && return 0
  local d="$UB/${1#$HOME/}"; [ -e "$d" ] || { mkdir -p "$(dirname "$d")"; cp -p "$1" "$d"; }
  python3 -c "$TEXT_RM_PY" "$1" "$2" "$3" >/dev/null
}
edited() {  # edited <file> <md5 at install>: true when a regular file no longer matches what was installed
  [ -f "$1" ] && [ ! -L "$1" ] && [ -n "$2" ] && [ "$(md5 -q "$1")" != "$2" ]
}
uninstall() {
  [ -f "$REC" ] || { say "Nothing to undo: $(short "$REC") does not exist."; exit 0; }
  local keep="" lines p kind a b retry=""
  [ "$FULL" = 1 ] && [ -d "$HOME/Library/Logs/knowledge-worker-stack" ] && stash "$HOME/Library/Logs/knowledge-worker-stack"
  lines=$(tail -r "$REC")
  while IFS="$T" read -r -u 3 p kind a b; do
    [ -z "$p" ] && continue
    if [ "$p" = common ]; then [ "$FULL" = 1 ] || { keep="$keep$p$T$kind$T$a$T$b
"; continue; }
    else case " $SEL " in *" $p "*) ;; *) keep="$keep$p$T$kind$T$a$T$b
"; continue ;; esac; fi
    case "$kind" in
      file) if edited "$a" "$b"; then say "  kept $(short "$a"): changed since it was installed"; else stash "$a"; fi ;;
      replaced)
        local bkp=${b%%"$US"*} sum=${b#*"$US"}
        if edited "$a" "$sum"; then say "  kept $(short "$a"): changed since it was installed (what was there before is in $(short "$bkp"))"
        else stash "$a"; say "  ↩ $(short "$a") put back from $(short "$bkp")"; [ "$DRY" = 1 ] || cp -pR "$bkp" "$a"; fi ;;
      dir) [ "$DRY" = 1 ] || rmdir "$a" 2>/dev/null || retry="$retry
$a" ;;
      tree) stash "$a" ;;
      newfile) if [ "$a" = "$SETTINGS" ]; then
                 [ -f "$a" ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if set(d) <= {"hooks"} and not any(d.get("hooks", {}).values()) else 1)' "$a" 2>/dev/null && stash "$a"
               else [ -f "$a" ] && ! grep -q '[^[:space:]]' "$a" && stash "$a"; fi ;;
      log) stash "$a" ;;
      state) stash "$a"; stash "$a.lock" ;;   # a cache or log the tools write; harmless to lose
      secretdir) [ -d "$a" ] && { say "  - $(short "$a") (${b:-saved sign-ins}: deleted rather than backed up)"; [ "$DRY" = 1 ] || rm -r "$a"; } ;;
      secretfile) [ -e "$a" ] && { say "  - $(short "$a") (${b:-private}: deleted rather than backed up)"; [ "$DRY" = 1 ] || rm -f "$a"; } ;;
      signin) say "  you: run   gws auth logout   then remove the app's access at https://myaccount.google.com/connections" ;;
      line) text_rm "$a" "$b" 0 ;;
      topline) text_rm "$a" "$b" 1 ;;
      block) text_rm "$a" "$(cat "$BLOCKS/$b" 2>/dev/null)" 0; [ "$DRY" = 1 ] || rm -f "$BLOCKS/$b" ;;
      setting)
        local sk ev m cmd
        IFS="$US" read -r sk ev m cmd _ <<<"$a"
        case "$sk" in
          hook) printf 'hook\t%s\t%s\t%s\t\n' "$ev" "$m" "$cmd" | settings "$p" remove ;;
          allow) printf 'allow\t%s\n' "$ev" | settings "$p" remove ;;
          statusline) printf 'statusline\t%s\n' "$ev" | settings "$p" remove ;;
          outputstyle) printf 'outputstyle\t%s\n' "$ev" | settings "$p" remove ;;
          key) printf 'key\t%s\t%s\n' "$ev" "$m" | settings "$p" remove ;;
        esac ;;
      agent)
        local f="$LA/$a.plist"
        if [ "$a" = local.herdr.server ] && launchctl print "gui/$UIDN/$a" 2>/dev/null | grep -q 'pid = '; then
          say "  herdr's server is running: left running (stopping it closes every pane); it does not start again after logout"
        else
          say "  - launchctl bootout $a"; [ "$DRY" = 1 ] || launchctl bootout "gui/$UIDN/$a" 2>/dev/null
        fi
        stash "$f"
        [ "$a" = local.knowledge-worker-stack.imessage-export ] && say "  you: switch /usr/bin/sqlite3 off in System Settings > Privacy & Security > Full Disk Access" ;;
      integration) say "  - herdr integration uninstall claude"; [ "$DRY" = 1 ] || herdr integration uninstall claude >/dev/null 2>&1 ;;
      compose) say "  - docker compose down (messages and files kept in Docker's volumes)"; [ "$DRY" = 1 ] || docker compose -f "$a" down ;;
      brew) say "  kept $b (Homebrew): remove with   brew uninstall $a $b   if nothing else uses it" ;;
      data) [ -e "$a" ] && say "  kept your data: $(short "$a")${b:+ and $(short "$b")} (delete by hand once backed up)" ;;
      machine) say "  kept the OrbStack machine $a and its logins: delete with   orb delete -f $a" ;;
    esac
  done 3<<EOF
$lines
EOF
  [ "$DRY" = 1 ] && return 0
  if [ -n "$keep" ]; then printf '%s' "$keep" | tail -r > "$REC"; else rm -f "$REC"; rmdir "$BLOCKS" "$CFG" 2>/dev/null; fi
  printf '%s\n' "$retry" | while IFS= read -r a; do [ -n "$a" ] && rmdir "$a" 2>/dev/null; done   # folders emptied only now
  [ -d "$UB" ] && say "Removed files are in $(short "$UB")."
}

# ===================================================================================================
verify() {
  local c ok=1 lbl
  say ""; say "Checks:"
  chk() { if eval "$2" >/dev/null 2>&1; then say "  ok   $1"; else say "  FAIL $1"; ok=0; fi; }
  for c in $SEL; do case "$c" in
    secret-dialog) chk "ask_secret.sh installed" '[ -x "$HOME/bin/ask_secret.sh" ]' ;;
    vault) chk "vault and key file in place" '[ -f "$HOME/agent-vault/agent-vault.kdbx" ] && [ "$(stat -f %Lp "$HOME/.config/agent-vault/agent-vault.keyx")" = 600 ]'
           chk "agent_get_credential list" 'agent_get_credential list' ;;
    browser-macos) chk "browse answers (usage line)" '"$HOME/bin/browse" 2>&1 | grep -q "usage: browse"'
                   chk "Chromium port job loaded" 'loaded local.agent-browser.chromium-port'
                   chk "Chromium answers on port 9222" 'curl -s -m 2 http://127.0.0.1:9222/json/version' ;;
    browser-orbstack) chk "ssh agent-browser" 'ssh -o BatchMode=yes -o ConnectTimeout=5 agent-browser hostname' ;;
    herdr) chk "herdr --version" 'herdr --version'
           for lbl in server record-live snapshot; do chk "LaunchAgent local.herdr.$lbl loaded" "loaded local.herdr.$lbl"; done
           chk "herdr's Claude Code integration" 'herdr integration status | grep -q "^claude: current"'
           chk "'h' is this script, not an alias, in zsh" '[ "$(HOME="$HOME" zsh -ic "whence -w h" </dev/null 2>/dev/null)" = "h: command" ]' ;;
    google) chk "gws --version" 'gws --version'
            chk "g --help" '"$HOME/bin/g" --help'
            lbl=$(HOME="$HOME" zsh -ic "whence -w g" </dev/null 2>/dev/null)
            case "$lbl" in
              "g: command") say "  ok   'g' is this script, not an alias, in zsh" ;;
              "g: alias"|"g: function") say "  FAIL 'g' in zsh is ${lbl#g: }, not this script"; ok=0
                human "In zsh, g is an alias or function (oh-my-zsh's git plugin sets alias g=git), so the agent's g would run something else. Add this line at the end of ~/.zshrc, then open a new Terminal window:   unalias g 2>/dev/null; unfunction g 2>/dev/null" ;;
              *) say "  FAIL 'g' not found in a new zsh (${lbl:-zsh did not answer})"; ok=0 ;;
            esac ;;
    office) chk "uv --version" 'uv --version'
            chk "agent_xlsx_surgery imports from ~/bin" 'python3 -c "import sys; sys.path.insert(0, sys.argv[1]); import agent_xlsx_surgery" "$HOME/bin"' ;;
    imessage) chk "LaunchAgent local.knowledge-worker-stack.imessage-export loaded" 'loaded local.knowledge-worker-stack.imessage-export'
              if imessage_ok; then say "  ok   iMessage export is reading messages"
              else say "  wait switch on /usr/bin/sqlite3 in Full Disk Access, then it starts working (the steps below)"; fi ;;
    model-sync) chk "LaunchAgent local.knowledge-worker-stack.claude-model-picker-sync loaded" 'loaded local.knowledge-worker-stack.claude-model-picker-sync' ;;
    claude-code) for lbl in claude-auto-successor claude-continue claude-memory-snapshot; do
                   chk "LaunchAgent local.knowledge-worker-stack.$lbl loaded" "loaded local.knowledge-worker-stack.$lbl"; done
                 chk "statusline.py and the skills in place" '[ -f "$HOME/.claude/statusline.py" ] && [ -f "$HOME/.claude/skills/successor/SKILL.md" ]' ;;
    grid) chk "LaunchAgent local.herdr.grid-ensure loaded" 'loaded local.herdr.grid-ensure'
          chk "ctrl+alt+g bound in herdr" 'grep -q "ctrl+alt+g" "$HCONF"' ;;
    comms) chk "LaunchAgent local.knowledge-worker-stack.claude-frontdesk loaded" 'loaded local.knowledge-worker-stack.claude-frontdesk'
           chk "LaunchAgent local.knowledge-worker-stack.claude-chief-of-staff-wake loaded" 'loaded local.knowledge-worker-stack.claude-chief-of-staff-wake'
           chk "claude_frontdesk.py list" '"$HOME/bin/claude_frontdesk.py" list'
           chk "priorities.py list" '"$HOME/bin/priorities.py" list' ;;
    mattermost) chk "Mattermost answers on localhost:8065" 'curl -fs http://localhost:8065/api/v4/system/ping' ;;
    phone-bridge) chk "mattermost_post.py --check" '"$HOME/bin/mattermost_post.py" --check'
                  chk "LaunchAgent phone bridge loaded" 'loaded local.knowledge-worker-stack.claude-chief-of-staff-phone-bridge' ;;
  esac; done
  if [ -f "$SETTINGS" ]; then
    chk "settings.json is valid JSON" 'python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$SETTINGS"'
    local missing
    missing=$(python3 -c '
import json, os, re, sys
d = json.load(open(sys.argv[1]))
cmds = [h.get("command", "") for gs in d.get("hooks", {}).values() for g in gs for h in g.get("hooks", [])]
cmds.append(d.get("statusLine", {}).get("command", ""))
for c in cmds:
    for p in re.findall(r"(?:~|\$HOME)/[^\s\"\x27]+\.(?:sh|py)", c):
        q = os.path.expanduser(p.replace("$HOME", "~"))
        if not os.path.exists(q): print(p)
' "$SETTINGS" 2>/dev/null)
    if [ -z "$missing" ]; then say "  ok   every hook in settings.json points at a file that exists"
    else say "  FAIL hooks point at missing files: $(echo $missing)"; ok=0; fi
  fi
  [ "$ok" = 1 ]
}

# ===================================================================================================
if [ "$UNINSTALL" = 1 ]; then
  say "Uninstalling:$SEL$([ "$FULL" = 1 ] && echo ' (everything)')$([ "$DRY" = 1 ] && echo ' — dry run, nothing changes')"
  uninstall
  exit 0
fi
say "Installing:$SEL$([ "$DRY" = 1 ] && echo ' — dry run, nothing changes')"
for c in $SEL; do
  say "[$c]"
  fn="c_$(echo "$c" | tr '-' '_')"
  "$fn" || FAILED="$FAILED $c"
  case " $MISSING " in *" $c "*) case " $FAILED " in *" $c "*) ;; *) FAILED="$FAILED $c" ;; esac ;; esac
done
if [ "$DRY" = 1 ]; then
  say ""; say "Dry run: $CHANGES change(s) listed above; nothing was changed."
  exit 0
fi
say ""; say "$CHANGES change(s) made.$([ -d "$BK" ] && echo " Backups of what was edited: $(short "$BK")")"
verify || true
[ -n "$FAILED" ] && say "" && say "Did not finish:$FAILED (see the ! lines above and the steps below)."
case " $SEL " in *" herdr "*|*" grid "*)
  human "Terminal: let Option send Escape so the alt keys work: Terminal > Settings > Profiles > Keyboard > Use Option as Meta key (iTerm2: Profiles > Keys > Left Option key: Esc+)." ;; esac
case " $SEL " in *" claude-code "*)
  [ -s "$HOME/.claude/.oauth_token" ] || human "Optional, to stop the Keychain password pop-ups: the token sign-in in claude-code/README.md piece 1 (you run claude setup-token in your own Terminal; the agent does the rest, then runs ./install.sh --only model-sync)." ;; esac
if [ -x "$HOME/bin/h" ]; then human "Last, once every other step is done (INSTALL.md section 6): quit Claude Code, open a new Terminal window, type h and press Enter. Start claude in a herdr tab from there."
else human "Last, once every other step is done (INSTALL.md section 6): quit Claude Code and open a new Terminal window, so the new PATH, hooks and skills load."; fi
say ""; say "Left for you, in order:"
printf '%s' "$HUMAN" | awk 'NF {print "  " ++n ". " $0}'
[ -z "$FAILED" ]
