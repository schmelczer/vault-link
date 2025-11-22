# Authentication Configuration

VaultLink uses token-based authentication with per-user vault access control. This guide covers all authentication and authorization options.

## Overview

Authentication in VaultLink:

- **Token-based**: Users authenticate with secure tokens
- **Configured in YAML**: All users defined in `config.yml`
- **Vault-level access**: Control which vaults each user can access
- **No password hashing**: Tokens are treated as secrets

## Basic Configuration

```yaml
users:
    user_configs:
        - name: alice
          token: alice-secure-token-here
          vault_access:
              type: allow_access_to_all
```

## User Configuration Fields

### `name`

**Type**: String
**Required**: Yes

Human-readable identifier for the user. Used in logs and auditing.

```yaml
- name: alice
```

**Notes**:

- Must be unique across all users
- Used for identification only, not authentication
- Appears in server logs
- Can be any string (e.g., email, username)

### `token`

**Type**: String
**Required**: Yes

Authentication token for the user. Must be kept secret.

```yaml
- token: 1a2b3c4d5e6f7g8h9i0j...
```

**Best practices**:

- Generate with: `openssl rand -hex 32`
- Minimum length: 32 characters
- Use different token per user
- Never commit to version control
- Rotate periodically

**Example token generation**:

```bash
# Generate a secure token
openssl rand -hex 32
# Output: a7f3c9d1e8b2f4a6c3d9e1f7b8a4c2d6e9f1a3b7c5d8e2f4a6b9c3d1e8f7a4b2
```

### `vault_access`

**Type**: Object
**Required**: Yes

Defines which vaults the user can access.

**Three modes**:

1. `allow_access_to_all`: Access to all vaults
2. `allow_list`: Access to specific vaults only
3. `deny_list`: Access to all vaults except specific ones

## Access Control Modes

### Allow Access to All

Grant access to every vault:

```yaml
users:
    user_configs:
        - name: admin
          token: admin-token
          vault_access:
              type: allow_access_to_all
```

**Use cases**:

- Administrator accounts
- Personal single-user deployments
- Development/testing

### Allow List

Grant access only to specific vaults:

```yaml
users:
    user_configs:
        - name: alice
          token: alice-token
          vault_access:
              type: allow_list
              allowed:
                  - personal
                  - shared-team
                  - project-alpha
```

**Use cases**:

- Multi-user deployments
- Restricted access scenarios
- Separation of concerns

**Notes**:

- User can only access listed vaults
- Attempting to access other vaults returns authentication error
- Empty list = no access to any vault

### Deny List

Grant access to all vaults except specific ones:

```yaml
users:
    user_configs:
        - name: bob
          token: bob-token
          vault_access:
              type: deny_list
              denied:
                  - restricted
                  - admin-only
```

**Use cases**:

- Users with broad access except sensitive vaults
- Simplify configuration when most vaults are accessible

**Notes**:

- User can access any vault not in the deny list
- Attempting to access denied vaults returns authentication error

## Multi-User Scenarios

### Personal Use (Single User)

```yaml
users:
    user_configs:
        - name: me
          token: my-super-secret-token
          vault_access:
              type: allow_access_to_all
```

### Small Team (Shared Vaults)

```yaml
users:
    user_configs:
        - name: alice
          token: alice-token
          vault_access:
              type: allow_list
              allowed:
                  - personal-alice
                  - team-shared
        - name: bob
          token: bob-token
          vault_access:
              type: allow_list
              allowed:
                  - personal-bob
                  - team-shared
        - name: charlie
          token: charlie-token
          vault_access:
              type: allow_list
              allowed:
                  - personal-charlie
                  - team-shared
```

### Organization (Mixed Access)

```yaml
users:
    user_configs:
        - name: admin
          token: admin-token
          vault_access:
              type: allow_access_to_all

        - name: developer
          token: dev-token
          vault_access:
              type: allow_list
              allowed:
                  - engineering-docs
                  - api-specs
                  - shared

        - name: designer
          token: design-token
          vault_access:
              type: allow_list
              allowed:
                  - design-docs
                  - brand-assets
                  - shared

        - name: readonly
          token: readonly-token
          vault_access:
              type: allow_list
              allowed:
                  - public-wiki
```

## Authentication Flow

### Connection

1. Client connects via WebSocket
2. Client sends authentication message:
    ```json
    {
    	"type": "auth",
    	"token": "user-token",
    	"vault": "vault-name"
    }
    ```
3. Server validates:
    - Token exists in config
    - User has access to requested vault
4. Server responds:
    - Success: Connection established
    - Failure: Connection closed with error

### Validation

Server checks:

1. **Token match**: Token exists in `user_configs`
2. **Vault access**: User has permission for vault
3. **Connection limits**: Not exceeding `max_clients_per_vault`

### Errors

**Invalid token**:

```
Authentication failed: Invalid token
```

**No vault access**:

```
Authentication failed: User does not have access to vault 'restricted'
```

**Connection limit**:

```
Connection rejected: Maximum clients reached for vault
```

## Security Best Practices

### Token Generation

Generate strong tokens:

```bash
# 64 character hex token (256 bits)
openssl rand -hex 32

# Base64 encoded (256 bits)
openssl rand -base64 32

# UUID v4
uuidgen
```

### Token Storage

**In config file**:

```yaml
users:
    user_configs:
        - name: alice
          token: !ENV ALICE_TOKEN # Read from environment variable
```

**Load from environment**:

```bash
export ALICE_TOKEN="$(openssl rand -hex 32)"
./sync_server config.yml
```

### Token Rotation

Periodically change tokens:

1. Generate new token
2. Update `config.yml`
3. Restart server
4. Update clients with new token

### Token Revocation

To revoke access:

1. Remove user from `config.yml`
2. Restart server
3. User's connections will be rejected

For immediate revocation:

- Remove user from config
- Restart server
- Existing connections are terminated

## Access Patterns

### Read-Only Users

VaultLink doesn't distinguish read-only vs read-write. Implement via client:

```yaml
# Server: Grant access
users:
  user_configs:
  - name: readonly
    token: readonly-token
    vault_access:
      type: allow_list
      allowed:
        - public

# Client: Use CLI in read-only mode (mount vault read-only)
docker run -v /vault:/vault:ro ...
```

### Temporary Access

Grant temporary access:

1. Add user to config
2. Set reminder to remove later
3. Remove user when no longer needed
4. Restart server

For automation:

```bash
# Add user with expiry comment
echo "  - name: temp-user  # EXPIRES: 2024-12-31" >> config.yml
echo "    token: temp-token" >> config.yml
```

### Shared Tokens (Not Recommended)

Multiple users sharing a token:

- All appear as same user in logs
- Can't revoke individual access
- Security risk if one person leaves

**Instead**: Create separate users with same vault access.

## Monitoring

### Server Logs

Authentication events are logged:

```
2024-01-01 12:00:00 INFO User 'alice' authenticated for vault 'personal'
2024-01-01 12:00:05 WARN Authentication failed: Invalid token from 192.168.1.100
2024-01-01 12:00:10 WARN User 'bob' denied access to vault 'restricted'
```

### Audit Trail

Monitor authentication:

```bash
# View authentication logs
grep "authenticated" logs/*.log

# View failed authentications
grep "Authentication failed" logs/*.log

# View access denials
grep "denied access" logs/*.log
```

## Advanced Scenarios

### Multiple Servers

Same user across multiple server instances:

```yaml
# Server 1 config.yml
users:
  user_configs:
  - name: alice
    token: alice-global-token
    vault_access:
      type: allow_list
      allowed:
        - vault-1
        - vault-2

# Server 2 config.yml
users:
  user_configs:
  - name: alice
    token: alice-global-token  # Same token
    vault_access:
      type: allow_list
      allowed:
        - vault-3
        - vault-4
```

### Service Accounts

Tokens for automated systems:

```yaml
users:
    user_configs:
        - name: backup-service
          token: backup-service-token
          vault_access:
              type: allow_access_to_all

        - name: ci-pipeline
          token: ci-token
          vault_access:
              type: allow_list
              allowed:
                  - documentation

        - name: monitoring
          token: monitoring-token
          vault_access:
              type: allow_list
              allowed:
                  - metrics
```

### Dynamic Vault Access

VaultLink doesn't support runtime user management. To change access:

1. Update `config.yml`
2. Restart server
3. Users reconnect automatically

For frequent changes, consider:

- Over-provision access (deny list)
- Use external authentication proxy
- Script config updates + reload

## Troubleshooting

### Can't connect

**Check token**:

```bash
# Verify token in config matches client
grep "token:" config.yml
```

**Check vault name**:

```bash
# Ensure vault is in allowed list
grep -A 5 "name: alice" config.yml
```

**Check server logs**:

```bash
tail -f logs/*.log | grep -i auth
```

### Access denied

**Verify vault access**:

```yaml
# Check user's vault_access configuration
users:
    user_configs:
        - name: alice
          vault_access:
              type: allow_list
              allowed:
                  - vault-name # Must match exactly
```

**Case sensitivity**:

- Vault names are case-sensitive
- `Vault` ≠ `vault`
- Ensure exact match in config and client

### Token not working

**Check for typos**:

- Extra spaces
- Hidden characters
- Wrong quotes in YAML

**Regenerate token**:

```bash
# Generate new token
openssl rand -hex 32

# Update config
# Restart server
# Update client
```

## Next Steps

- [Server configuration reference →](/config/server)
- [Advanced configuration →](/config/advanced)
- [Deploy the server →](/guide/server-setup)
