# Upgrade guide: 0.10.x → 0.11.0

OpenPalm 0.11.0 is a large architectural release. The platform binary and the
container stack update automatically, **but the on-disk layout for env files and
secrets changed and there is no automated migration for it** — you move a few
files by hand, once.

This guide is the single place a 0.10.x operator should start. It covers the
ordered procedure, the exact old→new file/variable mapping, and what breaks if
you skip a step.

> **Who needs this:** anyone with an existing `~/.openpalm` from 0.10.x (or a
> 0.11.0 **beta**). Fresh installs do not need it — run the setup wizard.
>
> **Time:** ~10 minutes. **Risk:** low if you back up first (step 1).

---

## What changed at a glance

| Area | 0.10.x | 0.11.0 |
|---|---|---|
| Admin UI | a **container** (`admin` service / `packages/admin`) | a **host process** (`openpalm ui serve`, `@openpalm/ui`), no container, no docker-socket-proxy |
| Reverse proxy | Caddy in front of services | **none** — services bind localhost, LAN-first |
| Memory | `memory` container (mem0 / Python) | folded into the akm knowledge tools — no separate service |
| Scheduling | `scheduler` container | the assistant runs `crond` + `akm tasks sync` |
| Secrets/env layout | top-level `vault/` directory | `knowledge/env/` (non-secret) + `knowledge/secrets/` (file secrets) |
| LLM/embedding config | `OP_CAP_*` env vars | `config/akm/config.json` |
| `stack.yml` | `capabilities:` block | `version: 2` only (+ optional `addons:`) |
| Host UI port var | `OP_ADMIN_PORT` | `OP_HOST_UI_PORT` (default `3880`) |
| Channel adapters | baked into the image | **runtime npm installs** (`CHANNEL_PACKAGE`) |
| OpenCode runtime | 1.3.x | **1.15.13** |

Most of this is handled for you by `openpalm update`. The **only manual work** is
the secrets/env file move (step 4) and, if you customized the admin port, the
variable rename (step 5).

---

## Recommended upgrade procedure

### 1. Back up first (do not skip)

Stop the stack, then snapshot the whole home directory:

```bash
openpalm stop
tar czf "openpalm-backup-$(date +%Y%m%d).tar.gz" -C "$HOME" .openpalm
```

If you use the `pass` secrets backend, also back up your GnuPG home
(`${GNUPGHOME:-~/.gnupg}`). See [backup-restore.md](../backup-restore.md) for
details and restore steps.

### 2. Update the CLI

```bash
openpalm self-update          # Linux/macOS
# Windows: re-run setup.ps1 --cli-only
```

### 3. (If you don't have the CLI) check the host can still run a local stack

0.11.0 still needs a Docker-compatible container runtime + Compose v2. Confirm:

```bash
docker version && docker compose version
```

### 4. Move secrets and env files to the new layout (manual)

`openpalm update` does **not** relocate your files. Move them once, matching the
table below. Create the destination directories if missing, and keep the strict
permissions (`chmod 700` on directories, `chmod 600` on files).

**If you are coming from shipped 0.10.x** (top-level `vault/` directory):

| Purpose | 0.10.x location | 0.11.0 location |
|---|---|---|
| User-managed env | `~/.openpalm/vault/user/user.env` | `~/.openpalm/knowledge/env/user.env` |
| System (non-secret) env — Compose `--env-file` | `~/.openpalm/vault/stack/stack.env` | `~/.openpalm/knowledge/env/stack.env` |
| Channel HMAC secrets | `~/.openpalm/vault/stack/guardian.env` | split into per-secret files under `~/.openpalm/knowledge/secrets/` |
| Other stack secret files | `~/.openpalm/vault/stack/*` | `~/.openpalm/knowledge/secrets/<name>` |

**If you are coming from a 0.11.0 beta** (intermediate `knowledge/vaults/` +
`config/stack/` layout), the mapping is slightly different — follow
[secrets-env-migration.md](secrets-env-migration.md), which covers:

| Purpose | beta location | 0.11.0 location |
|---|---|---|
| User env | `knowledge/vaults/user.env` | `knowledge/env/user.env` |
| System env | `config/stack/stack.env` | `knowledge/env/stack.env` |
| Provider credentials | `config/stack/auth.json` | `knowledge/secrets/auth.json` |
| Stack secrets | `knowledge/vaults/secrets/` | `knowledge/secrets/` |
| gws-setup creds | `knowledge/vaults/.gws` | `knowledge/secrets/.gws` |

> **Provider API keys** (OpenAI/Anthropic/etc.) belong in
> `knowledge/secrets/auth.json`, managed through the **Connections** tab in the
> UI — **not** in `stack.env`. `stack.env` is non-secret configuration only
> (ports, image tag, paths). 0.11.0 rejects secret-looking keys from `stack.env`.

### 5. Rename the host UI port variable (only if you customized it)

`OP_ADMIN_PORT` is gone and is no longer read. If you ran the admin UI on a
non-default port, rename it in `~/.openpalm/knowledge/env/stack.env`:

```diff
- OP_ADMIN_PORT=9000
+ OP_HOST_UI_PORT=9000
```

Until you do, the UI binds to the default **3880**. (`OP_ADMIN_OPENCODE_PORT` and
`OP_GUARDIAN_PORT` were removed entirely — the guardian is network-only now.)
Re-running the setup wizard also rewrites these correctly.

### 6. Strip `stack.yml` to v2

If your `~/.openpalm/config/stack/stack.yml` still has a `capabilities:` block,
remove it — the spec is now `version: 2` only. LLM/embedding settings live in
`config/akm/config.json` (set via the wizard / AKM config).

### 7. Apply the upgrade

```bash
openpalm update
```

This refreshes the core compose assets, resolves the latest 0.11.0 image tag into
`stack.env`, pulls images, recreates the containers, and updates the UI build.
It snapshots `stack.env` for rollback if anything fails.

### 8. Verify

```bash
openpalm status
ls ~/.openpalm/knowledge/env/        # user.env, stack.env
ls ~/.openpalm/knowledge/secrets/    # auth.json + any stack secrets
```

Open the UI (default `http://localhost:3880`), confirm the assistant responds in
**Chat**, and check **Health → Systems** shows the containers running.

---

## Channel adapters

Channel adapters are now **runtime npm installs** (`CHANNEL_PACKAGE`), not baked
into the image, with `@openpalm/channels-sdk` as an optional peer. After
upgrading, recreate channel containers so they pull the current adapter. While
0.11.0 is in prerelease, adapters track the npm `@next` dist-tag; the stable
line moves to `@latest`. See
[release-management.md](release-management.md) for the dist-tag details.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Assistant/guardian start but can't find provider creds; channels lose HMAC | env/secrets not moved (step 4) | move `vault/*` → `knowledge/env` + `knowledge/secrets` |
| UI on the wrong (default) port | `OP_ADMIN_PORT` no longer read | rename to `OP_HOST_UI_PORT` (step 5) |
| `stack.yml` validation error | leftover `capabilities:` block | strip to `version: 2` (step 6) |
| Update detection / pull fails | stale assets | re-run `openpalm update`; if needed, `openpalm rollback` and retry |
| Setup wizard appears unexpectedly | install not detected as complete | finish the wizard, or verify `knowledge/env/stack.env` exists with `OP_SETUP_COMPLETE=true` |

If a step goes wrong, restore the backup from step 1 (see
[backup-restore.md](../backup-restore.md)) and retry.

---

## Related

- [secrets-env-migration.md](secrets-env-migration.md) — detailed file-move reference (beta layouts)
- [backup-restore.md](../backup-restore.md) — backup/restore commands
- [troubleshooting.md](../troubleshooting.md) — common problems
- [CHANGELOG.md](../../CHANGELOG.md) — full 0.11.0 change list
