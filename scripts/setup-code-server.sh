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
chmod 700 "$CONFIG_DIR"

# Reuse an existing password on re-run; otherwise generate one. Track which case
# we hit so we only print a *freshly generated* secret (never re-echo an existing
# one on idempotent re-runs).
PASSWORD_IS_NEW=false
if [ -f "$CONFIG_FILE" ] && grep -q '^password:' "$CONFIG_FILE"; then
  # Strip the "password:" key, surrounding whitespace, and optional quotes so
  # hand-edited/quoted passwords (incl. those with spaces) survive intact.
  PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CONFIG_FILE" | head -1)"
  PASSWORD="${PASSWORD%\"}"
  PASSWORD="${PASSWORD#\"}"
  echo "    Keeping existing password in $CONFIG_FILE"
else
  PASSWORD="$(openssl rand -base64 24)"
  PASSWORD_IS_NEW=true
fi

# Write the config with restrictive permissions *before* the secret lands in it.
touch "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"
cat >"$CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${CODE_SERVER_PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF
echo "    Wrote $CONFIG_FILE (mode 600)"

echo "==> Enabling code-server as a systemd service"
# Open the worktrees dir by default; individual sessions are deep-linked with ?folder=.
mkdir -p "$WORKTREES_DIR"
# The code-server installer ships a system-scope template unit run as the target
# user: `sudo systemctl enable --now code-server@$USER` (its own post-install note).
if command -v systemctl >/dev/null 2>&1 &&
  sudo systemctl enable --now "code-server@$USER"; then
  echo "    Enabled code-server@$USER"
else
  echo "    Could not enable the service automatically."
  echo "    Start it manually with:  code-server   (or: sudo systemctl enable --now code-server@$USER)"
fi

echo "==> Exposing code-server over Tailscale Serve on port ${CODE_SERVER_HTTPS_PORT}"
tailscale serve --bg --https "${CODE_SERVER_HTTPS_PORT}" "http://127.0.0.1:${CODE_SERVER_PORT}"

# Resolve *this host's* MagicDNS name. Parse the Self object explicitly rather
# than grabbing the first DNSName in the JSON (which could be a peer).
if command -v jq >/dev/null 2>&1; then
  HOSTNAME_FQDN="$(tailscale status --json | jq -r '.Self.DNSName')"
elif command -v python3 >/dev/null 2>&1; then
  HOSTNAME_FQDN="$(tailscale status --json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["Self"]["DNSName"])')"
else
  echo "Error: need jq or python3 to read this host's Tailscale name." >&2
  exit 1
fi
HOSTNAME_FQDN="${HOSTNAME_FQDN%.}" # strip the trailing dot MagicDNS returns

if [ -z "$HOSTNAME_FQDN" ] || [ "$HOSTNAME_FQDN" = "null" ]; then
  echo "Error: could not determine this host's Tailscale DNS name." >&2
  echo "Is Tailscale logged in? Try: tailscale status" >&2
  exit 1
fi

URL="https://${HOSTNAME_FQDN}:${CODE_SERVER_HTTPS_PORT}"

echo
echo "==> Done."
echo
echo "  code-server is reachable at:  ${URL}"
if [ "$PASSWORD_IS_NEW" = true ]; then
  echo "  code-server password:         ${PASSWORD}"
  echo "  (also stored in ${CONFIG_FILE})"
else
  echo "  code-server password:         (unchanged; see ${CONFIG_FILE})"
fi
cat <<EOF

  Add this to your .env and restart the app:

    CODE_SERVER_URL="${URL}"

  The "Open in VS Code" button in each session will then deep-link into that
  session's worktree folder.
EOF
