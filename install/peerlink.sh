#!/usr/bin/env bash
# PeerLink setup for Linux and macOS: the counterpart of PeerLink-Setup.cmd.
#
# Installs what is missing (git, Node.js, Claude Code), adds and updates the
# PeerLink plugin, asks only for what it cannot know (team key, machine name),
# checks the connection, creates the "peerlink" command (and a launcher icon on
# desktops), then starts a Claude session listening for the other machines.
#
#   curl -fsSL https://raw.githubusercontent.com/Mark-Bix/peerlink/main/install/peerlink.sh | bash
#   bash peerlink.sh [--name pc-ufficio] [--workdir ~/progetti] [--hub-url URL] [--reconfigure] [--no-launch]
#
# The team key can also come from PEERLINK_TEAM_KEY; with it and --name the setup
# asks nothing.

set -euo pipefail

HUB_URL='https://github.com/Mark-Bix/BixClaude-Mailbox.git'
MARKETPLACE='Mark-Bix/peerlink'
PLUGIN='peerlink@peerlink'
NAME=''
WORKDIR=''
RECONFIGURE=0
LAUNCH=1
LOCAL_BIN="$HOME/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --workdir) WORKDIR="$2"; shift 2 ;;
    --hub-url) HUB_URL="$2"; shift 2 ;;
    --marketplace) MARKETPLACE="$2"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    --no-launch) LAUNCH=0; shift ;;
    *) echo "Opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[36m== %s\033[0m\n' "$1"; }
ok() { printf '   \033[32m%s\033[0m\n' "$1"; }
note() { printf '   \033[33m%s\033[0m\n' "$1"; }
die() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Questions come from the terminal even when the script itself arrives on stdin (curl | bash).
TTY=/dev/tty
ask() { # ask <prompt> <var> [silent]
  local answer=''
  if [ -r "$TTY" ]; then
    if [ "${3:-}" = silent ]; then read -r -s -p "   $1" answer < "$TTY"; echo; else read -r -p "   $1" answer < "$TTY"; fi
  fi
  printf -v "$2" '%s' "$answer"
}

export DEBIAN_FRONTEND=noninteractive  # no tzdata or other prompts from apt
QUIET='/dev/null'
SUDO=''
if [ "$(id -u)" -ne 0 ]; then have sudo && SUDO='sudo'; fi
OS="$(uname -s)"

pkg_install() { # pkg_install <package> <label>
  note "Installo $2..."
  if [ "$OS" = Darwin ]; then
    have brew || die "$2 non è installato e Homebrew non c'è: installalo a mano e rilancia il setup."
    brew install "$1"
  elif have apt-get; then { $SUDO apt-get update -qq && $SUDO -E apt-get install -y -qq "$1"; } > "$QUIET" 2>&1
  elif have dnf; then $SUDO dnf install -y -q "$1" > "$QUIET" 2>&1
  elif have yum; then $SUDO yum install -y -q "$1" > "$QUIET" 2>&1
  elif have zypper; then $SUDO zypper -q install -y "$1" > "$QUIET" 2>&1
  elif have pacman; then $SUDO pacman -S --noconfirm "$1" > "$QUIET" 2>&1
  else die "$2 non è installato e non trovo un gestore di pacchetti: installalo a mano e rilancia il setup."
  fi
}

node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }

install_node() {
  note 'Installo Node.js (LTS)...'
  if [ "$OS" = Darwin ]; then pkg_install node Node.js; return; fi
  # Distribution packages are often older than Node 20: use NodeSource.
  if have apt-get; then
    have curl || pkg_install curl curl
    curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO -E bash - > "$QUIET" 2>&1
    $SUDO -E apt-get install -y -qq nodejs > "$QUIET" 2>&1
  elif have dnf || have yum; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | $SUDO bash - > "$QUIET" 2>&1
    if have dnf; then $SUDO dnf install -y -q nodejs > "$QUIET" 2>&1; else $SUDO yum install -y -q nodejs > "$QUIET" 2>&1; fi
  else
    pkg_install nodejs Node.js
  fi
}

# ---- 1. prerequisites -------------------------------------------------------

step 'Controllo dei prerequisiti'
have curl || pkg_install curl curl
have git || pkg_install git Git
ok "git: $(git --version)"
node_ok || install_node
node_ok || die 'Serve Node.js 20 o più recente: installalo a mano e rilancia il setup.'
ok "node: $(node -v)"

export PATH="$LOCAL_BIN:$PATH"
if ! have claude; then
  note 'Installo Claude Code...'
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null
fi
have claude || die 'Claude Code non risulta installato: apri un nuovo terminale e rilancia il setup.'
ok "claude: $(claude --version | head -n1)"

# Keep ~/.local/bin on PATH for new shells.
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$rc" ] && ! grep -q '.local/bin' "$rc"; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
  fi
done

# ---- 2. plugin --------------------------------------------------------------

step 'Plugin PeerLink'
json_has() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(m=>m.name===process.argv[1])?0:1))' "$1"; }
if claude plugin marketplace list --json | json_has peerlink; then
  claude plugin marketplace update peerlink >/dev/null
else
  claude plugin marketplace add "$MARKETPLACE" >/dev/null
fi

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
if node -e 'const f=process.argv[1];const fs=require("fs");process.exit(fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,"utf8")).plugins?.[process.argv[2]]?0:1)' \
    "$CLAUDE_DIR/plugins/installed_plugins.json" "$PLUGIN"; then
  claude plugin update "$PLUGIN" >/dev/null
  ok 'aggiornato'
else
  claude plugin install "$PLUGIN" >/dev/null
  ok 'installato'
fi

# ---- 3. options -------------------------------------------------------------

step 'Configurazione'
CONFIGURED="$(claude plugin configure "$PLUGIN" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).configured.join(" ")))')"
is_set() { [ "$RECONFIGURE" -eq 0 ] && [[ " $CONFIGURED " == *" $1 "* ]]; }

# Values travel as JSON through stdin (printf is a shell builtin): the key never
# appears on a command line. JSON strings are built by node to escape them right.
VALUES='{}'
add_value() { VALUES="$(node -e 'const o=JSON.parse(process.argv[1]);o[process.argv[2]]=process.argv[3];console.log(JSON.stringify(o))' "$VALUES" "$1" "$2")"; }

is_set hub_url || add_value hub_url "$HUB_URL"
SAVED_KEYS=''
if ! is_set team_key; then
  KEY="${PEERLINK_TEAM_KEY:-}"
  [ -n "$KEY" ] || ask 'Chiave della squadra (il token GitHub; non viene mostrata): ' KEY silent
  if [ -n "$KEY" ]; then
    # Through stdin, never argv: added last, straight into the JSON.
    VALUES="$(printf '%s' "$KEY" | node -e 'let k="";process.stdin.on("data",d=>k+=d).on("end",()=>{const o=JSON.parse(process.argv[1]);o.team_key=k.trim();console.log(JSON.stringify(o))})' "$VALUES")"
  fi
fi
if ! is_set peer_name; then
  if [ -z "$NAME" ]; then
    DEFAULT_NAME="$(hostname | tr '[:upper:]' '[:lower:]')"
    ask "Nome di questa macchina [$DEFAULT_NAME]: " NAME
    NAME="${NAME:-$DEFAULT_NAME}"
  fi
  add_value peer_name "$(printf '%s' "$NAME" | tr '[:upper:]' '[:lower:]')"
fi

if [ "$VALUES" != '{}' ]; then
  printf '%s' "$VALUES" | claude plugin configure "$PLUGIN" --values-stdin >/dev/null || die 'Configurazione non salvata.'
  ok "salvato: $(printf '%s' "$VALUES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).sort().join(", ")))')"
else
  ok 'già configurato (rilancia con --reconfigure per cambiare)'
fi
unset KEY VALUES

# ---- 4. command and launcher ------------------------------------------------

step 'Comando "peerlink"'
mkdir -p "$LOCAL_BIN"
cat > "$LOCAL_BIN/peerlink" <<'EOF'
#!/usr/bin/env bash
# PeerLink: a Claude session that listens for the other machines.
exec claude --dangerously-load-development-channels plugin:peerlink@peerlink --permission-mode auto "$@"
EOF
chmod +x "$LOCAL_BIN/peerlink"
ok "comando: peerlink (in qualunque cartella: $LOCAL_BIN/peerlink)"

WORKDIR="${WORKDIR:-$HOME}"
if [ "$OS" = Darwin ] && [ -d "$HOME/Desktop" ]; then
  printf '#!/bin/bash\ncd "%s" && exec "%s"\n' "$WORKDIR" "$LOCAL_BIN/peerlink" > "$HOME/Desktop/PeerLink.command"
  chmod +x "$HOME/Desktop/PeerLink.command"
  ok "icona sul desktop: PeerLink (parte da $WORKDIR)"
elif [ -n "${XDG_CURRENT_DESKTOP:-}" ] || [ -d "$HOME/.local/share/applications" ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/peerlink.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=PeerLink
Comment=Claude in ascolto su PeerLink
Exec=$LOCAL_BIN/peerlink
Path=$WORKDIR
Terminal=true
Icon=utilities-terminal
EOF
  ok "voce PeerLink nel menu applicazioni (parte da $WORKDIR)"
fi

# ---- 5. check ---------------------------------------------------------------

step 'Verifica del collegamento'
if CHECK="$(claude -p 'Call the peerlink peer_list tool once and print its output verbatim, nothing else.' \
    --allowedTools 'mcp__plugin_peerlink_peer__peer_list' --model haiku < /dev/null 2>&1)" && [[ "$CHECK" == *'You are "'* ]]; then
  printf '%s\n' "$CHECK"
else
  note 'Verifica non riuscita. Se Claude Code non ha ancora fatto il login, avvia "claude" una volta, accedi, poi rilancia il setup.'
  note "$CHECK"
fi

# ---- 6. start ---------------------------------------------------------------

printf '\n\033[32mFatto. Per avviare PeerLink in futuro: "peerlink" nella cartella del progetto.\033[0m\n'
echo 'Alla prima apertura Claude chiede di confermare i "development channels": conferma.'
if [ "$LAUNCH" -eq 1 ]; then
  [ -r "$TTY" ] || { note 'Nessun terminale interattivo: avvia "peerlink" a mano.'; exit 0; }
  cd "$WORKDIR"
  exec "$LOCAL_BIN/peerlink" < "$TTY"
fi
