FROM rust:1.89-slim-trixie AS builder

ARG TARGETPLATFORM
WORKDIR /usr/src/backend

# Set RUST_TARGET based on platform and create sourceable script
RUN case "$TARGETPLATFORM" in \
        "linux/amd64") echo 'export RUST_TARGET="x86_64-unknown-linux-musl"' > /tmp/rust_env ;; \
        "linux/arm64") echo 'export RUST_TARGET="aarch64-unknown-linux-musl"' > /tmp/rust_env ;; \
        "linux/arm/v7") echo 'export RUST_TARGET="armv7-unknown-linux-musleabihf"' > /tmp/rust_env ;; \
        *) echo "Unsupported platform: $TARGETPLATFORM" && exit 1 ;; \
    esac

# Install musl tools, cross-compilation toolchains, and OpenSSL dev packages
RUN . /tmp/rust_env && \
    apt update && \
    apt install -y musl-tools libssl-dev pkg-config \
        gcc-aarch64-linux-gnu \
        gcc-arm-linux-gnueabi &&\
    rustup target add $RUST_TARGET && \
    cargo install sqlx-cli

# Build application
COPY . .

RUN . /tmp/rust_env && \
    export CFLAGS="-Wno-stringop-overread" && \
    sqlx database create --database-url sqlite://db.sqlite3 && \
    sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3 && \
    cargo build --release --target $RUST_TARGET

# Runtime image
FROM alpine:3.22.0

LABEL org.opencontainers.image.authors="andras@schmelczer.dev"

RUN apk add --no-cache curl ca-certificates

COPY --from=builder /usr/src/backend/target/*/release/sync_server /app/sync_server

VOLUME /data
EXPOSE 3000/tcp
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s \
    CMD curl -f http://localhost:3000/vaults/fake/ping || exit 1

ENTRYPOINT ["/app/sync_server"]
