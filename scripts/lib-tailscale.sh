#!/usr/bin/env bash
# Shared Tailscale helpers for the expose-*-tailscale.sh scripts. Sourced, not
# executed.

require_tailscale() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "Error: tailscale is not installed or not on PATH." >&2
    exit 1
  fi
}

# Print a dotted field of `tailscale status --json` (e.g. CurrentTailnet.MagicDNSSuffix)
# without its trailing dot. Exits if it can't be read.
tailscale_status_field() {
  local field="$1" value
  if command -v jq >/dev/null 2>&1; then
    value="$(tailscale status --json | jq -r ".${field}")"
  elif command -v python3 >/dev/null 2>&1; then
    value="$(tailscale status --json | python3 -c '
import sys, json
v = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("null" if v is None else v)' "$field")"
  else
    echo "Error: need jq or python3 to read tailscale status." >&2
    exit 1
  fi
  value="${value%.}"
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    echo "Error: could not read ${field} from tailscale status." >&2
    echo "Is Tailscale logged in? Try: tailscale status" >&2
    exit 1
  fi
  printf '%s\n' "$value"
}
