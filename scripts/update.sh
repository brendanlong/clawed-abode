#!/usr/bin/env bash
# Update a production deployment: pull, install, migrate, build, restart.
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

  echo "==> Applying database migrations"
  pnpm prisma migrate deploy

  echo "==> Building"
  pnpm build

  echo "==> Restarting ${SERVICE_NAME}"
  if systemctl --user is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl --user restart "$SERVICE_NAME"
    echo "Restarted user service ${SERVICE_NAME}"
  elif systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    sudo systemctl restart "$SERVICE_NAME"
    echo "Restarted system service ${SERVICE_NAME}"
  else
    echo "No running ${SERVICE_NAME} found — restart your server manually."
  fi

  echo "==> Done"
  exit 0
}
