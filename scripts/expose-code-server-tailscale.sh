#!/usr/bin/env bash
# Expose a running code-server to the tailnet as a Tailscale *service* and print
# the CODE_SERVER_URL to put in the app's .env.
#
# This is the Tailscale half of the setup, split out because managing Tailscale
# usually needs privileges the app's account does not have (the operator/root, or
# membership in the tailscale group). Run setup-code-server.sh first (installs and
# starts code-server on loopback); then run this as a user with Tailscale access.
#
# Exposes code-server as its own tailnet hostname (https://code.<tailnet>.ts.net)
# via a Tailscale *service* (svc:code) — the same way the host's other services
# (clawed, wiki, ...) each get a distinct name, rather than sharing one host and a
# nonstandard port. It stays on the tailnet (a `serve` service, never `funnel`),
# the same trust boundary as the app. Idempotent: safe to re-run. Requires an
# existing Tailscale login on this host, and jq or python3 to read the tailnet's
# DNS suffix.
#
# NOTE: the first time a service name is advertised, a tailnet admin must approve
# it in the admin console (https://login.tailscale.com/admin/services) before the
# hostname resolves. Re-running after approval is a no-op.
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

SERVICE="svc:${CODE_SERVER_SERVICE}"
echo "==> Advertising code-server as Tailscale service ${SERVICE} (HTTPS 443 -> 127.0.0.1:${CODE_SERVER_PORT})"
# Configuring a service with `tailscale serve` also advertises this node as its
# proxy (no separate `serve advertise` needed). Standard HTTPS (443), so the URL
# carries no port. On first run this prints an "approval required" notice.
tailscale serve --service="${SERVICE}" --bg --https=443 "http://127.0.0.1:${CODE_SERVER_PORT}"

# The service hostname is ${CODE_SERVER_SERVICE}.<tailnet-suffix>. Read the
# tailnet's MagicDNS suffix (e.g. tail1234.ts.net) rather than this host's own
# DNS name — the service has its own name, independent of the host's.
if command -v jq >/dev/null 2>&1; then
  DNS_SUFFIX="$(tailscale status --json | jq -r '.CurrentTailnet.MagicDNSSuffix')"
elif command -v python3 >/dev/null 2>&1; then
  DNS_SUFFIX="$(tailscale status --json |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["CurrentTailnet"]["MagicDNSSuffix"])')"
else
  echo "Error: need jq or python3 to read this tailnet's DNS suffix." >&2
  exit 1
fi
DNS_SUFFIX="${DNS_SUFFIX%.}" # strip any trailing dot

if [ -z "$DNS_SUFFIX" ] || [ "$DNS_SUFFIX" = "null" ]; then
  echo "Error: could not determine this tailnet's DNS suffix." >&2
  echo "Is Tailscale logged in? Try: tailscale status" >&2
  exit 1
fi

URL="https://${CODE_SERVER_SERVICE}.${DNS_SUFFIX}"

echo
echo "==> Done."
echo
echo "  code-server is reachable at:  ${URL}"
cat <<EOF

  If this is the first time advertising ${SERVICE}, approve it once as a tailnet
  admin before the hostname resolves:

    https://login.tailscale.com/admin/services

  Then add this to your .env and restart the app:

    CODE_SERVER_URL="${URL}"

  The "Open in VS Code" button in each session will then deep-link into that
  session's worktree folder.

  To stop exposing it:  tailscale serve --service=${SERVICE} --https=443 off
  To remove the config: tailscale serve clear ${SERVICE}
EOF
