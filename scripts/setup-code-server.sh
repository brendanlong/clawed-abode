#!/usr/bin/env bash
# Set up code-server (browser VS Code) so the "Open in VS Code" button can view
# and edit session worktrees remotely.
#
# This is the app-side half of the setup: install code-server, point it at
# ~/worktrees, and run it as a service. It does NOT touch Tailscale, so it can be
# run by the account that runs the app (which may not have permission to manage
# Tailscale). Expose it to the tailnet separately with
# expose-code-server-tailscale.sh (run by someone with Tailscale access).
#
# Idempotent: safe to re-run.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-code-server.sh
source "$SCRIPT_DIR/lib-code-server.sh"

echo "==> Installing code-server (if not already present)"
if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sh
else
  echo "    code-server already installed: $(command -v code-server)"
fi

echo "==> Writing code-server config"
mkdir -p "$CODE_SERVER_CONFIG_DIR"
chmod 700 "$CODE_SERVER_CONFIG_DIR"

# Reuse an existing password on re-run; otherwise generate one. Track which case
# we hit so we only print a *freshly generated* secret (never re-echo an existing
# one on idempotent re-runs).
PASSWORD_IS_NEW=false
if [ -f "$CODE_SERVER_CONFIG_FILE" ] && grep -q '^password:' "$CODE_SERVER_CONFIG_FILE"; then
  # Strip the "password:" key, surrounding whitespace, and optional quotes so
  # hand-edited/quoted passwords (incl. those with spaces) survive intact.
  PASSWORD="$(sed -n 's/^password:[[:space:]]*//p' "$CODE_SERVER_CONFIG_FILE" | head -1)"
  PASSWORD="${PASSWORD%\"}"
  PASSWORD="${PASSWORD#\"}"
  echo "    Keeping existing password in $CODE_SERVER_CONFIG_FILE"
else
  PASSWORD="$(openssl rand -base64 24)"
  PASSWORD_IS_NEW=true
fi

# Write the config with restrictive permissions *before* the secret lands in it.
touch "$CODE_SERVER_CONFIG_FILE"
chmod 600 "$CODE_SERVER_CONFIG_FILE"
cat >"$CODE_SERVER_CONFIG_FILE" <<EOF
bind-addr: 127.0.0.1:${CODE_SERVER_PORT}
auth: password
password: ${PASSWORD}
cert: false
EOF
echo "    Wrote $CODE_SERVER_CONFIG_FILE (mode 600)"

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

echo
echo "==> code-server is set up (listening on 127.0.0.1:${CODE_SERVER_PORT})."
if [ "$PASSWORD_IS_NEW" = true ]; then
  echo "    code-server password:  ${PASSWORD}"
  echo "    (also stored in ${CODE_SERVER_CONFIG_FILE})"
else
  echo "    code-server password:  (unchanged; see ${CODE_SERVER_CONFIG_FILE})"
fi
cat <<EOF

  Next: expose it to your tailnet and get the CODE_SERVER_URL by running (as a
  user with Tailscale access):

    scripts/expose-code-server-tailscale.sh

  Then set the printed CODE_SERVER_URL in your .env and restart the app.
EOF
