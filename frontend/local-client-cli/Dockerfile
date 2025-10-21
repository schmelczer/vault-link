FROM node:22-slim AS builder

WORKDIR /build

COPY . .

RUN npm ci
RUN npm run build

FROM node:22-alpine

LABEL org.opencontainers.image.title="VaultLink Local CLI"
LABEL org.opencontainers.image.description="Standalone CLI for VaultLink sync client"
LABEL org.opencontainers.image.source="https://github.com/schmelczer/vault-link"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.authors="andras@schmelczer.dev"



COPY --from=builder --chown=vaultlink:vaultlink /build/local-client-cli/dist/cli.js /app/cli.js

WORKDIR /vault

VOLUME ["/vault"]

ENTRYPOINT ["node", "/app/cli.js"]
CMD ["--help"]
