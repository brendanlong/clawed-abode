#!/usr/bin/env bash
# Expose the app's public files server (each session's public/ directory) to the
# tailnet and print the PUBLIC_FILES_URL to put in the app's .env.
#
# Usage: expose-public-files-tailscale.sh <PUBLIC_FILES_PORT> [https-port]
#
# It must be served on the SAME hostname as the app, on another HTTPS port: the
# auth cookie the app sets is shared across ports but not hostnames. So if the app
# is exposed as a Tailscale service (e.g. svc:clawed), set TAILSCALE_SERVICE=clawed
# and the files go on that service's hostname; otherwise they go on this host's
# own name. Tailnet-only (`serve`, never `funnel`), like the app. Idempotent.
#
# NOTE: a Tailscale service only accepts the ports listed in its definition in the
# admin console (https://login.tailscale.com/admin/services); add the HTTPS port
# there first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib-tailscale.sh
source "$SCRIPT_DIR/lib-tailscale.sh"

LOCAL_PORT="${1:-}"
HTTPS_PORT="${2:-8444}"
if ! [[ "$LOCAL_PORT" =~ ^[0-9]+$ && "$HTTPS_PORT" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <PUBLIC_FILES_PORT> [https-port (default 8444)]" >&2
  exit 1
fi

require_tailscale

if [ -n "${TAILSCALE_SERVICE:-}" ]; then
  SERVICE="svc:${TAILSCALE_SERVICE}"
  echo "==> Serving public files on ${SERVICE} (HTTPS ${HTTPS_PORT} -> 127.0.0.1:${LOCAL_PORT})"
  tailscale serve --service="${SERVICE}" --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${LOCAL_PORT}"
  HOST="${TAILSCALE_SERVICE}.$(tailscale_status_field CurrentTailnet.MagicDNSSuffix)"
  OFF_CMD="tailscale serve --service=${SERVICE} --https=${HTTPS_PORT} off"
else
  echo "==> Serving public files on this host (HTTPS ${HTTPS_PORT} -> 127.0.0.1:${LOCAL_PORT})"
  tailscale serve --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${LOCAL_PORT}"
  HOST="$(tailscale_status_field Self.DNSName)"
  OFF_CMD="tailscale serve --https=${HTTPS_PORT} off"
fi

URL="https://${HOST}:${HTTPS_PORT}"

cat <<MSG

==> Done. Add this to your .env and restart the app:

    PUBLIC_FILES_PORT=${LOCAL_PORT}
    PUBLIC_FILES_URL="${URL}"

  Reach the app itself at https://${HOST} so its cookie reaches this port.

  To stop exposing it:  ${OFF_CMD}
MSG
