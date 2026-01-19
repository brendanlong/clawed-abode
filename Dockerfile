FROM node:20-slim

# Install dependencies for Prisma
RUN apt-get update && apt-get install -y \
    openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci

# Generate Prisma client
RUN npx prisma generate

# Copy source code
COPY . .

# Build Next.js application
RUN npm run build

# Create data directory
RUN mkdir -p /data/db /data/repos /data/worktrees

# Expose port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
