# Upgrade guide: 0.10.x → 0.11.0

OpenPalm 0.11.0 is a large architectural release that also changes the on-disk
layout for env files and secrets. **`openpalm update` migrates that layout
automatically** — it detects a 0.10.x home, takes a full backup first, then
copies your env/secret files into their new locations and transforms them
(aborting safely, with no changes, if the backup fails). It is **copy-only**:
your original `vault/` directory is left untouched as an in-place recovery copy.
The only manual follow-up is re-adding provider API keys and LLM/embedding
config, whose formats/locations changed (steps 5–6).

This guide is the single place a 0.10.x operator should start. It covers the
ordered procedure, what the automatic migration does, the exact old→new
file/variable mapping (also usable as a manual / no-CLI fallback), and what
breaks if you skip a step.

> **Who needs this:** anyone with an existing `~/.openpalm` from 0.10.x (or a
> 0.11.0 **beta**). Fresh installs do not need it — run the setup wizard.
>
> **Time:** roughly 10–20 minutes, mostly image-pull time (the OpenCode runtime
> jumps several versions). **Risk:** low — `openpalm update` backs up first and
> aborts safely if the backup fails.
>
> **Manual work:** essentially none for the file layout — `openpalm update`
> relocates and transforms env/secret files, renames the port var, splits channel
> secrets, and converts addon enablement for you. You only re-add provider API
> keys (Connections tab) and LLM/embedding config (`config/akm/config.json`)
> afterward, since those formats changed (steps 5–6).

---

## What changed at a glance

| Area | 0.10.x | 0.11.0 |
|---|---|---|
| Admin UI | a **container** (`admin` service / `packages/admin`) | a **host process** (`openpalm ui serve`, `@openpalm/ui`), no container, no docker-socket-proxy |
| Reverse proxy | Caddy in front of services | **none** — services bind localhost, LAN-first |
| Memory | `memory` container (mem0 / Python) | folded into the akm knowledge tools — no separate service |
| Scheduling | `scheduler` container | the assistant runs `crond` + `akm tasks sync` |
| Secrets/env layout | top-level `vault/` directory | `knowledge/env/` (non-secret) + `knowledge/secrets/` (file secrets) |
| User-secrets API / store | `/admin/secrets/user-vault`, akm `vault` type | `/admin/secrets/user-env`, akm `env` type (akm 0.8.0 **removed** `vault`; `akm vault set/unset` now error) |
| LLM/embedding config | `OP_CAP_*` env vars | `config/akm/config.json` |
| Addon enablement | `stack.yml addons[]` | `OP_ENABLED_ADDONS` in `stack.env` (no `stack.yml`) |
| Host UI port var | `OP_ADMIN_PORT` | `OP_HOST_UI_PORT` (default `3880`) |
| Voice / runtime env vars | unprefixed (`TTS_*`, `STT_*`) | `OP_`-prefixed (`OP_TTS_*`, `OP_STT_*`, `OP_VOICE_*`) |
| Channel adapters | baked into the image | **runtime npm installs** (`CHANNEL_PACKAGE`) |
| OpenCode runtime | 1.3.x | **1.15.13** |

All of this is handled for you by `openpalm update` — including the env/secret
file relocation (step 4). The only manual follow-up is re-adding provider keys
and LLM/embedding config (steps 5–6), whose formats changed.

> **Terminology:** in 0.11.0, **env files** (`knowledge/env/*.env`) hold
> non-secret settings (ports, paths) and are passed to Compose as a group;
> **secrets** (`knowledge/secrets/*`) are individual `0600` files, one value
> each (e.g. an HMAC key), granted to specific services by Compose. Provider API
> keys are the exception — they live together in `knowledge/secrets/auth.json`,
> managed through the **Connections** tab.

---

## Recommended upgrade procedure

> **Keep the stack stopped** from step 1 through step 7 — you only bring it back
> up with `openpalm update` (step 7). Do not start it to "test" mid-migration.

### 1. Back up first (do not skip)

Stop the stack, then snapshot the whole home directory:

```bash
openpalm stop
tar czf "openpalm-backup-$(date +%Y%m%d).tar.gz" -C "$HOME" .openpalm
```

If you use the `pass` secrets backend, also back up your GnuPG home
(`${GNUPGHOME:-~/.gnupg}`). See [backup-restore.md](../backup-restore.md). **This
tar backup is your real recovery path for a botched migration** (see
Troubleshooting — `openpalm rollback` does *not* undo the file move).

### 2. Update the CLI

```bash
openpalm self-update          # Linux/macOS
# Windows: re-run setup.ps1 --cli-only
```

If you installed via the **desktop app** or `setup.sh` and don't use the CLI,
see step 7's "No CLI?" note — re-running setup is your supported path.

### 3. Confirm the host can still run a local stack

0.11.0 still needs a Docker-compatible container runtime + Compose v2:

```bash
docker version && docker compose version
```

### 4. Move (or re-create) secrets and env files

> **Automatic on upgrade (0.11.0+).** `openpalm update` (and re-running
> `openpalm install` / `setup.sh`, and the admin **Check-up → Update**) now
> **detect a 0.10.x layout and migrate it automatically** — taking a full backup
> first and aborting safely (no changes) if the backup fails. You can also run it
> explicitly: `openpalm migrate --dry-run` then `openpalm migrate`. The harness
> uses the same logic as the scripts below; the scripts remain the manual /
> no-CLI fallback.

> **CLI path only:** use `openpalm migrate --dry-run` to preview and
> `openpalm migrate` to apply. The built-in migration harness takes a full
> backup first, then **copies** (never deletes) your `vault/` files into the
> new layout, transforms `stack.env`, splits channel secrets, and sets
> `OP_ENABLED_ADDONS`/version keys in `stack.env`. It does **not** run
> `openpalm update` or migrate provider credentials — do those manually
> (below + step 7). Prefer the manual walkthrough if you want to understand
> each change.

If you'd rather migrate by hand (or have no CLI), the mapping below is exactly
what the automatic harness does. The cleanest manual approach mixes a file move
(for plain env/secret values) with **re-creating** the credentials whose
format/location is easiest to regenerate.

**Coming from shipped 0.10.x** (top-level `vault/` directory). Create the
destination dirs if missing; keep `chmod 700` on directories and `chmod 600` on
files:

| What | 0.10.x location | 0.11.0 location |
|---|---|---|
| User-managed env | `vault/user/user.env` | `knowledge/env/user.env` |
| System (non-secret) env — Compose `--env-file` | `vault/stack/stack.env` | `knowledge/env/stack.env` |
| Channel HMAC secrets | `vault/stack/guardian.env` | per-secret files under `knowledge/secrets/` (see below) |
| Service secret files | `vault/stack/services/*` | `knowledge/secrets/` |
| Notification config | `vault/user/apprise.yaml` (or `apprise.conf`) | `knowledge/secrets/` (mounted into the assistant at `/etc/openpalm`) |
| Google Workspace / gcloud / Graph creds | `vault/user/.gws`, `gcloud-credentials.json`, `.gcloud`, `.mgc` | `knowledge/secrets/` (same names) |
| Any other files under `vault/stack/` | `vault/stack/*` | `knowledge/secrets/` |

**Provider API keys (OpenAI/Anthropic/etc.):** the OpenCode auth store format
changed. The reliable path is to **re-add each provider** in the **Connections**
tab after the upgrade, which writes `knowledge/secrets/auth.json`. (If you have a
working 0.10.x `auth.json`, you can copy it to `knowledge/secrets/auth.json`, but
re-adding is the supported route.)

**Channel HMAC secrets** are read from per-secret files named
`knowledge/secrets/channel_<name>_secret` (lowercase channel name, the value
only, trailing newline, mode `0600`). The simplest reliable approach is to
**re-run channel setup** (the wizard / Connections regenerates them). To migrate
by hand instead, for each `CHANNEL_<NAME>_SECRET=<value>` line in
`vault/stack/guardian.env`:

```bash
mkdir -p ~/.openpalm/knowledge/secrets && chmod 700 ~/.openpalm/knowledge/secrets
# example for a channel named "discord":
printf '%s\n' "$VALUE" > ~/.openpalm/knowledge/secrets/channel_discord_secret
chmod 600 ~/.openpalm/knowledge/secrets/channel_discord_secret
```

**Coming from a 0.11.0 beta** (intermediate `knowledge/vaults/` + `config/stack/`
layout) — follow [secrets-env-migration.md](secrets-env-migration.md):

| Purpose | beta location | 0.11.0 location |
|---|---|---|
| User env | `knowledge/vaults/user.env` | `knowledge/env/user.env` |
| System env | `config/stack/stack.env` | `knowledge/env/stack.env` |
| Provider credentials | `config/stack/auth.json` | `knowledge/secrets/auth.json` |
| Stack secrets | `knowledge/vaults/secrets/` | `knowledge/secrets/` |
| gws-setup creds | `knowledge/vaults/.gws` | `knowledge/secrets/.gws` |

> If you scripted against the `/admin/secrets/user-vault` API or used
> `akm vault set/unset`, those are gone — use the UI **Secrets** tab
> (`/admin/secrets/user-env`) or edit `knowledge/env/user.env` directly (mode
> `0600`).

### 5. Clean `stack.env` and rename renamed variables

In the migrated `~/.openpalm/knowledge/env/stack.env`:

- **Remove secret-looking keys.** 0.11.0 rejects secrets from `stack.env`. Delete
  `OP_CAP_*`, any `*_API_KEY` / `*_TOKEN` / `*_SECRET`, and `SYSTEM_LLM_*` /
  `EMBEDDING_*` lines. Provider keys go to `knowledge/secrets/auth.json` (via
  Connections); LLM/embedding config goes to `config/akm/config.json` (via the
  AKM tab / wizard).
- **Rename the host UI port** if you customized it:

  ```diff
  - OP_ADMIN_PORT=9000
  + OP_HOST_UI_PORT=9000
  ```

  Until you do, the UI binds to the default **3880**. (`OP_ADMIN_OPENCODE_PORT`
  and `OP_GUARDIAN_PORT` were removed entirely — the guardian is network-only.)
- **Rename voice vars** to the `OP_` prefix: `TTS_* → OP_TTS_*`,
  `STT_* → OP_STT_*`, voice options → `OP_VOICE_*`. Un-prefixed names are ignored.

Re-running the setup wizard also rewrites these correctly.

### 6. Addons + versions live in `stack.env` (no `stack.yml`)

0.11.0 **removes `stack.yml`**. Stack composition + versions are consolidated into
`knowledge/env/stack.env`:

- **Enabled addons** are an `OP_ENABLED_ADDONS=voice,discord` list (was
  `stack.yml addons[]`). If a legacy `stack.yml` has an `addons:` list, copy the
  names into `OP_ENABLED_ADDONS`; otherwise leave it empty.
- **Versions** are recorded as `OP_IMAGE_TAG`, `OP_LAYOUT_VERSION`, and
  `OP_UI_VERSION` in the same file.

You can then delete the old `config/stack.yml` — nothing reads it. LLM/embedding
settings live in `config/akm/config.json` (set via the wizard / AKM config).

### 7. Apply the upgrade

```bash
openpalm update
```

This refreshes the core compose assets, resolves the latest 0.11.0 image tag into
`stack.env`, pulls images, recreates the containers, and updates the UI build. It
snapshots `stack.env` for rollback if a later step fails.

> **No CLI? (desktop app / `setup.sh`)** There is no `openpalm update` to run —
> re-run `setup.sh`, reinstall the desktop app, or open the setup wizard. That
> path materializes the 0.11.0 compose assets, rewrites `stack.env`/ports, and
> regenerates channel secrets. Re-running setup is the supported migration
> completion path for non-CLI installs.

### 8. Verify

```bash
openpalm status
ls ~/.openpalm/knowledge/env/        # user.env, stack.env
ls ~/.openpalm/knowledge/secrets/    # auth.json, op_ui_login_password, channel_*_secret …
```

Then confirm it actually works:

1. The UI loads (default `http://localhost:3880`).
2. **Send a chat message and get a reply** — this proves provider credentials
   (`auth.json`) are wired.
3. **Health → Systems** shows the containers running.
4. If you use channels, send one external message and confirm it is accepted —
   this proves the `channel_*_secret` files are correct.

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
| Assistant starts but can't reach any LLM | `auth.json` not migrated | re-add providers in the **Connections** tab (step 4) |
| Channels reject every message (HMAC) | `channel_*_secret` files missing | re-run channel setup, or create them by hand (step 4) |
| UI on the wrong (default) port | `OP_ADMIN_PORT` no longer read | rename to `OP_HOST_UI_PORT` (step 5) |
| An addon isn't running after upgrade | enablement not carried over | add it to `OP_ENABLED_ADDONS` in `stack.env` (step 6) or re-enable via the Add-ons UI |
| `openpalm update` can't resolve the latest image tag | version detection issue | set `OP_IMAGE_TAG` explicitly in `knowledge/env/stack.env` (e.g. `OP_IMAGE_TAG=0.11.0`) and re-run |
| Setup wizard appears unexpectedly | install not detected as complete | finish the wizard, or verify `knowledge/env/stack.env` has `OP_SETUP_COMPLETE=true` |

**Recovery:** `openpalm rollback` only restores the most recent `stack.env` /
`auth.json` / compose snapshot — it does **not** revert the layout migration. You
have two safety nets: the migration is copy-only, so your original `vault/` is
left untouched in place, and `openpalm update` takes a full home backup (under
`data/backups/<timestamp>/`) before it migrates. To recover from a bad migration,
restore that backup or the tar backup from step 1 (see [backup-restore.md](../backup-restore.md)).

Once 0.11.x is confirmed working, the retained `vault/` can be removed — the
migration drops a `vault/README.md` with the exact, OS-appropriate safe-removal
steps.

---

## Related

- [secrets-env-migration.md](secrets-env-migration.md) — detailed file-move reference (beta layouts)
- [backup-restore.md](../backup-restore.md) — backup/restore commands
- [troubleshooting.md](../troubleshooting.md) — common problems
- [CHANGELOG.md](../../CHANGELOG.md) — full 0.11.0 change list
