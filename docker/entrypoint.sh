#!/bin/bash
# Entrypoint script for claude-code runner containers.
# Runs setup tasks that need to happen at container start, then launches
# the agent service. This avoids race conditions with host-side podman exec
# commands that could fail if the container's main process exits.
#
# This script must be idempotent - it runs on every container start,
# including restarts of stopped containers.

set -e

# --- Setup tasks (run as current user or with sudo as needed) ---

# Configure pnpm to use the shared store volume
pnpm config set store-dir /pnpm-store 2>/dev/null || true

# Configure Gradle to use the shared cache volume (idempotent - only add if not present)
if ! grep -q 'GRADLE_USER_HOME=/gradle-cache' "$HOME/.profile" 2>/dev/null; then
  echo "export GRADLE_USER_HOME=/gradle-cache" >> "$HOME/.profile"
fi

# Stop any stale Gradle daemons from previous container sessions.
# The shared /gradle-cache volume can persist daemons that have cached VFS snapshots
# from old /workspace mounts, causing phantom builds (see issue #238).
if [ -d /gradle-cache ]; then
  # Disable daemon via gradle.properties in GRADLE_USER_HOME
  echo "org.gradle.daemon=false" > /gradle-cache/gradle.properties
  # Kill any leftover daemon processes (they won't have valid /workspace mounts)
  pkill -f 'GradleDaemon' 2>/dev/null || true
fi

# Fix sudo permissions (rootless Podman without --userns=keep-id can break setuid)
sudo sh -c 'chown root:root /usr/bin/sudo && chmod 4755 /usr/bin/sudo' 2>/dev/null || true

# Configure git credential helper if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  cat > "$HOME/.git-credential-helper" << 'SCRIPT'
#!/bin/sh
if [ "$1" = "get" ]; then
  input=$(cat)
  if echo "$input" | grep -q "host=github.com"; then
    echo "protocol=https"
    echo "host=github.com"
    echo "username=x-access-token"
    echo "password=$GITHUB_TOKEN"
  fi
fi
SCRIPT
  chmod +x "$HOME/.git-credential-helper"
  git config --global credential.helper "$HOME/.git-credential-helper"
fi

# Fix podman socket permissions if mounted
if [ -e /var/run/docker.sock ]; then
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# --- Launch agent service ---
exec node /opt/agent-service/dist/agent-service/src/index.js
