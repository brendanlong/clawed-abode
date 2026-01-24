FROM docker.io/node:24-slim

# Install dependencies for Prisma, git for cloning, podman for container management,
# and sudo for copying files with restricted permissions
RUN apt-get update && apt-get install -y \
    openssl \
    git \
    podman \
    sudo \
    && rm -rf /var/lib/apt/lists/* \
    && echo "node ALL=(ALL) NOPASSWD: /usr/bin/podman" > /etc/sudoers.d/node-podman \
    && chmod 0440 /etc/sudoers.d/node-podman

# Create corepack cache directory with proper permissions for rootless podman
# This prevents "EACCES: permission denied, mkdir '/home/node/.cache/node/corepack/v1'" errors
RUN mkdir -p /home/node/.cache/node/corepack && \
    chown -R node:node /home/node/.cache

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Generate Prisma client
RUN pnpm run db:generate

# Copy source code
COPY . .

# Build Next.js application
RUN pnpm run build

# Create data directories and set ownership to node user (UID 1000)
# /data/db - SQLite database (typically a named volume in production)
# /data/workspaces - Session workspaces (bind-mounted from host in production)
RUN mkdir -p /data/db /data/workspaces && \
    chown -R node:node /data /app

# Switch to non-root user for security
USER node

# Expose port
EXPOSE 3000

# Start the application (run migrations first, then start)
CMD ["sh", "-c", "npx prisma migrate deploy && pnpm start"]
