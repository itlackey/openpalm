# OpenPalm Vault

Secrets and environment configuration for the OpenPalm stack.

## Quick start

```bash
# Copy vault directory to your OpenPalm home
mkdir -p ~/.openpalm/vault/stack ~/.openpalm/vault/user

# Copy and edit the environment files
cp vault/stack.env.example ~/.openpalm/vault/stack/stack.env
cp vault/user.env.example  ~/.openpalm/vault/user/user.env

# Edit with your values
$EDITOR ~/.openpalm/vault/stack/stack.env   # Set OP_ADMIN_TOKEN, paths
$EDITOR ~/.openpalm/vault/user/user.env     # Set LLM API keys
```

## Structure

| File | Purpose | Who edits |
|------|---------|-----------|
| `stack.env.example` | Template for system-managed secrets | Copy to `vault/stack/stack.env` |
| `user.env.example` | Template for user-managed LLM keys | Copy to `vault/user/user.env` |
| `system.env.schema` | Varlock schema for stack.env validation | Tooling |
| `user.env.schema` | Varlock schema for user.env validation | Tooling |
| `redact.env.schema` | Log redaction rules for sensitive vars | Tooling |

## Runtime layout

```
~/.openpalm/vault/
  stack/
    stack.env          # System-managed (tokens, ports, paths)
    addons/            # Per-addon env files (created by tooling)
  user/
    user.env           # User-managed (LLM keys, owner info)
```

## Security

- The vault directory is restricted to mode `0700` (owner-only access)
- Individual env files are mode `0600`
- Only the admin container mounts the full vault (read-write)
- The assistant container mounts only `vault/user/user.env` (read-only)
- Other containers receive secrets via `${VAR}` substitution only
