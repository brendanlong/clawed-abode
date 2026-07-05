#!/usr/bin/env bash
# Expose a running code-server to the tailnet via Tailscale Serve and print the
# CODE_SERVER_URL to put in the app's .env.
#
# This is the Tailscale half of the setup, split out because managing Tailscale
# usually needs privileges the app's account does not have (the operator/root, or
# membership in the tailscale group). Run setup-code-server.sh first (installs and
# starts code-server on loopback); then run this as a user with Tailscale access.
#
# Keeps code-server off the public internet: it uses `tailscale serve` (tailnet
# only), not `tailscale funnel`. Idempotent: safe to re-run. Requires an existing
# Tailscale login on this host, and jq or python3 to read the host's DNS name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-code-server.sh
source "$SCRIPT_DIR/lib-code-server.sh"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Error: tailscale is not installed or not on PATH." >&2
  exit 1
fi

# The loopback port is read from the code-server config (written by setup). If it
# is missing, setup has not run yet — bail rather than proxying to a blank port.
if [ -z "$CODE_SERVER_PORT" ]; then
  echo "Error: no code-server port found in ${CODE_SERVER_CONFIG_FILE}." >&2
  echo "Run setup-code-server.sh first." >&2
  exit 1
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
cat <<EOF

  Add this to your .env and restart the app:

    CODE_SERVER_URL="${URL}"

  The "Open in VS Code" button in each session will then deep-link into that
  session's worktree folder.
EOF
