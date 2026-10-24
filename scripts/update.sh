#!/usr/bin/env bash
# Update a production deployment: pull, install, build, restart (the service
# applies migrations before starting).
# Run from anywhere; operates on the repo this script lives in.
#
# The whole body is wrapped in braces so bash parses it fully before
# executing — otherwise `git pull` rewriting this file mid-run could
# make bash execute garbage from the new version.
{
  set -euo pipefail

  cd "$(dirname "${BASH_SOURCE[0]}")/.."

  SERVICE_NAME="${CLAWED_ABODE_SERVICE:-clawed-abode.service}"
  # The Node `pnpm install` downloads (devEngines.runtime in package.json). Native
  # modules are built for it, so the service must run exactly this binary.
  NODE_BIN="$PWD/node_modules/node/bin/node"

  echo "==> Pulling latest code"
  git pull --ff-only

  if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(systemctl --user)
  elif systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(sudo systemctl)
  else
    SYSTEMCTL=()
  fi

  # Checked before installing: an install for a different Node than the running
  # service's would break the service at its next restart, not just this update.
  if [ ${#SYSTEMCTL[@]} -gt 0 ]; then
    # Migrations run in the unit's ExecStartPre rather than here: Prisma's
    # migration engine takes an exclusive SQLite lock, so it fails with "database
    # is locked" while the server is up, and a separate stop/migrate/start would
    # leave the server down when this script runs inside a session (stopping the
    # server kills every session, including this script).
    pre=$("${SYSTEMCTL[@]}" show -p ExecStartPre --value "$SERVICE_NAME")
    start=$("${SYSTEMCTL[@]}" show -p ExecStart --value "$SERVICE_NAME")
    if ! grep -q 'migrate deploy' <<<"$pre" || ! grep -qF "path=$NODE_BIN " <<<"$pre" \
      || ! grep -qF "path=$NODE_BIN " <<<"$start" || ! grep -q -- '-H 127.0.0.1' <<<"$start"; then
      echo "${SERVICE_NAME} must match the README's unit. Set these in its [Service] section," >&2
      echo "then run 'systemctl --user daemon-reload' and re-run this script:" >&2
      echo "  ExecStartPre=$NODE_BIN node_modules/prisma/build/index.js migrate deploy" >&2
      echo "  ExecStart=$NODE_BIN node_modules/next/dist/bin/next start -H 127.0.0.1" >&2
      exit 1
    fi
  fi

  echo "==> Installing dependencies"
  pnpm install --frozen-lockfile

  echo "==> Building"
  pnpm build

  if [ ${#SYSTEMCTL[@]} -eq 0 ]; then
    echo "==> Applying database migrations"
    pnpm prisma migrate deploy
    echo "No running ${SERVICE_NAME} found — start your server manually."
    echo "==> Done"
    exit 0
  fi

  echo "==> Restarting ${SERVICE_NAME} (applies database migrations)"
  "${SYSTEMCTL[@]}" restart "$SERVICE_NAME"

  echo "==> Done"
  exit 0
}
