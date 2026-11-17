#!/bin/bash
# Install the Earpiece bridge on a Linux server, as a Docker container or directly.
#
#   server/install.sh docker [--relay wss://...] [--no-gpu]
#   server/install.sh direct [--relay wss://...]
#
# Needs: Claude Code already installed and logged in on this server (run `claude` once).
# docker mode needs Docker with Compose v2; GPUs are added automatically when nvidia-smi works.
# direct mode installs Node 22 for your user with nvm if needed (no sudo) and a systemd user service.
# Both modes put an `earpiece` command in ~/.local/bin: earpiece start|stop|restart|status|logs|pair
set -euo pipefail

MODE="${1:-}"; shift || true
RELAY="wss://earpiece-relay.earpiece.workers.dev"
GPU="auto"
while [ $# -gt 0 ]; do
  case "$1" in
    --relay) RELAY="$2"; shift 2 ;;
    --no-gpu) GPU="no"; shift ;;
    --gpu) GPU="yes"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$MODE" in docker|direct) ;; *) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;; esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$HOME/.earpiece"
say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux servers (on a Mac use bridge/bin/earpiece start)."

# 1. Claude Code must already be installed and logged in.
say "Checking Claude Code"
CLAUDE="$(command -v claude || true)"
[ -z "$CLAUDE" ] && [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"
[ -n "$CLAUDE" ] || die "Claude Code not found. Install it (curl -fsSL https://claude.ai/install.sh | bash) and log in with: claude"
echo "Claude Code: $CLAUDE ($("$CLAUDE" --version 2>/dev/null || echo 'version unknown'))"
if [ ! -s "$HOME/.claude/.credentials.json" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "Warning: no Claude Code login found in ~/.claude/.credentials.json."
  echo "         Run 'claude' once and log in (or 'claude setup-token'), then rerun this installer."
fi

# 2. Earpiece settings (kept if they already exist).
mkdir -p "$DATA"
chmod 700 "$DATA"
if [ ! -f "$DATA/config.json" ]; then
  say "Writing $DATA/config.json"
  umask 077
  cat > "$DATA/config.json" <<JSON
{
  "relay": "$RELAY",
  "direct": false,
  "start_dir": "$HOME",
  "roots": "$HOME"
}
JSON
  echo "Edit start_dir / roots there to point at where your projects live."
else
  echo "Keeping existing $DATA/config.json"
fi

# 3. The `earpiece` command.
mkdir -p "$HOME/.local/bin"
ln -sf "$REPO/bridge/bin/earpiece" "$HOME/.local/bin/earpiece"
if [ "$(id -u)" = 0 ]; then ln -sf "$REPO/bridge/bin/earpiece" /usr/local/bin/earpiece; fi
echo "$MODE" > "$DATA/mode"

if [ "$MODE" = "docker" ]; then
  say "Setting up Docker"
  command -v docker >/dev/null || die "Docker not found."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not found (docker compose ...)."
  case "$(realpath "$CLAUDE")" in
    "$HOME"/*) INSTALL_CLAUDE=0; CLAUDE_IN=$CLAUDE ;;
    *) INSTALL_CLAUDE=1; CLAUDE_IN=/usr/local/bin/claude
       echo "Claude Code lives outside your home folder; the image will install its own copy (same login)." ;;
  esac
  TZNAME="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
  cat > "$REPO/server/.env" <<ENV
EARPIECE_UID=$(id -u)
EARPIECE_GID=$(id -g)
EARPIECE_USER=$(id -un)
EARPIECE_USER_HOME=$HOME
EARPIECE_CLAUDE_BIN=$CLAUDE_IN
EARPIECE_INSTALL_CLAUDE=$INSTALL_CLAUDE
EARPIECE_TZ=$TZNAME
EARPIECE_NAME=$(hostname -s)
ENV
  FILES="-f docker-compose.yml"
  if [ "$GPU" = "yes" ] || { [ "$GPU" = "auto" ] && command -v nvidia-smi >/dev/null && nvidia-smi -L >/dev/null 2>&1; }; then
    FILES="$FILES -f docker-compose.gpu.yml"
    echo "GPUs: yes"
  else
    echo "GPUs: no"
  fi
  echo "$FILES" > "$DATA/compose-files"
  echo "$REPO/server" > "$DATA/compose-dir"
  say "Building and starting the container (first build takes a few minutes)"
  (cd "$REPO/server" && docker compose $FILES up -d --build)
else
  say "Checking Node 22"
  NODE=""
  for n in "$(command -v node 2>/dev/null || true)" "$HOME"/.nvm/versions/node/v22*/bin/node "$HOME"/.nvm/versions/node/v2[3-9]*/bin/node; do
    [ -x "$n" ] || continue
    if [ "$("$n" -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then NODE="$n"; fi
  done
  if [ -z "$NODE" ]; then
    echo "Installing Node 22 for your user with nvm (no sudo)."
    if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm install 22 >/dev/null
    NODE="$(nvm which 22)"
  fi
  echo "Node: $NODE ($("$NODE" --version))"
  echo "$NODE" > "$DATA/node"

  if [ "$(id -u)" = 0 ]; then
    say "Installing the systemd service (system-wide, running as root)"
    UNIT_DIR=/etc/systemd/system; SCTL="systemctl"; echo system > "$DATA/systemd-scope"
  else
    say "Installing the systemd user service"
    UNIT_DIR="$HOME/.config/systemd/user"; SCTL="systemctl --user"; echo user > "$DATA/systemd-scope"
  fi
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/earpiece.service" <<UNIT
[Unit]
Description=Earpiece bridge
After=network-online.target

[Service]
WorkingDirectory=$REPO/bridge
ExecStart=$NODE $REPO/bridge/src/server.js
Environment=PATH=$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
Environment=DISABLE_AUTOUPDATER=1
Environment=HOME=$HOME
Restart=on-failure
RestartSec=3
TimeoutStopSec=75

[Install]
WantedBy=$([ "$(id -u)" = 0 ] && echo multi-user.target || echo default.target)
UNIT
  $SCTL daemon-reload
  $SCTL enable --now earpiece
  if [ "$(id -u)" != 0 ] && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != "yes" ]; then
    echo
    echo "So the bridge keeps running after you log out, run once:"
    echo "  sudo loginctl enable-linger $(id -un)"
  fi
fi

say "Waiting for the bridge"
for _ in $(seq 1 30); do
  if "$REPO/bridge/bin/earpiece" status 2>/dev/null | grep -q '"relay":"connected"'; then break; fi
  sleep 2
done
"$REPO/bridge/bin/earpiece" status || true

cat <<DONE

Done. Commands (open a new shell if 'earpiece' is not found yet):
  earpiece start | stop | restart | status | logs
  earpiece pair     show the QR code; scan it with the iPhone Camera to add this server
DONE
