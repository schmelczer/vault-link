# VaultLink self-hosted Obsidian plugin for file syncing

[![Check](https://github.com/schmelczer/vault-link/actions/workflows/check.yml/badge.svg)](https://github.com/schmelczer/vault-link/actions/workflows/check.yml)
[![E2E tests](https://github.com/schmelczer/vault-link/actions/workflows/e2e.yml/badge.svg)](https://github.com/schmelczer/vault-link/actions/workflows/e2e.yml)
[![Publish server Docker image](https://github.com/schmelczer/vault-link/actions/workflows/publish-server-docker.yml/badge.svg)](https://github.com/schmelczer/vault-link/actions/workflows/publish-server-docker.yml)
[![Publish CLI](https://github.com/schmelczer/vault-link/actions/workflows/publish-cli-docker.yml/badge.svg)](https://github.com/schmelczer/vault-link/actions/workflows/publish-cli-docker.yml)
[![Publish Obsidian plugin](https://github.com/schmelczer/vault-link/actions/workflows/publish-plugin.yml/badge.svg)](https://github.com/schmelczer/vault-link/actions/workflows/publish-plugin.yml)

## Develop

### Set up Node.JS 25 with [nvm](https://github.com/nvm-sh/nvm)

- `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`
- `nvm install 25`
- `nvm use 25`
- Optionally, set the system-wide default: `nvm alias default 25`

### Set up Rust

- Install [`rustup`](https://rustup.rs): `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Install [`wasm-pack`](https://rustwasm.github.io/wasm-pack/installer): `curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`
- `cargo install cargo-insta sqlx-cli`

### Install Obsidian on Linux

```sh
apt install flatpak
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install flathub md.obsidian.Obsidian
flatpak run md.obsidian.Obsidian
```

#### Run in development mode

Start the server:

```sh
cargo install sqlx-cli
cd sync-server
cargo run config-e2e.yml
```

```sh
cd frontend
npm install
npm run dev
```

### Common Tasks

This project uses [Taskfile](https://taskfile.dev/) for task automation. Run `task --list` to see all available tasks.

#### Before pushing

```sh
task check:fix
```

#### Update HTTP API TS bindings

```sh
task update-api-types
```

#### Publish new version

```sh
task release:bump -- patch
```

#### Run E2E tests

```sh
task e2e -- 8
```

And to clean up the logs & database files, run `task clean`

## Projects

- [Sync server](./sync-server/README.md)


remove force merge everywhere
