# Managing OpenPalm

OpenPalm stores its installation under one `OP_HOME` directory, normally
`~/.openpalm/`. The host CLI and host admin UI manage Docker Compose; the
assistant container cannot manage the stack.

## Ownership Map

```text
~/.openpalm/
├── config/                         # user-owned, non-secret
│   ├── assistant/                  # assistant OpenCode global config
│   ├── guardian/                   # Guardian OpenCode global/model config
│   ├── akm/                        # AKM config
│   └── stack/custom.compose.yml    # only user-owned Compose overlay
├── system/                         # managed; refreshed by lifecycle operations
│   ├── assistant/                  # managed assistant config -> /etc/opencode
│   ├── guardian/                   # managed Guardian config -> /etc/opencode
│   └── stack/
│       ├── core.compose.yml
│       ├── services.compose.yml
│       └── portals.compose.yml
├── state/stack.env                 # sole non-secret Compose env file
├── private/secrets/                # delegated service credentials
├── knowledge/
│   ├── secrets/auth.json           # assistant-readable provider auth
│   ├── env/user.env                # AKM env, loaded on demand
│   └── tasks/                      # AKM task files
├── data/                           # durable service data and backups
├── cache/                          # regenerable container caches
└── workspace/                      # assistant /work mount
```

Automatic install/update operations may replace `system/` and update
app-owned `state/`. Existing files in `config/` remain user-owned.

## Common Lifecycle Commands

```bash
openpalm status
openpalm start
openpalm stop
openpalm restart
openpalm logs assistant
openpalm update
openpalm validate
openpalm doctor
```

Run `openpalm admin` for the loopback-only host management UI. Bare `openpalm`
starts the normal host UI supervisor and ensures an installed stack is running.

## Addons

First-party addons are declared in managed `services.compose.yml` and
`portals.compose.yml`. Their enabled IDs are stored in `OP_ENABLED_ADDONS` in
`state/stack.env`.

```bash
openpalm addon list
openpalm addon enable discord
openpalm addon disable discord
```

OpenPalm commands translate enabled IDs to profiles such as `addon.discord`.
Raw Docker Compose does not translate `OP_ENABLED_ADDONS`; pass every active
profile explicitly or set `COMPOSE_PROFILES` yourself.

Custom services and overrides belong only in:

```text
~/.openpalm/config/stack/custom.compose.yml
```

See the [Manual Compose Runbook](operations/manual-compose-runbook.md) before
operating the stack without the control plane.

## Secrets

The two runtime secret areas have different trust boundaries:

| Path | Access |
|---|---|
| `private/secrets/` | UI, Guardian, compatible API, portals, bots, and OpenCode server only, through narrow grants |
| `knowledge/secrets/auth.json` | Assistant OpenCode provider credentials; Guardian gets a narrow copy through Compose secrets |

`knowledge/env/user.env` is available through `akm env:user` on demand. The
assistant entrypoint does not source it, so arbitrary user-env values do not
enter the OpenCode server or every tool subprocess.

`state/stack.env` is non-secret. Never put passwords, tokens, API keys, or
credential JSON there. See [Password & Secret Management](password-management.md).

## Access Controls

Setup uses four independent booleans:

| Setup field | Purpose |
|---|---|
| `access.networkAccess` | Publish the assistant UI to the local network |
| `access.assistantDirect` | Publish OpenCode directly with generated authentication |
| `access.guardianNetwork` | Publish Guardian direct ingress |
| `access.guardianOpenaiApi` | Publish the Guardian-hosted compatible API |

The resulting listener settings are flat service-specific bind variables. There
is no global cascade, SSH listener, or separate chat port. Voice stays
loopback-only on port `8880`.

Turning a toggle on writes it and applies it in the same step: the affected
containers are recreated so the new port publishes actually take effect, then
the `.local` name is (re)advertised. `openpalm restart` and the Containers
tab's restart button never apply an access-toggle change on their own —
`compose restart` cannot republish a port or change container env; only a
toggle save (or `openpalm start <service>`, which recreates) does.

With `access.networkAccess` on, open the assistant from another device at
`http://<name>.local:3800` (include the port — resolving the `.local` name
only gets you the IP, not the port) or `http://<host-ip>:3800` as a fallback.
See [Setup Guide → Reaching OpenPalm from Another Device](setup-guide.md#reaching-openpalm-from-another-device)
for the full detail, including why the `.local` name can stop resolving while
the IP URL keeps working.

## Automations

Assistant automations are AKM YAML task files under
`knowledge/tasks/`. The assistant entrypoint starts BusyBox `crond`, runs
`akm tasks sync` at boot, and re-syncs every 60 seconds.

Task targets are limited to `command`, `prompt`, or `workflow`.

### Prompt Task

```yaml
schedule: "0 9 * * *"
enabled: true
description: Daily briefing
prompt: Summarize my priorities for today.
```

### Command Task

```yaml
schedule: "0 4 * * 0"
enabled: true
description: Check the AKM store
command: ["akm", "health"]
```

### Workflow Task

```yaml
schedule: "0 8 * * 1"
enabled: true
description: Weekly review
workflow: workflow:weekly-review
params:
  audience: owner
```

Task commands execute inside the assistant container. They cannot run host
lifecycle commands such as `openpalm update`, `openpalm status`, or
`openpalm validate`; the container has neither the CLI control-plane authority
nor a Docker socket.

### Host Lifecycle Schedules

Use the host operating system's scheduler for lifecycle work. For example, on a
Linux host run `crontab -e` and add:

```cron
0 3 * * 0 /home/me/.local/bin/openpalm update >> /home/me/.openpalm/data/logs/host-update.log 2>&1
```

Use an absolute path to the host CLI and adjust the home path. On Windows, use
Task Scheduler. These jobs run outside the assistant container.

To force an immediate in-container task resync:

```bash
docker exec openpalm-assistant-1 akm tasks sync
```

Use `docker ps --format '{{.Names}}'` if your Compose-generated container name
differs.

## Assistant Extensions

Managed assistant behavior ships in `system/assistant/` and mounts at
`/etc/opencode`. It is refreshed on update. Durable user configuration belongs
in `config/assistant/`, mounted as OpenCode's user global config at
`/home/opencode/.config/opencode`.

```text
config/assistant/opencode.json
config/assistant/persona.md
config/assistant/tools/my-tool.ts
config/assistant/plugins/my-plugin.ts
config/assistant/skills/my-skill/SKILL.md
```

Guardian uses the same split: managed instructions and permissions from
`system/guardian/`, user model configuration from `config/guardian/`.

The assistant image contains its UI and default tool tree at build time. There
is no runtime UI-tarball install path; the CLI and Electron ship the same
skeleton and UI build embedded in their own artifact, and the assistant image
carries its own copy for the container-served UI.

## Updates and Recovery

```bash
openpalm update
openpalm rollback
openpalm backups prune --keep 3
```

`openpalm update` refreshes managed assets and reapplies the configured stack.
`data/ui/` is a materialization directory rewritten from the CLI's own
embedded UI build when the version stamp differs; it is not an independent
update target. The assistant-served UI is part of the assistant image.

### Desktop app updates

The desktop app updates as one complete application — shell and UI together —
rather than pulling a UI separately at runtime.

- **Discovery is silent.** The app checks shortly after launch and, at most
  once an hour, when you return to the window. A failed check (offline, say)
  shows nothing; only a check you start yourself reports an error.
- **Downloading needs your consent.** Finding an update never downloads it.
  The banner offers **Download**, and only then does the app fetch the release.
- **Installing happens on restart.** Once the download finishes, use **Restart
  and update**, or simply quit — a staged update installs on the next ordinary
  quit either way.
- **Channels are stable and beta.** The desktop "check for prerelease versions"
  setting switches to the beta channel; there is no separate `rc` channel.

Which installs update themselves:

| Install | Auto-update |
| --- | --- |
| Windows installer (NSIS `.exe`) | Yes |
| Linux `AppImage` | Yes |
| Windows portable `.zip` | No — manual: download and extract a new build |
| macOS `.app` `.zip` | No — manual: download from the releases page |

The portable Windows archive stays manual on purpose: it has no install
location to replace, so there is nothing for the updater to update in place.
macOS stays manual until the app is signed with a Developer ID and notarized —
an unsigned in-place replacement would leave you with an app macOS refuses to
open. Both cases download from
[the releases page](https://github.com/itlackey/openpalm/releases).

If an operation appears abandoned, `openpalm unlock` removes only a verified
stale lifecycle lock and refuses to clear a live one.

Use `openpalm doctor` for a read-only report. Cleanup remains explicit:

```bash
openpalm doctor --clean-caches
openpalm doctor --clean-docker
openpalm doctor --reclaim-db
```

## API Routes

The UI server uses these namespaces:

| Namespace | Purpose |
|---|---|
| `/api/auth/*` | Login, logout, and session handling |
| `/api/host/*` | Host control-plane operations; host capability required |
| `/api/assistant/*` | Assistant-owned settings |
| `/oc/*` | Same-origin pass-through to this process's own OpenCode (session auth). Not Guardian's `/oc/*` — see [`api-spec.md`](technical/api-spec.md) for the disambiguation |
| `/voice/*` | Same-origin pass-through to local voice (session auth); `503` when this process cannot serve it — true on the assistant-served (LAN) UI unless `OP_VOICE_LAN_ACCESS=true`, see [Troubleshooting](troubleshooting.md#voice-does-not-start) |

`/admin/*` is intentionally unimplemented and returns `404`. This does not
apply to Guardian's separate loopback listener at
`http://127.0.0.1:3831/admin/principals`, which is a different server and uses
the Guardian admin bearer token.

## Ports

| Default | Service |
|---|---|
| `3800` | Assistant-served UI |
| `3810` | Assistant OpenCode API/UI |
| `3821` | Guardian-hosted compatible API |
| `3830` | Guardian direct ingress |
| `3831` | Guardian principal admin, permanently loopback-only |
| `3880` | Optional host UI/admin process |
| `8880` | Voice API, loopback-only |

All binds default to loopback. Use setup access controls rather than a global
bind variable.

## Remote Clients

Use [Remote Access over TLS](remote-access-tls.md) for browser and Guardian
fronting. To manage Guardian principals headlessly, call its loopback-only admin
listener with the token from `private/secrets/`:

```bash
token="$(openssl rand -hex 24)"
curl -X POST http://127.0.0.1:3831/admin/principals \
  -H "authorization: Bearer $(cat ~/.openpalm/private/secrets/op_guardian_admin_token)" \
  -H 'content-type: application/json' \
  -d '{"id":"my-phone","kind":"direct","token":"'"$token"'","label":"My phone"}'
printf 'Principal token: %s\n' "$token"
```

Do not expose port `3831` through a reverse proxy.

## Backup

Full-home archives include `private/` naturally. Exclude `cache/` when you do
not need regenerable package/model caches. See
[Backup & Restore](backup-restore.md) for consistent stop, archive, and restore
steps.
