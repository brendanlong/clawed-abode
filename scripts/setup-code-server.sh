#!/usr/bin/env bash
# Set up code-server (browser VS Code) so the "Open in VS Code" button can view
# and edit session worktrees remotely.
#
# This installs code-server, points it at ~/worktrees, and exposes it over the
# tailnet via Tailscale Serve on a dedicated HTTPS port. code-server keeps its
# own password (set below), and Tailscale keeps it off the public internet — the
# same trust boundary the app itself uses.
#
# After running, set CODE_SERVER_URL in your .env to the printed URL and restart
# the app so the button appears.
#
# Idempotent: safe to re-run. Requires an existing Tailscale login on this host.
set -euo pipefail

# Port code-server listens on locally (loopback only) and the HTTPS port
# Tailscale Serve maps to it. Override via env if they collide with something.
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
CODE_SERVER_HTTPS_PORT="${CODE_SERVER_HTTPS_PORT:-8443}"
WORKTREES_DIR="${WORKTREES_DIR:-$HOME/worktrees}"

echo "==> Installing code-server (if not already present)"
if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sh
else
  echo "    code-server already installed: $(command -v code-server)"
fi

echo "==> Writing code-server config"
CONFIG_DIR="$HOME/.config/code-server"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
mkdir -p "$CONFIG_DIR"

if [ -f "$CONFIG_FILE" ] && grep -q '^password:' "$CONFIG_FILE"; then
  echo "    Keeping existing password in $CONFIG_FILE"
  PASSWORD="$(grep '^password:' "$CONFIG_FILE" | awk '{print $2}')"
else
  PASSWORD="$(openssl rand -base64 24)"
fi

cat >"$CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${CODE_SERVER_PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF
echo "    Wrote $CONFIG_FILE"

echo "==> Enabling code-server as a user service"
# Open the worktrees dir by default; individual sessions are deep-linked with ?folder=.
mkdir -p "$WORKTREES_DIR"
systemctl --user enable --now "code-server@$USER" 2>/dev/null ||
  systemctl --user enable --now code-server 2>/dev/null || {
    echo "    Could not manage the user service automatically."
    echo "    Start it manually with: code-server"
  }

echo "==> Exposing code-server over Tailscale Serve on port ${CODE_SERVER_HTTPS_PORT}"
tailscale serve --bg --https "${CODE_SERVER_HTTPS_PORT}" "http://127.0.0.1:${CODE_SERVER_PORT}"

HOSTNAME_FQDN="$(tailscale status --json | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/\.$//;s/"//')"
URL="https://${HOSTNAME_FQDN}:${CODE_SERVER_HTTPS_PORT}"

cat <<EOF

==> Done.

  code-server is reachable at:  ${URL}
  code-server password:         ${PASSWORD}

  Add this to your .env and restart the app:

    CODE_SERVER_URL="${URL}"

  The "Open in VS Code" button in each session will then deep-link into that
  session's worktree folder.
EOF
