#!/usr/bin/env bash
# Update a production deployment: pull, install, build, then stop the
# service, migrate, and start it again.
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

  # Prisma's migration engine takes an exclusive SQLite lock, which fails with
  # "database is locked" while the server holds the database open, so the
  # server has to be down while migrations run.
  if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(systemctl --user)
  elif systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    SYSTEMCTL=(sudo systemctl)
  else
    SYSTEMCTL=()
    echo "No running ${SERVICE_NAME} found — stop any server using the database before migrating."
  fi

  if [ ${#SYSTEMCTL[@]} -gt 0 ]; then
    echo "==> Stopping ${SERVICE_NAME}"
    "${SYSTEMCTL[@]}" stop "$SERVICE_NAME"
  fi

  echo "==> Applying database migrations"
  if ! pnpm prisma migrate deploy; then
    echo "Migrations failed; ${SERVICE_NAME} is left stopped." >&2
    exit 1
  fi

  if [ ${#SYSTEMCTL[@]} -gt 0 ]; then
    echo "==> Starting ${SERVICE_NAME}"
    "${SYSTEMCTL[@]}" start "$SERVICE_NAME"
  else
    echo "Start your server manually."
  fi

  echo "==> Done"
  exit 0
}
