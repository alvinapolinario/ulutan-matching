#!/usr/bin/env bash
# Ulutan - one-step production start under PM2.
#
#   Installs dependencies, installs PM2 if needed, starts the server from ecosystem.config.js,
#   saves the PM2 process list and registers PM2 to start automatically with the computer.
#   Safe to run again at any time (after copying new app files, for example): it re-reads
#   ecosystem.config.js, restarts the server and keeps the data/ folder untouched.
#
# Windows 11 : run from Git Bash (comes with Git for Windows):   bash deploy/pm2-start.sh
# Linux/macOS: bash deploy/pm2-start.sh
#
# Optional environment variables (also honoured by ecosystem.config.js):
#   PORT=3090 DATA_DIR=/srv/ulutan-data TZ=Asia/Manila bash deploy/pm2-start.sh
#   NO_STARTUP=1   skip the "start automatically with the computer" step

set -euo pipefail

APP_NAME="ulutan"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3080}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) OS=windows ;;
  Darwin)               OS=mac ;;
  *)                    OS=linux ;;
esac

# ---- 1. Node.js -------------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "Node.js was not found. Install Node.js 22 LTS from https://nodejs.org, open a new terminal and run this script again."
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))."
log "Node.js $(node -v) found, app folder: $APP_DIR"

# ---- 2. App dependencies ----------------------------------------------------------------------
cd "$APP_DIR"
[ -f package.json ] && [ -f ecosystem.config.js ] || die "package.json / ecosystem.config.js not found in $APP_DIR"
log "Installing app dependencies (production only)"
npm install --omit=dev --no-audit --no-fund
mkdir -p "${DATA_DIR:-$APP_DIR/data}"

# ---- 3. PM2 -----------------------------------------------------------------------------------
if ! command -v pm2 >/dev/null 2>&1; then
  log "Installing PM2 globally"
  if [ "$OS" = windows ]; then
    npm install -g pm2 pm2-windows-startup
  else
    npm install -g pm2
  fi
  hash -r 2>/dev/null || true
  command -v pm2 >/dev/null 2>&1 || die "PM2 was installed but is not on the PATH yet. Open a new terminal and run this script again."
fi
log "PM2 $(pm2 -v) ready"

# ---- 4. Start (or restart) the server ---------------------------------------------------------
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  log "'$APP_NAME' is already registered in PM2 - replacing it so ecosystem.config.js is re-read"
  pm2 delete "$APP_NAME" >/dev/null
fi
log "Starting '$APP_NAME' with PM2"
pm2 start ecosystem.config.js
pm2 save

# ---- 5. Health check --------------------------------------------------------------------------
log "Waiting for http://localhost:$PORT/healthz"
HEALTHY=0
for _ in $(seq 1 20); do
  if node -e "require('http').get('http://localhost:$PORT/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
    HEALTHY=1; break
  fi
  sleep 1
done
if [ "$HEALTHY" = 1 ]; then
  echo "Server is answering."
else
  pm2 logs "$APP_NAME" --err --lines 30 --nostream || true
  die "The server did not answer on port $PORT. See the errors above (pm2 logs $APP_NAME --err)."
fi

# ---- 6. Start automatically with the computer -------------------------------------------------
if [ "${NO_STARTUP:-}" = 1 ]; then
  log "Skipping automatic start registration (NO_STARTUP=1)"
else
  log "Registering PM2 to start automatically"
  case "$OS" in
    windows)
      command -v pm2-startup >/dev/null 2>&1 || npm install -g pm2-windows-startup
      pm2-startup install
      echo "PM2 will start '$APP_NAME' each time this Windows user logs in."
      echo "Set up automatic login (netplwiz) or use pm2-installer for a real service - see README, section 3."
      ;;
    linux|mac)
      if [ "$(id -u)" = 0 ]; then
        pm2 startup -u "${SUDO_USER:-$USER}" --hp "$HOME" >/dev/null
      elif command -v sudo >/dev/null 2>&1; then
        echo "sudo is needed once to register the startup service:"
        sudo env PATH="$PATH" "$(command -v pm2)" startup -u "$USER" --hp "$HOME" >/dev/null
      else
        pm2 startup   # prints the command to run manually as root
      fi
      ;;
  esac
fi

# ---- 7. Summary -------------------------------------------------------------------------------
log "Done. Current PM2 processes:"
pm2 status
log "Addresses (from the server log):"
pm2 logs "$APP_NAME" --lines 15 --nostream 2>/dev/null | grep -E 'http://' || true
echo
echo "Next steps:"
echo "  - Open http://localhost:$PORT and create the administrator account now, if not done yet."
if [ "$OS" = windows ]; then
  echo "  - Allow the port through Windows Firewall (admin PowerShell):"
  echo "      netsh advfirewall firewall add rule name=\"Ulutan\" dir=in action=allow protocol=TCP localport=$PORT profile=private"
elif [ "$OS" = linux ]; then
  echo "  - Allow the port through the firewall if one is active, e.g.:  sudo ufw allow $PORT/tcp"
fi
echo "  - Useful commands:  pm2 status | pm2 logs $APP_NAME | pm2 restart $APP_NAME | pm2 stop $APP_NAME"
