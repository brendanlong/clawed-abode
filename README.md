# Clawed Burrow

A place for [clawed creatures](https://claude.ai/code) that run far from the cloud.

> **Note:** This is an unofficial community project and is not affiliated with, endorsed by, or supported by Anthropic. [Claude Code](https://claude.ai/code) is a product of Anthropic, but this web interface is an independent project.

A self-hosted web application that provides mobile-friendly access to Claude Code running on your local machine with GPU support.

## Features

- Run Claude Code sessions from any device with a web browser
- Access local GPU resources for AI workloads
- Persistent sessions with isolated git clones
- Simple password-based authentication (single user)
- Session tracking with IP addresses and login history
- Clean session lifecycle management
- Mobile-friendly interface
- **Rootless containers** - Claude Code agents have sudo access inside containers without root on the host

## Prerequisites

- Node.js 20+
- Podman with NVIDIA Container Toolkit (for GPU support)
- A GitHub Fine-grained Personal Access Token (recommended for security)
- Claude Code installed and authenticated on your host machine

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/brendanlong/clawed-burrow.git
cd clawed-burrow
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and set:

- `PASSWORD_HASH`: Base64-encoded Argon2 hash for authentication (see below)
- `GITHUB_TOKEN`: Your GitHub Fine-grained Personal Access Token (see below)
- `CLAUDE_AUTH_PATH`: Path to your Claude Code auth (usually `~/.claude`)

### Generate GitHub Token

For security, use a **Fine-grained Personal Access Token** instead of a classic token:

1. Go to https://github.com/settings/personal-access-tokens/new
2. Select "Fine-grained personal access token"
3. Under "Repository access", select "Only select repositories" and choose the repos you want to use
4. Under "Permissions" → "Repository permissions", set:
   - **Contents**: Read and write (for push/pull)
   - **Metadata**: Read-only (automatically included)
5. Generate the token and add it to your `.env` file

### Generate Password Hash

Generate a base64-encoded Argon2 hash of your password:

```bash
pnpm hash-password your-secure-password
```

Add the output to your `.env` file:

```bash
PASSWORD_HASH="JGFyZ29uMmlkJHY9MTkkbT02NTUzNix0PTMscD00JC4uLg=="
```

The hash is base64-encoded to avoid issues with `$` characters in dotenv.

**Note:** Logins will fail if `PASSWORD_HASH` is not set.

### 3. Initialize Database

```bash
npx prisma migrate dev
```

### 4. Build the Claude Code Runner Image

```bash
pnpm run docker:build
```

### 5. Start the Application

```bash
pnpm run dev
```

Visit `http://localhost:3000` to access the application.

## Production Deployment

### Using Podman Compose

```bash
# Set environment variables
export GITHUB_TOKEN=your_github_token
export PASSWORD_HASH="your_base64_hash"

# Enable the Podman socket (required for container management)
systemctl --user enable --now podman.socket

# Start services
cd docker
podman-compose up -d
```

### Automatic Updates with Podman

Instead of Watchtower, use Podman's built-in auto-update feature:

```bash
# Enable the auto-update timer (checks daily at midnight)
systemctl --user enable --now podman-auto-update.timer

# Or run updates manually
podman auto-update
```

The compose file includes the `io.containers.autoupdate=registry` label which tells Podman to check for new images automatically.

### With Tailscale Funnel (for secure remote access)

Tailscale Funnel allows secure remote access without exposing ports or requiring traditional VPN setup.

1. **Install Tailscale** on your server: https://tailscale.com/download

2. **Enable Funnel** for your machine:

   ```bash
   # Enable HTTPS and Funnel in Tailscale admin console first
   # Then expose your app:
   tailscale funnel 3000
   ```

3. **Access your app** at `https://<machine-name>.<tailnet-name>.ts.net`

For persistent Funnel configuration, see the [Tailscale Funnel documentation](https://tailscale.com/kb/1223/funnel).

## Configuration

### Environment Variables

| Variable           | Description                             | Default              |
| ------------------ | --------------------------------------- | -------------------- |
| `PASSWORD_HASH`    | Base64-encoded Argon2 hash for auth     | None (required)      |
| `DATABASE_URL`     | SQLite database path                    | `file:./data/dev.db` |
| `GITHUB_TOKEN`     | GitHub Fine-grained PAT for repo access | Required             |
| `CLAUDE_AUTH_PATH` | Path to Claude Code auth directory      | `/root/.claude`      |
| `DATA_DIR`         | Directory for session workspaces        | `/data`              |
| `NODE_ENV`         | Node environment                        | `development`        |

### GPU Support

The application uses NVIDIA Container Toolkit with CDI (Container Device Interface) for GPU access. Ensure you have:

1. **NVIDIA drivers installed** - verify with `nvidia-smi`

2. **Podman installed:**

   ```bash
   # Ubuntu/Debian
   sudo apt-get install -y podman fuse-overlayfs slirp4netns uidmap

   # Fedora
   sudo dnf install -y podman
   ```

3. **NVIDIA Container Toolkit installed:**

   ```bash
   # Add the NVIDIA container toolkit repository
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
     sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

   curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

   # Install the toolkit
   sudo apt-get update
   sudo apt-get install -y nvidia-container-toolkit
   ```

4. **Generate CDI specification for Podman:**

   ```bash
   # Generate CDI spec (must be run as root)
   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

   # Verify the spec was created
   ls -la /etc/cdi/nvidia.yaml
   ```

   **Note:** You need to regenerate the CDI spec after NVIDIA driver updates or GPU changes.

5. **Verify GPU access in Podman:**

   ```bash
   podman run --rm --device nvidia.com/gpu=all --security-opt=label=disable \
     nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

   This should display your GPU information if everything is configured correctly.

### Rootless Podman Setup

For rootless operation (recommended for security):

1. **Enable the user Podman socket:**

   ```bash
   systemctl --user enable --now podman.socket
   ```

2. **Verify the socket is running:**

   ```bash
   ls -la /run/user/$(id -u)/podman/podman.sock
   ```

3. **Configure subuid/subgid** (if not already done):

   ```bash
   # Check if your user has subuid/subgid ranges
   grep $USER /etc/subuid /etc/subgid

   # If not, add them:
   sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
   ```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Mobile/Web    │     │   Tailscale     │     │      Home Server            │
│   Browser       │────►│   Funnel        │────►│  ┌─────────────────────┐    │
│                 │     │                 │     │  │   Next.js + tRPC    │    │
└─────────────────┘     └─────────────────┘     │  │   - Auth            │    │
                                                │  │   - Session mgmt    │    │
                                                │  │   - WebSocket/SSE   │    │
                                                │  └──────────┬──────────┘    │
                                                │             │               │
                                                │  ┌──────────▼──────────┐    │
                                                │  │  Podman Containers  │    │
                                                │  │  ┌───────────────┐  │    │
                                                │  │  │ Claude Code   │  │    │
                                                │  │  │ + Git Clone   │  │    │
                                                │  │  │ + GPU access  │  │    │
                                                │  │  │ + sudo access │  │    │
                                                │  │  └───────────────┘  │    │
                                                │  └─────────────────────┘    │
                                                └─────────────────────────────┘
```

## Development

```bash
# Run in development mode
pnpm run dev

# Run database migrations
pnpm run db:migrate

# Generate Prisma client
pnpm run db:generate

# Build for production
pnpm run build

# Start production server
pnpm start
```

## Security Considerations

- Single-user authentication via Argon2-hashed password stored in environment variable
- Database-backed sessions with random tokens (256-bit entropy)
- Session tracking includes IP addresses and user agents for audit purposes
- Claude Code runs with `--dangerously-skip-permissions` inside isolated containers
- Each session has its own container with an isolated git clone
- Use Fine-grained PATs scoped to specific repos with minimal permissions
- **Rootless Podman**: Claude Code agents have sudo access inside containers, but this doesn't grant root on the host
- Podman socket access is provided for container-in-container capability
- Use Tailscale Funnel or similar for secure remote access (don't expose port 3000 directly)

## Troubleshooting

### Container won't start with GPU

1. **Verify CDI spec exists:**

   ```bash
   ls -la /etc/cdi/nvidia.yaml
   ```

   If missing, generate it:

   ```bash
   sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
   ```

2. **Test GPU access directly:**

   ```bash
   podman run --rm --device nvidia.com/gpu=all --security-opt=label=disable \
     nvidia/cuda:12.1.0-base-ubuntu22.04 nvidia-smi
   ```

3. **Check nvidia-container-toolkit version:**

   ```bash
   nvidia-ctk --version
   ```

   CDI support requires nvidia-container-toolkit 1.12.0 or later.

### Podman socket not found

```bash
# Enable and start the user socket
systemctl --user enable --now podman.socket

# Verify it's running
systemctl --user status podman.socket
```

### Claude Code authentication errors

Make sure your Claude Code auth is properly mounted:

```bash
# Check if auth exists
ls -la ~/.claude/

# The directory should contain authentication tokens
```

### Database errors

Reset the database:

```bash
rm -rf prisma/data
npx prisma migrate dev
```

### Podman auto-update not working

1. **Verify the container has the auto-update label:**

   ```bash
   podman inspect <container> | grep -A5 autoupdate
   ```

2. **Check the timer status:**

   ```bash
   systemctl --user status podman-auto-update.timer
   ```

3. **Run a dry-run to see what would be updated:**

   ```bash
   podman auto-update --dry-run
   ```

## License

MIT
