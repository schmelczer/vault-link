FROM node:25-slim AS builder

WORKDIR /build

COPY . .

RUN npm ci
RUN npm run build

FROM node:25-alpine

LABEL org.opencontainers.image.title="VaultLink Local CLI"
LABEL org.opencontainers.image.description="Standalone CLI for VaultLink sync client"
LABEL org.opencontainers.image.source="https://github.com/schmelczer/vault-link"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.authors="andras@schmelczer.dev"

COPY --from=builder /build/local-client-cli/dist/cli.js /app/cli.js
COPY --from=builder /build/local-client-cli/dist/healthcheck.js /app/healthcheck.js

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=1 \
    CMD node /app/healthcheck.js /tmp/vaultlink-health.json

WORKDIR /vault

VOLUME ["/vault"]

ENTRYPOINT ["node", "/app/cli.js", "--health", "/tmp/vaultlink-health.json"]
CMD ["--help"]
