FROM rust:1.90-slim-trixie AS builder

WORKDIR /usr/src/backend

RUN apt update && \
    apt install -y libssl-dev pkg-config && \
    cargo install sqlx-cli

# Build application
COPY . .

RUN sqlx database create --database-url sqlite://db.sqlite3 && \
    sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3 && \
    cargo build --release

FROM debian:trixie-slim

LABEL org.opencontainers.image.authors="andras@schmelczer.dev"

RUN apt update && \
    apt install -y curl ca-certificates && \
    apt clean && \
    rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/backend/target/release/sync_server /app/sync_server

VOLUME /data
EXPOSE 3000/tcp
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s \
    CMD curl -f http://localhost:3000/vaults/fake/ping || exit 1

ENTRYPOINT ["/app/sync_server"]
