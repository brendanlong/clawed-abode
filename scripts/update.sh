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

  echo "==> Pulling latest code"
  git pull --ff-only

  echo "==> Installing dependencies"
  pnpm install --frozen-lockfile

  echo "==> Building"
  pnpm build

  # Migrations run in the unit's ExecStartPre rather than here: Prisma's
  # migration engine takes an exclusive SQLite lock, so it fails with "database
  # is locked" while the server is up, and a separate stop/migrate/start would
  # leave the server down when this script runs inside a session (stopping the
  # server kills every session, including this script).
  if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(systemctl --user)
  elif systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(sudo systemctl)
  else
    echo "==> Applying database migrations"
    pnpm prisma migrate deploy
    echo "No running ${SERVICE_NAME} found — start your server manually."
    echo "==> Done"
    exit 0
  fi

  if ! "${SYSTEMCTL[@]}" show -p ExecStartPre --value "$SERVICE_NAME" | grep -q 'migrate deploy'; then
    echo "${SERVICE_NAME} doesn't run migrations on start. Add this to its [Service] section (see README):" >&2
    echo "  ExecStartPre=$(command -v node) node_modules/prisma/build/index.js migrate deploy" >&2
    exit 1
  fi

  echo "==> Restarting ${SERVICE_NAME} (applies database migrations)"
  "${SYSTEMCTL[@]}" restart "$SERVICE_NAME"

  echo "==> Done"
  exit 0
}
