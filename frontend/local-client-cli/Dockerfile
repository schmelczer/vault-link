FROM node:22-alpine AS builder

WORKDIR /build

# Copy workspace root package files
COPY package*.json ./

# Copy package.json files for each workspace
COPY sync-client/package*.json ./sync-client/
COPY local-client-cli/package*.json ./local-client-cli/

# Install dependencies
RUN npm ci --workspaces

# Copy source code
COPY sync-client/ ./sync-client/
COPY local-client-cli/ ./local-client-cli/

WORKDIR /build/sync-client
RUN npm run build

WORKDIR /build/local-client-cli
RUN npm run build

# Stage 2: Runtime image
FROM node:22-alpine

# Add labels for metadata
LABEL org.opencontainers.image.title="VaultLink Local CLI"
LABEL org.opencontainers.image.description="Standalone CLI for VaultLink sync client"
LABEL org.opencontainers.image.source="https://github.com/schmelczer/vault-link"
LABEL org.opencontainers.image.licenses="MIT"

# Create non-root user
RUN addgroup -g 1001 vaultlink && \
    adduser -D -u 1001 -G vaultlink vaultlink

# Create vault directory
RUN mkdir -p /vault && \
    chown -R vaultlink:vaultlink /vault

# Copy only the built CLI
COPY --from=builder --chown=vaultlink:vaultlink /build/local-client-cli/dist/cli.js /app/cli.js

# Switch to non-root user
USER vaultlink

# Set working directory to vault
WORKDIR /vault

# Volume for vault data
VOLUME ["/vault"]

# Entry point
ENTRYPOINT ["node", "/app/cli.js"]

# Default: show help
CMD ["--help"]
