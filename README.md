# Clawed Abode

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

> **Note:** This is an unofficial community project and is not affiliated with, endorsed by, or supported by Anthropic. [Claude Code](https://claude.ai/code) is a product of Anthropic, but this web interface is an independent project.

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

**This application runs Claude Code with `--dangerously-skip-permissions`**, which means Claude can execute arbitrary code, install packages, and modify files without confirmation. You should:

- **Run this on a dedicated machine or dedicated user account** - not your personal workstation
- **Never run as root** - always use a dedicated unprivileged user
- **Use a fine-grained GitHub token** scoped to only the repositories you want to expose
- **Use Tailscale** or similar for remote access - never expose port 3000 directly to the internet

See [Dedicated User Setup](#dedicated-user-setup-recommended) below.

## Prerequisites

- Node.js 20+ and pnpm
- Git
- Claude Code CLI installed and authenticated (`claude setup-token`)
- A GitHub Fine-grained Personal Access Token

## Quick Start

### 1. Create a Dedicated User (Recommended)

```bash
# Create the user
sudo useradd -m -s /bin/bash clawedabode

# Switch to it
sudo -u clawedabode -i
```

### 2. Clone and Install

```bash
git clone https://github.com/brendanlong/clawed-abode.git
cd clawed-abode
pnpm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

- `PASSWORD_HASH`: Base64-encoded Argon2 hash for authentication (see below)
- `GITHUB_TOKEN`: Your GitHub Fine-grained Personal Access Token (see below)
- `CLAUDE_CODE_OAUTH_TOKEN`: OAuth token for Claude Code (see below)

### Generate Claude OAuth Token

```bash
claude setup-token
```

Copy the token and add it to your `.env` file as `CLAUDE_CODE_OAUTH_TOKEN`.

### Generate GitHub Token

Use a **Fine-grained Personal Access Token** for security:

1. Go to https://github.com/settings/personal-access-tokens/new
2. Select "Fine-grained personal access token"
3. Under "Repository access", select "Only select repositories" and choose the repos you want to use
4. Under "Permissions" > "Repository permissions", set:
   - **Contents**: Read and write (for push/pull)
   - **Metadata**: Read-only (automatically included)
5. Generate the token and add it to your `.env` file

### Generate Password Hash

```bash
pnpm hash-password your-secure-password
```

Add the output to your `.env` file:

```bash
PASSWORD_HASH="JGFyZ29uMmlkJHY9MTkkbT02NTUzNix0PTMscD00JC4uLg=="
```

**Note:** Logins will fail if `PASSWORD_HASH` is not set.

### 4. Initialize Database

```bash
npx prisma migrate dev
```

### 5. Start the Application

```bash
# Development
pnpm run dev

# Production
pnpm run build
pnpm start
```

Visit `http://localhost:3000` to access the application.

## Architecture

Sessions run directly on the host machine - no containers. Each session gets its own git clone for isolation.

```
Browser --> Tailscale --> Next.js + tRPC + Claude Agent SDK
                              |
                         ~/worktrees/{sessionId}/{repo}
```

- **Claude Agent SDK** runs in-process in the Next.js server
- **Git clones** at `~/worktrees/{sessionId}/` provide session isolation
- **SQLite** database for session/message persistence
- **SSE** for real-time message streaming to the browser

## Dedicated User Setup (Recommended)

Since Claude Code agents can execute arbitrary code, you should run this as a dedicated unprivileged user - not your personal account.

### 1. Create the user

```bash
sudo useradd -m -s /bin/bash clawedabode
sudo loginctl enable-linger clawedabode
```

### 2. Install Node.js and Claude Code

```bash
sudo -u clawedabode -i

# Install Node.js (e.g., via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20

# Install pnpm
corepack enable && corepack prepare pnpm@latest --activate

# Install and authenticate Claude Code
npm install -g @anthropic-ai/claude-code
claude setup-token
```

### 3. Clone, configure, and start

```bash
# As the clawedabode user:
git clone https://github.com/brendanlong/clawed-abode.git
cd clawed-abode
pnpm install
cp .env.example .env
# Edit .env with your tokens and password hash
npx prisma migrate dev
pnpm run build
pnpm start
```

### 4. Run as a systemd service

First, find the full path to your Node.js binary:

```bash
nvm which 20
# Example output: /home/clawedabode/.nvm/versions/node/v20.19.0/bin/node
```

Create `~/.config/systemd/user/clawed-abode.service`, replacing the node path with the output of `nvm which 20`:

```ini
[Unit]
Description=Clawed Abode
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/clawed-abode
ExecStart=%h/.nvm/versions/node/v20.19.0/bin/node node_modules/next/dist/bin/next start
Restart=always
RestartSec=5
Environment=NODE_ENV=production

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

| Variable                  | Description                                     | Default              |
| ------------------------- | ----------------------------------------------- | -------------------- |
| `PASSWORD_HASH`           | Base64-encoded Argon2 hash for auth             | None (required)      |
| `DATABASE_URL`            | SQLite database path                            | `file:./data/dev.db` |
| `GITHUB_TOKEN`            | GitHub Fine-grained PAT for repo access         | Required             |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (`claude setup-token`)  | Required             |
| `CLAUDE_MODEL`            | Claude model to use                             | `opus[1m]`           |
| `SESSION_BRANCH_PREFIX`   | Prefix for session git branches                 | `claude/`            |
| `ENCRYPTION_KEY`          | 32+ char key for encrypting secrets in settings | None (optional)      |

## Development

```bash
pnpm run dev          # Development mode
pnpm run build        # Production build
pnpm start            # Production server
pnpm run db:migrate   # Run database migrations
pnpm run db:generate  # Generate Prisma client
pnpm test             # Run tests (watch mode)
pnpm test:run         # Run tests (single run)
```

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

Reset the database:

```bash
rm -rf prisma/data
npx prisma migrate dev
```

## License

MIT
