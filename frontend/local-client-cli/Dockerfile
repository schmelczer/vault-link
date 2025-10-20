FROM node:22-slim AS builder

WORKDIR /build

COPY package*.json ./

COPY sync-client/package*.json ./sync-client/
COPY local-client-cli/package*.json ./local-client-cli/

RUN npm ci --workspaces

COPY sync-client/ ./sync-client/
COPY local-client-cli/ ./local-client-cli/

WORKDIR /build/sync-client
RUN npm run build

WORKDIR /build/local-client-cli
RUN npm run build

FROM node:22-alpine

LABEL org.opencontainers.image.title="VaultLink Local CLI"
LABEL org.opencontainers.image.description="Standalone CLI for VaultLink sync client"
LABEL org.opencontainers.image.source="https://github.com/schmelczer/vault-link"
LABEL org.opencontainers.image.licenses="MIT"



COPY --from=builder --chown=vaultlink:vaultlink /build/local-client-cli/dist/cli.js /app/cli.js

WORKDIR /vault

VOLUME ["/vault"]

ENTRYPOINT ["node", "/app/cli.js"]
CMD ["--help"]
