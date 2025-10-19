# Sync server

## Creating/resetting the Database for development

```sh
rm -rf db.sqlite*
sqlx database create --database-url sqlite://db.sqlite3
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
cargo sqlx prepare --workspace
```

## Updating the DB schema through a migration

```sh
sqlx migrate add --source src/app_state/database/migrations <name>
sqlx migrate run --source src/app_state/database/migrations --database-url sqlite://db.sqlite3
```
