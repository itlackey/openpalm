# Upgrade From 0.10.x

This is a historical-source upgrade path to the current release, not a guide to
installing 0.11. OpenPalm `0.10.x` is unsupported, so take an external backup
before changing it.

Do not run `openpalm migrate`: no such command is registered. Current install and
update entrypoints run the required home migrations automatically.

## 1. Back Up The Old Home

Stop the old stack and copy the complete old OpenPalm home, including its
`vault/` tree, to storage outside that directory. Do not delete the original
until the upgraded stack and credentials are verified.

```bash
docker compose down
cp -a ~/.openpalm ~/.openpalm-0.10-backup
```

If the old installation used a different location, back up that actual
`OP_HOME` instead.

## 2. Install The Current Host CLI

Use the current installer or update the existing CLI:

```bash
openpalm self-update
```

On Windows or on a machine without a working CLI, rerun the current setup
script. The installer is idempotent for an existing home.

## 3. Run The Supported Update Path

```bash
openpalm update
```

The update path detects the old layout, snapshots current state, runs ordered
home migrations, installs current managed assets under `system/`, preserves
user-owned files, and reconciles the stack. A failed required migration blocks
startup rather than pretending the old home is current.

The current destination contract is:

- managed files: `system/`
- user configuration: `config/`
- app state: `state/stack.env`
- OpenCode provider auth: `knowledge/secrets/auth.json`
- delegated UI/Guardian/API/portal/bot credentials: `state/secrets/`
- AKM user env: `knowledge/env/user.env`
- durable service state: `data/`

Do not manually move all old secrets into `knowledge/secrets/`; that directory
is assistant-readable. The migration routes delegated names to `state/secrets/`.

## 4. Reconcile Credentials

OpenCode's provider-auth format changed after 0.10. Use Connections in the
current UI to reconnect any provider that was not imported cleanly. Never paste
provider keys into `state/stack.env`.

Review bot and portal credentials in the host Admin UI. The assistant cannot
inspect delegated credentials and should not be asked to validate them.

## 5. Verify

```bash
openpalm status
openpalm validate
openpalm audit-secrets
```

Then verify:

1. The UI requires the configured login password.
2. Assistant chat can reach the selected provider.
3. Each enabled portal authenticates through Guardian.
4. `state/stack.env` contains no credential values.
5. Delegated credentials exist only under `state/secrets/`.

## Recovery

If automatic migration fails, keep the error output and do not repeatedly edit
the partially migrated tree. Restore the external backup to a separate path and
run the current update with that path as `OP_HOME`, or report the migration
failure with all secret values redacted.
