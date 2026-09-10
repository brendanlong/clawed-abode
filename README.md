# Clawed Abode

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

> **Note:** This is an unofficial community project and is not affiliated with, endorsed by, or supported by Anthropic. [Claude Code](https://claude.ai/code) is a product of Anthropic, but this web interface is an independent project.

Read more: [Clawed Abode: Claude Code is Too Cloudy](https://www.brendanlong.com/claude-code-is-too-cloudy.html)

## Features

- Run Claude Code sessions from any device with a web browser
- Access local GPU resources for AI workloads
- Persistent sessions with isolated git clones
- Simple password-based authentication (single user)
- Session tracking with IP addresses and login history
- Clean session lifecycle management
- Mobile-friendly interface
- Voice input/output using browser Web Speech APIs

## Security Warning

**This application runs Claude Code in `bypassPermissions` mode**, which means Claude can execute arbitrary code, install packages, and modify files without confirmation. You should:

- **Run this on a dedicated machine or dedicated user account** - not your personal workstation
- **Never run as root** - always use a dedicated unprivileged user
- **Use a fine-grained GitHub token** scoped to only the repositories you want to expose
- **Use Tailscale** or similar for remote access - never expose port 3000 directly to the internet

See [Setup](#setup) below.

## Prerequisites

- A Linux host with systemd user services (for the session process scopes and the service unit), `sudo` for creating the user, and Git 2.31+ (clones pass credentials via `GIT_CONFIG_*`)
- Node.js 22 (20.19+ works); the setup below installs it via nvm

## Setup

Claude Code agents can execute arbitrary code, so run the app as a dedicated unprivileged user — not your personal account.

### 1. Create the user

```bash
sudo useradd -m -s /bin/bash clawedabode
# Let the user's systemd services run without a login session
sudo loginctl enable-linger clawedabode
sudo -u clawedabode -i
```

### 2. Install Node.js, pnpm and Claude Code

```bash
# Install Node.js (e.g., via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22

# Install pnpm
corepack enable && corepack prepare pnpm@latest --activate

# Install and authenticate Claude Code
npm install -g @anthropic-ai/claude-code
claude setup-token
```

### 3. Clone and configure

```bash
git clone https://github.com/brendanlong/clawed-abode.git
cd clawed-abode
pnpm install
cp .env.example .env
```

Edit `.env` and set `PASSWORD_HASH`, `GITHUB_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` as described below. The full variable list is under [Configuration](#configuration).

#### Generate Claude OAuth Token

Copy the token printed by `claude setup-token` in step 2 (run it again if you need to) into `.env` as `CLAUDE_CODE_OAUTH_TOKEN`. It can also be set later in the Settings UI.

#### Generate GitHub Token

Use a **Fine-grained Personal Access Token** for security:

1. Go to https://github.com/settings/personal-access-tokens/new
2. Select "Fine-grained personal access token"
3. Under "Repository access", select "Only select repositories" and choose the repos you want to use
4. Under "Permissions" > "Repository permissions", set:
   - **Contents**: Read and write (for push/pull, and to list branches)
   - **Metadata**: Read-only (automatically included)
   - **Issues**: Read-only (to browse issues when starting a session)
   - **Pull requests**: Read-only (for the session PR status indicator)
5. Generate the token and add it to your `.env` file

Public repos work even without these permissions, so a token missing **Contents**
only fails on private repos — where branch listing and cloning break.

#### Generate Password Hash

```bash
pnpm hash-password your-secure-password
```

Add the output to your `.env` file:

```bash
PASSWORD_HASH="JGFyZ29uMmlkJHY9MTkkbT02NTUzNix0PTMscD00JC4uLg=="
```

**Note:** Logins will fail if `PASSWORD_HASH` is not set.

### 4. Initialize the database

```bash
pnpm prisma migrate deploy
```

### 5. Build and start

```bash
pnpm run build
pnpm start
```

Visit `http://localhost:3000` from the server itself (see [Remote Access](#remote-access-with-tailscale) for the URL to use from other devices). For development use `pnpm run dev` instead.

### 6. Run as a systemd service

Stop the foreground server from step 5 first (Ctrl-C); the service binds the same port.

First, find the full path to your Node.js binary:

```bash
nvm which 22
# Example output: /home/clawedabode/.nvm/versions/node/v22.22.1/bin/node
```

Create `~/.config/systemd/user/clawed-abode.service`, replacing the node path with the output of `nvm which 22`:

```ini
[Unit]
Description=Clawed Abode
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/clawed-abode
ExecStart=%h/.nvm/versions/node/v22.22.1/bin/node node_modules/next/dist/bin/next start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
# Listen on loopback only: Tailscale Serve is the sole ingress, so the
# X-Forwarded-For header used for login rate limiting is always the one it sets.
Environment=HOSTNAME=127.0.0.1

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now clawed-abode.service
```

### Viewing Logs

```bash
journalctl --user -u clawed-abode.service -f
```

### Updating

```bash
./scripts/update.sh
```

This pulls the latest code, installs dependencies, applies database migrations, rebuilds, and restarts the service. A plain `git pull` + restart is **not** enough — `next start` serves the prebuilt `.next` bundle, so without a rebuild you keep running the old code. If your service isn't named `clawed-abode.service`, set `CLAWED_ABODE_SERVICE`.

## Architecture

Sessions run directly on the host machine - no containers. Each session gets its own git clone for isolation. See [`doc/DESIGN.md`](doc/DESIGN.md) for the design and the reference docs it links to.

## Remote Access with Tailscale

### Tailscale Serve (within your Tailnet)

```bash
tailscale serve 3000
```

Access at `https://<machine-name>.<tailnet-name>.ts.net`

### Tailscale Funnel (public internet)

```bash
tailscale funnel 3000
```

**Note:** HTTPS is required for clipboard copy and browser notifications.

## Configuration

### Environment Variables

The schema in [`src/lib/env.ts`](src/lib/env.ts) is authoritative; it is validated once at startup and the server refuses to boot on an invalid value.

| Variable                  | Description                                                                                                   | Default              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| `PASSWORD_HASH`           | Base64-encoded Argon2 hash for auth; logins fail without it                                                   | None                 |
| `DATABASE_URL`            | SQLite database path                                                                                          | `file:./data/dev.db` |
| `GITHUB_TOKEN`            | GitHub Fine-grained PAT; without it repo/branch/issue pickers and PR status are unavailable                   | None                 |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (`claude setup-token`); can instead be set in the Settings UI                         | None                 |
| `CLAUDE_MODEL`            | Default Claude model (overridable per repo/session in Settings)                                               | `opus[1m]`           |
| `SESSION_BRANCH_PREFIX`   | Prefix for session git branches                                                                               | `claude/`            |
| `ENCRYPTION_KEY`          | 32+ char key for encrypting secrets; required before any secret env var or MCP header can be saved            | None                 |
| `APP_URL`                 | Public URL the browser reaches this app on; only used to build the MCP OAuth redirect URI                     | Derived from request |
| `CODE_SERVER_URL`         | Base URL of a code-server instance; enables the "Open in VS Code" button (see `scripts/setup-code-server.sh`) | None                 |
| `LOG_LEVEL`               | Minimum server log level: `debug`, `info`, `warn`, or `error`                                                 | `info`               |

## Development

`pnpm run dev` starts the dev server with hot reload; `pnpm test:run` runs every test suite (what CI runs). After editing `prisma/schema.prisma`, `pnpm run db:migrate` creates and applies a migration (production applies them with `prisma migrate deploy` via `scripts/update.sh`). Contributor rules and the design docs are in [`CLAUDE.md`](CLAUDE.md) and [`doc/DESIGN.md`](doc/DESIGN.md).

## Troubleshooting

### Permission denied creating worktrees

The application creates session workspaces at `~/worktrees/`. Make sure the user running the application has write access to their home directory.

### Claude Code authentication errors

```bash
# Check if Claude is authenticated
claude --version

# Re-authenticate if needed
claude setup-token
```

### Database errors

Reset the database (this deletes all sessions and messages):

```bash
rm -rf data
pnpm prisma migrate deploy
```

## License

MIT
