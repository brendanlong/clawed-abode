#!/usr/bin/env bash
# Shared configuration and helpers for the code-server setup scripts. This file
# is *sourced* by setup-code-server.sh and expose-code-server-tailscale.sh, not
# executed directly, so the loopback port and service name stay in sync between
# the two steps (the Tailscale service proxies its HTTPS to the loopback port
# code-server binds).
#
# Override the values below by exporting them before running either script.

# Tailscale Service name that exposes code-server on the tailnet as its own
# hostname (https://<name>.<tailnet>.ts.net) on standard HTTPS (443), proxied to
# the loopback port. This mirrors the host's other services (clawed, wiki, ...),
# which each get a distinct name rather than sharing one host + a nonstandard
# port. The advertised service is svc:${CODE_SERVER_SERVICE}.
CODE_SERVER_SERVICE="${CODE_SERVER_SERVICE:-code}"
# Root directory that holds all session worktrees.
WORKTREES_DIR="${WORKTREES_DIR:-$HOME/worktrees}"
# code-server config file (holds the generated password and chosen port).
CODE_SERVER_CONFIG_DIR="$HOME/.config/code-server"
CODE_SERVER_CONFIG_FILE="$CODE_SERVER_CONFIG_DIR/config.yaml"

# Loopback port code-server binds (never exposed directly). The config file's
# bind-addr is the source of truth once written, so both scripts and every
# re-run agree. Resolution order:
#   1. explicit CODE_SERVER_PORT env override
#   2. the port recorded in an existing config file
#   3. empty — setup-code-server.sh picks a random free port on first write
#      (avoids the commonly-used 8080)
if [ -z "${CODE_SERVER_PORT:-}" ] && [ -f "$CODE_SERVER_CONFIG_FILE" ]; then
  CODE_SERVER_PORT="$(sed -n 's/^bind-addr:.*:\([0-9][0-9]*\).*/\1/p' "$CODE_SERVER_CONFIG_FILE" | head -1)"
fi
CODE_SERVER_PORT="${CODE_SERVER_PORT:-}"

# Echo a random, likely-free high port in [20000, 49999]. When `ss` is available
# it skips ports that are already listening; otherwise it returns the first
# candidate. Falls back to the last candidate after a few tries.
pick_free_port() {
  local port attempt
  for attempt in $(seq 1 20); do
    port=$(((RANDOM % 30000) + 20000))
    if command -v ss >/dev/null 2>&1; then
      if ! ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
        echo "$port"
        return 0
      fi
    else
      echo "$port"
      return 0
    fi
  done
  echo "$port"
}
