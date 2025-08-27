FROM rust:1.89-alpine AS builder

WORKDIR /usr/src/backend

# Install build dependencies for Alpine
RUN apk add --no-cache musl-dev pkgconf openssl-dev perl make

# Install sqlx-cli
RUN cargo install sqlx-cli --features=openssl-vendored

# Setup database and build
COPY . .
RUN sqlx database create --database-url sqlite://db.sqlite3 && \
    sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3 && \
    cargo build --release

# Runtime image
FROM alpine:3.22.0

LABEL org.opencontainers.image.authors="andras@schmelczer.dev"

RUN apk add --no-cache curl ca-certificates

COPY --from=builder /usr/src/backend/target/release/sync_server /app/sync_server

VOLUME /data
EXPOSE 3000/tcp
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s \
    CMD curl -f http://localhost:3000/vaults/fake/ping || exit 1

ENTRYPOINT ["/app/sync_server"]