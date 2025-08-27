FROM rust:1.89 AS builder

WORKDIR /usr/src/backend

RUN apt update && apt install -y musl-tools
RUN cargo install sqlx-cli

COPY . .

RUN sqlx database create --database-url sqlite://db.sqlite3
RUN sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3

RUN cargo build --release --target x86_64-unknown-linux-musl

# Runtime image
FROM alpine:3.22.1

LABEL org.opencontainers.image.authors="andras@schmelczer.dev"

RUN apk add --no-cache curl

COPY --from=builder /usr/src/backend/target/x86_64-unknown-linux-musl/release/sync_server /app/sync_server

VOLUME /data
EXPOSE 3000/tcp
WORKDIR /data

HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    CMD curl -f http://localhost:3000/vaults/fake/ping || exit 1

ENTRYPOINT ["/app/sync_server"]
