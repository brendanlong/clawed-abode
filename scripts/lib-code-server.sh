#!/usr/bin/env bash
# Shared configuration for the code-server setup scripts. This file is *sourced*
# by setup-code-server.sh and expose-code-server-tailscale.sh, not executed
# directly, so the loopback/HTTPS ports stay in sync between the two steps
# (Tailscale Serve maps the HTTPS port to the loopback port code-server binds).
#
# Override any of these by exporting them before running either script.

# Port code-server binds on loopback (never exposed directly).
CODE_SERVER_PORT="${CODE_SERVER_PORT:-8080}"
# HTTPS port Tailscale Serve exposes on the tailnet, proxied to CODE_SERVER_PORT.
CODE_SERVER_HTTPS_PORT="${CODE_SERVER_HTTPS_PORT:-8443}"
# Root directory that holds all session worktrees.
WORKTREES_DIR="${WORKTREES_DIR:-$HOME/worktrees}"
# code-server config file (holds the generated password).
CODE_SERVER_CONFIG_DIR="$HOME/.config/code-server"
CODE_SERVER_CONFIG_FILE="$CODE_SERVER_CONFIG_DIR/config.yaml"
