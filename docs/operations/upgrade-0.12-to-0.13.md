# Upgrade From 0.12.x

The supported path from a released `0.12.x` install to `0.13.0`. The home layout
changes and it changes in one direction only, so the backup in step 1 is not
optional.

Every command below is written against `$OP_HOME`. Set it once, in the shell you
will run the upgrade from:

```bash
export OP_HOME="${OP_HOME:-$HOME/.openpalm}"
```

Do not run `openpalm migrate`: no such command is registered. The migration runs
automatically — from install and update, from every CLI command that drives
Compose (`start`, `stop`, `restart`, `addon`, `rollback`, `uninstall`), and from
the admin UI at boot. You never invoke it directly.

**Sections 1 through 3 all happen before you run anything from 0.13.0.**
`openpalm update` takes the backup, runs the migration, rewrites the managed
Compose files and brings the stack up in one command. There is no operator-
visible pause partway through to fix an overlay or rescue a file.

## Two Things To Know About The Version Record

**A released `0.12.x` home records no schema version at all.**
`state/schema-version` did not exist until `a14ac5ec` (2026-07-26), well after
the last 0.12 release (`platform-0.12.52`, 2026-06-30). `readHomeSchemaVersion`
therefore returns `0`, and `runHomeMigrations` replays the entire chain — every
entry in `MIGRATIONS`, not just the newest one. Sections 2 and 3 exist because
of that.

**The bump to `HOME_SCHEMA_VERSION = 10` is one-way, and nothing enforces it.**
There is no downgrade guard. `runHomeMigrations` does exactly one version check
— `if (recorded >= HOME_SCHEMA_VERSION) return false` — and no other consumer of
`readHomeSchemaVersion` enforces anything. Point a 0.12.x binary at a migrated
home and it is not refused: it silently skips its own migrations, then seeds its
own managed Compose files, which name `${OP_HOME}/knowledge/secrets/...` for
credentials that now live under `state/secrets/`. The stack comes up missing
every delegated secret source. Restoring the step-1 archive is the only way back
(section 9).

## 1. Back Up, And Take The Stack Down

```bash
openpalm stop

tar --exclude="$(basename "$OP_HOME")/cache" \
  -czf "openpalm-0.12-backup-$(date +%Y%m%d).tar.gz" \
  -C "$(dirname "$OP_HOME")" "$(basename "$OP_HOME")"
```

Treat the archive as sensitive. On 0.12.x every credential lives in one tree:
`knowledge/secrets/` holds `auth.json` *and* the UI login password, the Guardian
tokens, and every portal and bot secret.

If `OP_HOME` belongs to a different account than the shell you are in — a
supported deployment, see section 9 — run the `tar` under `sudo`. `state/` and
`state/secrets/` are `0700`, so an unprivileged run prints
`tar: .../state: Cannot open: Permission denied`, exits non-zero, **and still
leaves you a tarball** — one with every credential missing. Check the exit
status, not just the file.

**The stack must be down before the home migrates, and must stay down until the
stack has been reapplied.** This is a correctness rule, not backup hygiene.
Containers created from the 0.12 Compose files hold bind mounts and `secrets:`
`file:` sources pointing at `knowledge/secrets/<name>`. The migration moves those
files. A running container survives — it already holds the inode — but it can
never start again:

```
failed to fulfil mount request: open .../knowledge/secrets/op_ui_login_password: no such file or directory
invalid mount config for type "bind": bind source path does not exist: .../knowledge/secrets/portal_api_secret
```

Under `restart: unless-stopped` Docker retries that failure forever.

### If you have no `openpalm` binary, or your project name is not `openpalm`

Being a correctness rule, "the stack is down" has to be *true*, not merely
attempted — and `openpalm stop` is only `docker compose down` under one specific
project name. `resolveComposeProjectName` takes `OP_PROJECT_NAME`, then
`COMPOSE_PROJECT_NAME`, then the literal `openpalm`, and whatever it returns is
baked into every invocation as `--project-name`. Containers created under a
different name are not matched: the command exits `0` having stopped nothing, and
you walk into the failure above believing you avoided it.

Two personas hit this:

- **You drive Compose directly.** `docker compose -f $OP_HOME/system/stack/core.compose.yml up -d`
  derives the project from the base file's *directory*, so your containers are in
  a project called `stack`, not `openpalm`.
- **You run the desktop app.** The bundle ships no CLI at all —
  `electron-builder.yml`'s `extraResources` is the UI build, the skeleton and the
  LICENSE, nothing else — so `openpalm stop` is not a command you have. The admin
  UI has no whole-stack stop either; the Containers tab's start/stop/restart
  controls are per-service, and the only `compose down` the UI issues is inside
  **uninstall**, which is not what you want here.

Both personas have `docker` (Docker with Compose V2 is a prerequisite for the
desktop app on every platform). Find the project that owns this `OP_HOME`:

```bash
docker ps -a --filter label=com.docker.compose.project.config_files \
  --format '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.config_files"}}' \
  | grep -F "$OP_HOME" | cut -f1 | sort -u
```

Then take that project down by name. No `-f` is needed — Compose resolves the
file list from the containers' own labels:

```bash
docker compose -p <project> down
```

Docker Desktop's Containers view does the same thing: select the project, stop it.

Desktop operators: do this **before** you update the app. The relaunched app
migrates your home at boot, before you press anything (section 4).

Migration is not something only `openpalm update` triggers. `runComposeWithPreflight`
runs `runHomeMigrations` for **every** lifecycle command, teardown included — so
`openpalm self-update` followed by `openpalm stop` migrates the home while the
0.12 Compose files are still on disk. Once you are on the 0.13.0 binary,
`openpalm update` must be the next command you run.

The safety snapshot the upgrade takes for you (`data/backups/<timestamp>/`) is
not a substitute for the archive above. It excludes `data/` and `cache/`
entirely, it excludes `state/env/<service>.env` for every service that has a
`data/<service>/` tree, and every update prunes all but the newest three plain
timestamp snapshots. (`-pre-update`/`-pre-rollback` snapshots are never pruned,
but the one `openpalm update` takes for you is a plain one.)

## 2. Rescue What The Upgrade Deletes

Two things are removed with no modification check and no way back, and both are
silent. Everything else in the upgrade is a move you can audit afterwards.

1. **Five fixed skeleton paths**, deleted outright.
2. **Eleven operator-settable keys**, stripped from your stack env.

The step-1 tarball is the only copy of either. Rescue both now.

### The five deleted files

`migrateRetiredSkeletonFiles` (`home-schema.ts`, `since: 6`) `rmSync`s five fixed
paths out of your home. Unlike the skills sweep in section 5, it does **not**
compare them against what the release shipped — there is no modification check
of any kind. Its log line prints the static list of five, not the ones it
actually removed, so nothing tells you which of yours went.

```
config/assistant/opencode.jsonc
config/guardian/opencode.jsonc
knowledge/tasks/health-check.yml
knowledge/tasks/update-containers.yml
knowledge/tasks/validate-config.yml
```

All three task files shipped in the `platform-0.12.52` skeleton
(`packages/skeleton/knowledge/tasks/`), so **every** 0.12.x home has them. The
two `.jsonc` files shipped through `platform-0.12.43`; `platform-0.12.44`
replaced them with `opencode.json`. Seeding outside `system/` is add-only —
`copyTree(..., skipExisting)` never overwrites and never deletes — so a home
first installed on 0.12.43 or earlier still carries both files alongside the
newer `.json`, and both get removed.

`config/assistant/` is bind-mounted as OpenCode's *user* config directory, so
`opencode.jsonc` was live-read. If you added MCP servers, a provider, or model
settings there, they are not preserved and not migrated into
`config/assistant/opencode.json` — you must copy them out now and re-add them by
hand after the upgrade.

Copy everything out before you go any further. **Mirror the directory structure**
— the two `opencode.jsonc` files share a basename, so a loop that flattens them
writes the guardian copy over the assistant copy and rescues four files while
reporting five. The assistant one is precisely the file you cannot rebuild:

```bash
mkdir -p ./openpalm-0.12-rescue
for f in config/assistant/opencode.jsonc \
         config/guardian/opencode.jsonc \
         knowledge/tasks/health-check.yml \
         knowledge/tasks/update-containers.yml \
         knowledge/tasks/validate-config.yml; do
  [ -e "$OP_HOME/$f" ] || continue
  mkdir -p "./openpalm-0.12-rescue/$(dirname "$f")"
  cp -a "$OP_HOME/$f" "./openpalm-0.12-rescue/$f"
done
find ./openpalm-0.12-rescue -type f
```

The count is your check. A home first installed on 0.12.43 or earlier lists
**five** paths; one first installed on 0.12.44 or later lists **three** — the
task files only, since it never received the `.jsonc` pair. Any other number, and
in particular four, means the loop flattened the two `opencode.jsonc` paths onto
each other.

If you wrote your *own* automation at one of those three task filenames, it is
deleted as well. Rename it to something outside that list before upgrading.

### The eleven stripped env keys

`pruneRemovedAddonState` (`addons.ts`) removes `RETIRED_ENV_KEYS` from your
consolidated `state/stack.env` on **every reconcile**, not once — it is called
straight from `lifecycle.ts` with no version gate and no modification check, the
same way `migrateRetiredSkeletonFiles` deletes files without comparing them. It
also drops `ssh` from `OP_ENABLED_ADDONS`, because `ssh` is no longer in
`BUILTIN_ADDON_IDS`.

```
OPENCODE_ENABLE_SSH
OP_TTS_ENGINE   OP_TTS_PROVIDER  OP_TTS_BASE_URL  OP_TTS_MODEL  OP_TTS_VOICE
OP_STT_ENGINE   OP_STT_PROVIDER  OP_STT_BASE_URL  OP_STT_MODEL  OP_STT_LANGUAGE
```

All eleven were reachable on 0.12.52, so this is not hypothetical:

- `OPENCODE_ENABLE_SSH` was the `ssh` add-on's toggle — `setAddonEnabled`
  patched it into `state/stack.state.env`, and `core.compose.yml` published
  `127.0.0.1:${OP_ASSISTANT_SSH_PORT:-2222}:22` unconditionally so the flag was
  all it took. 0.13.0 removes the SSH publish from the skeleton entirely
  (`2222`, `OPENCODE_ENABLE_SSH` and `OP_ASSISTANT_SSH_PORT` have no occurrence
  left in `packages/skeleton/`). **There is no replacement.** If you shell into
  the assistant that way, switch to `docker exec` before you upgrade.
- The ten `OP_TTS_*` / `OP_STT_*` keys were written by the admin Voice tab
  through `writeVoiceVars`, into `knowledge/env/stack.env`. TTS/STT provider
  choice is a per-browser client setting on 0.13.0; nothing server-side reads
  these keys anymore, so the values are only worth keeping as a record of what
  you had configured.

Capture them alongside the files:

```bash
grep -HE '^[[:space:]]*(OPENCODE_ENABLE_SSH|OP_TTS_[A-Z_]+|OP_STT_[A-Z_]+)=' \
  "$OP_HOME/knowledge/env/stack.env" "$OP_HOME/state/stack.state.env" 2>/dev/null \
  | tee ./openpalm-0.12-rescue/retired-stack-env-keys.txt
```

Both 0.12 env files are listed because the two writers targeted different ones —
voice wrote the `knowledge/` file, the add-on toggle wrote the `state/` one — and
`migrateToSingleStackEnv` merges both into `state/stack.env` (state wins) just
before the prune strips them. The `-H` prefix keeps the source visible so you can
tell which value was in effect.

Where this fires from matters. The durable `data/backups/` snapshot only
precedes the migration on `install` and `update`. The migration also runs from
the admin UI at boot (`packages/ui/src/hooks.server.ts`) and from every
Compose-driving CLI command — neither of which takes a backup first. On the
desktop path the updated app migrates your home the moment it launches, before
you press **Update OpenPalm stack**. The step-1 tarball is your only copy.

## 3. Audit Your Overlay And Your Own Secrets

`config/stack/custom.compose.yml` is user-owned. The migration never touches it,
by design, and neither `openpalm validate` nor `openpalm doctor` reads it. It is
the one thing in the home that is not corrected for you.

`openpalm audit-secrets` *does* read it (`discoverStackOverlays` appends it), but
it audits the boundary rather than repairing paths — and it rejects two
constructs outright for a service you added: any `env_file:` at all, and a
`secrets:` entry whose name does not start with your service's own name. Both
are legitimate in a user overlay, so **a correctly-upgraded overlay can still
make `audit-secrets` exit 1.** Section 7 says which of its findings to expect.

Fix it **now**, before the upgrade. The `state/` paths you are about to write
are correct to write before the migration runs — `applyManagedFiles` always runs
`runHomeMigrations` before Compose sees the file — and there is no later moment
to do it in.

One grep covers all four 0.13.0 overlay edits. The env-file edit has **two**
source paths, not one — `migrateToSingleStackEnv` deletes both
`knowledge/env/stack.env` and `state/stack.state.env` — so the pattern carries
five alternatives:

```bash
grep -nE 'knowledge/secrets|knowledge/env/stack\.env|state/stack\.state\.env|channel_lan|private/' \
  "$OP_HOME/config/stack/custom.compose.yml"
```

A hit on `knowledge/secrets/auth.json` is the one false positive: that path does
not change. Everything else the grep finds needs an edit.

`state/stack.state.env` is easy to miss and expensive to miss. 0.12.x handed
Compose *both* env files with state last, so an operator who patched a managed
service copied that pair — and a stale `env_file:` entry is the loud failure in
the table at the end of this section: `docker compose config` exits 1, blocking
`start`, `restart`, `update` and every UI apply.

The grep covers paths only. Published **ports** move too, and an overlay that
claims `3810` starts colliding with the assistant — run the port check in
section 5 against this same file now, while you are here.

### `knowledge/secrets/<name>` → `state/secrets/<name>`

The primary move. On 0.12.x every delegated credential sat in the flat
`knowledge/secrets/` tree, and the shipped `portals.compose.yml` modelled
exactly that — nine `file: ${OP_HOME}/knowledge/secrets/<name>` sources. If your
overlay reuses a platform credential, it names one of those paths.
`migrateDelegatedSecretsToStateDir` relocates every name in
`DELEGATED_SECRET_NAMES` and deletes the `knowledge/secrets/` original. It is
registered twice — `since: 2` and `since: 3` — because the name set grew after
the first bump (`op_session_signing_key` was added); the function re-checks real
filesystem state, so the second pass is a no-op for anything already moved.

```yaml
# before
secrets:
  my_secret:
    file: ${OP_HOME}/knowledge/secrets/op_guardian_admin_token

# after
secrets:
  my_secret:
    file: ${OP_HOME:?}/state/secrets/op_guardian_admin_token
```

`knowledge/secrets/auth.json` is the sole exception and does not move: it is the
only name in `AGENT_READABLE_SECRET_NAMES`, so routing keeps it in the
agent-readable tree.

### `knowledge/env/stack.env` + `state/stack.state.env` → `state/stack.env`

The quietest of the four, and the only one with two source paths. On 0.12.x the
operator's stack config was `knowledge/env/stack.env` (`home.ts`
`legacyStackEnvFile`) and the app's own record was `state/stack.state.env`;
Compose was handed both as `--env-file` with state last. `migrateToSingleStackEnv`
(`since: 1`) merges them into `state/stack.env` — same precedence, so the
effective configuration is unchanged — and then `rmSync`s **both** sources.
Service version keys promoted from the knowledge file are dropped, deliberately:
on 0.12.x those recorded the last-applied release rather than a pin, and keeping
them would freeze your images.

```yaml
# before
    env_file:
      - ${OP_HOME}/knowledge/env/stack.env
      - ${OP_HOME}/state/stack.state.env

# after
    env_file:
      - ${OP_HOME:?}/state/stack.env
```

One line replaces both, and the merged file has the same effective values, so
nothing about your service's configuration changes.

### `channel_lan` → `portal_net`

0.13.0 removes the `channel_lan` network from the skeleton entirely. 0.12.x
still shipped it in `core.compose.yml` as a compatibility bridge and its
`system/stack/README.md` recommended it for custom overlays, so an operator who
followed 0.12's own advice hits this.

`checkCustomComposeChannelLan` is the **first** thing `applyManagedFiles` runs —
before the backup, before the snapshot, before the migration. A service that
references `channel_lan` without a matching top-level definition is a hard
block:

```
Service(s) <name> in .../custom.compose.yml reference the removed "channel_lan"
Docker network. Rename to "portal_net" in .../custom.compose.yml; nothing was changed.
```

Nothing is damaged and nothing was written. Rename it. An overlay that defines
its own `channel_lan` only warns — but that network is now yours alone, and no
managed service joins it, so your service is silently isolated from `portal_net`.

### `private/` — only if you ran a 0.13.0 beta

**A released 0.12.x home has no `private/` tree.** It never shipped:
`platform-0.12.52:packages/lib/src/control-plane/home.ts` contains no reference
to it and defines `secretsDir` as `${home}/knowledge/secrets`. `private/` existed
only on 0.13.0 prereleases. Skip this if you are coming from a real 0.12.x
release.

If you ran a beta, `migrateOpHomeLayout` (`since: 9`) folds `private/secrets/`
into `state/secrets/` and `private/env/` into `state/env/`, then removes
`private/` once both leaves are empty. Repoint the overlay the same way:
`private/secrets` → `state/secrets`, `private/env` → `state/env`.

### Your own files in `knowledge/secrets/`

Separate from the overlay: check the tree itself.

```bash
ls -1 "$OP_HOME/knowledge/secrets"
```

Anything of yours whose filename collides with the relocated set moves out of
`/stash` permanently, and `state/secrets/` is never mounted into the assistant —
so a skill, task or script reading `/stash/secrets/<name>` finds nothing, with no
error naming the cause. The full `DELEGATED_SECRET_NAMES` set
(`secrets-migration.ts`, with the `portal_*` entries derived from
`PORTAL_SECRET_ADDON_IDS`):

```
op_guardian_admin_token   op_ui_login_password      portal_api_secret
op_guardian_mcp_token     op_session_signing_key    portal_discord_secret
op_api_key                ts_authkey                portal_slack_secret
discord_bot_token         op_opencode_password
slack_bot_token
slack_app_token
```

Of these, a 0.12.x home could actually have provisioned
`op_guardian_admin_token`, `op_guardian_mcp_token`, `op_ui_login_password`,
`discord_bot_token`, `slack_bot_token`, `slack_app_token`, `portal_api_secret`,
`portal_discord_secret` and `portal_slack_secret`. `op_api_key`,
`op_opencode_password`, `op_session_signing_key` and `ts_authkey` do not exist
anywhere in `platform-0.12.52` — they are new in 0.13.0 and are generated
straight into `state/secrets/`. The sweep still runs for all of them, so a
same-named file of your own is relocated regardless.

If one of your files matches, rename it to something outside the set before
upgrading.

`portal_chat_secret` is *not* in the set — the `chat` addon is removed in 0.13.0
— so it stays in `knowledge/secrets/` and is now yours. The leftover secret file
is the *smallest* consequence of that removal: `chat` also took a published host
port with it. See section 5.

### Which failure mode you get

The construct decides how loudly a stale path fails:

| In your overlay | Stale path fails as |
|---|---|
| `env_file:` | `docker compose config` exits 1 — blocks `start`, `restart`, `update` and every UI apply, while `stop`/`down` still work |
| `secrets:` `file:` | container creation fails at `up`, with a clear error naming the file |
| bind mount | **silent** — Docker creates the missing source for you, root-owned and empty, and the container starts against nothing |

## 4. Upgrade

Both supported paths end in the same migration.

**CLI.**

```bash
openpalm self-update
openpalm update
```

`self-update` replaces the CLI binary in place; where it cannot (an unsupported
platform, a binary you do not own), install the new one the way you installed the
first. `openpalm update` then does the whole upgrade as one unit: overlay check,
backup, snapshot, migration, managed-asset refresh, image pull, and `up`.

It pulls every managed image before touching containers, so it needs registry
access. A failed **pull** aborts cleanly and restores the previous configuration.
A failure after that point does not restore cleanly — see section 8 before you
act on anything the CLI prints.

**Desktop app.** Update the app itself first: the Host page's Updates tab offers
**Download update**, then **Restart and update**, under Desktop settings. (The
portable Windows `.zip` and the macOS `.app` do not auto-update — download a new
build from the releases page.)

The relaunched app refreshes the managed `system/` tree and **the UI runs the
home migration at boot** — before you press anything. Your stack is now migrated
while its containers still reference 0.12 paths. Press **Update OpenPalm stack**
on the same tab in the same sitting. A reboot or a Docker daemon restart in
between leaves every container unable to start (section 1).

**If you drive Compose directly.** The images, the managed Compose files and the
home schema move as one unit, and only the CLI and the app move all three.
`docker compose pull` and `docker compose up` run no migration and rewrite
nothing under `system/stack/`, so bumping `OP_ASSISTANT_VERSION` /
`OP_GUARDIAN_VERSION` / `OP_PORTAL_VERSION` in `state/stack.env` by hand is not
an upgrade — it gives you 0.13 images under 0.12 Compose against an unmigrated
home. The symptom is specific: 0.12's assistant healthcheck curls `/health`
unauthenticated, 0.13's assistant always requires a password, so the probe 401s,
the assistant never reports healthy, and `depends_on: service_healthy` means
guardian and every portal never start — with nothing in the output naming the
cause. Run `openpalm update` once; raw `docker compose` commands work normally
again afterwards.

## 5. What Moves

| 0.12.x | 0.13.0 | |
|---|---|---|
| `knowledge/secrets/<delegated>` | `state/secrets/` | the primary move — UI login, Guardian tokens, portal and bot secrets; originals deleted |
| `knowledge/env/stack.env` + `state/stack.state.env` | `state/stack.env` | merged, state over knowledge; **both originals deleted** |
| `knowledge/secrets/auth.json` | unchanged | the only agent-readable secret; routing is default-deny now |
| `knowledge/skills/<shipped>` | `system/skills/` | shipped skills are managed and updatable now, mounted `:ro` at `/system-stash`; a copy whose every file is release-shipped content is removed, **one holding anything else is kept and shadows the managed copy**, see below |
| `config/{assistant,guardian}/opencode.jsonc`, `knowledge/tasks/{health-check,update-containers,validate-config}.yml` | *(deleted)* | section 2 — no modification check |
| `OPENCODE_ENABLE_SSH`, ten `OP_TTS_*`/`OP_STT_*` keys | *(deleted from `state/stack.env`)* | section 2 — stripped on every reconcile, no modification check; the SSH publish has no replacement |
| host port `3800` = OpenCode API | host port `3810` | published host ports move — see below |
| host port `3820` = `chat` portal | host port `3820` = OpenCode web UI | the `chat` addon is removed |
| `channel_lan` network | *(removed)* | use `portal_net` |
| `config/`, `system/`, `state/`, `knowledge/`, `data/`, `cache/`, `workspace/` | unchanged | |

If you ran a 0.13.0 beta, add `private/secrets/` → `state/secrets/`,
`private/env/paperclip.env` → `state/env/paperclip.env`, and the removal of
`knowledge/paperclip/{env,secrets}` — none of which apply to a released 0.12.x
home, where `private/` and Paperclip both did not exist.

Credential moves are copy → read back → verify → delete, never the other way
round, and a rerun is a clean no-op. Beyond that:

- **A recognised shipped skill is cleared for you; anything else is kept.**
  `pruneDuplicateShippedSkills` removes a stash copy when every file in it is
  content OpenPalm is known to have shipped at that path — this release's, or
  any earlier release's. Your 0.12.x copies are frozen at the 0.12 content
  (the seed was `skipExisting`), and both `config-diagnostics/SKILL.md` and
  `notify/SKILL.md` changed between `platform-0.12.52` and this release, so a
  test against *this* release's bytes alone would have kept every one of them.
  Matching the earlier content too is what lets an untouched 0.12.x home stop
  shadowing `system/skills/` on its own.

  Edit one file in a skill — or drop a file of your own into its directory —
  and that skill is kept whole. The test is *unrecognised*, not *edited*, and
  the two come apart in both directions. A file matching no release is kept
  whether or not you wrote it — content from a branch that no longer exists, or
  a hand-restored backup, reads the same as your own work and is treated as
  yours. And an edit that reproduces an earlier release's file *exactly* — you
  disliked the 0.13 version of a shipped skill and pinned the stash copy back to
  its 0.12 text — is indistinguishable from never having touched it, and is
  removed. If you have deliberately pinned a shipped skill to an older version,
  copy it under a name of your own before upgrading; that is the one case this
  check cannot see. The log line *"Kept locally modified copies of shipped
  skills"* names every skill holding something unrecognised, so it is worth
  reading: those still shadow `system/skills/`, and resolving that is yours.
  Diff before you decide:

  ```bash
  for s in $(ls "$OP_HOME/knowledge/skills" 2>/dev/null); do
    echo "--- $s ---"
    diff -r "$OP_HOME/knowledge/skills/$s" "$OP_HOME/system/skills/$s" 2>/dev/null
  done
  ```

  Then remove only what you agree is not yours, e.g.:

  ```bash
  rm -rf "$OP_HOME/knowledge/skills/notify"
  ```

  `gws-setup` shipped in 0.12.x and is retired: it is not in `system/skills/` at
  all, so the sweep never inspects it. It stays, and it is now yours.

- **The `/system-stash` bundle is assistant-only.** `system/skills:/system-stash:ro`
  is mounted into the assistant and nowhere else, and the system bundle is
  registered only in the assistant's akm config. A Paperclip agent that needs a
  shipped skill needs its own copy under `knowledge/skills/` — which the prune
  leaves alone once it differs.

- **Secrets you placed in `knowledge/secrets/` yourself stay put and stay
  readable at `/stash/secrets/<name>`** — but they disappear from the admin
  Secrets tab. Routing is default-deny (`AGENT_READABLE_SECRET_NAMES` is
  `{auth.json}`), so the tab now lists `auth.json` from that tree plus everything
  in `state/secrets/`, and nothing else. A missing entry in the tab is not a
  missing file. Do not re-create it through the tab: that write routes to
  `state/secrets/`, and you end up with two divergent copies while the agent goes
  on reading the stale `/stash` one.

- **Enabling Paperclip gives it the whole knowledge tree.** It mounts
  `${OP_HOME:?}/knowledge:/stash` with nothing over it and runs as the same
  `${OP_UID}:${OP_GID}` that owns those files, so it can read
  `knowledge/secrets/auth.json` — your OpenCode provider credentials — and
  `knowledge/env/user.env`. Treat anything in the shared stash as readable by
  every enabled `/stash` holder, not just the assistant.

Every mount and secret source in the managed compose files now uses
`${OP_HOME:?}`, so Compose fails loudly instead of resolving those paths against
an empty `OP_HOME`.

### Published host ports move, and it is not opt-out

Nothing about this is opt-in and nothing warns you. `migrateLegacyDefaultPorts`
is registered `{ since: 0 }`, so it replays on a home that records no version —
every 0.12.x home. It writes the swap whenever both keys are absent *or* the old
effective pair was `3800`/`3810`. A default 0.12.x `knowledge/env/stack.env`
carries `OP_ASSISTANT_PORT=3800` and no `OP_UI_PORT` at all, which is that second
case exactly, so the swap fires.

| Host port | On 0.12.52 | On 0.13.0 |
|---|---|---|
| `3800` | OpenCode API (`OP_ASSISTANT_PORT`) | **admin UI** (`OP_UI_PORT`) |
| `3810` | *unused — no occurrence in the 0.12.52 skeleton* | **OpenCode API** (`OP_ASSISTANT_PORT`) |
| `3820` | `chat` portal → guardian `8182` (`OP_CHAT_PORT`) | **OpenCode web UI** (`OP_WORKSPACE_PORT`) |
| `3821` | guardian OpenAI edge (`OP_API_PORT`) | unchanged, but now gated on the `api` addon / `guardianOpenaiApi` toggle |
| `3830` / `3831` | guardian, guardian admin | unchanged |
| `3880` | admin UI, as a **host process** (`OP_HOST_UI_PORT`) | unchanged — but the UI is now also a container listener on `3800` |

Three concrete breaks:

- **Anything aimed at `3800` as the OpenCode API** — a reverse proxy, a firewall
  rule, an editor plugin, a bookmark — now reaches the OpenPalm admin UI instead.
  Repoint it at `3810` and add the password from section 6.
- **An overlay that publishes `3810` collides.** `3810` was completely unused on
  0.12.52, so it was a perfectly reasonable port to claim for a service of your
  own. Now the assistant binds it and `up` fails. Check before you upgrade:

  ```bash
  # short syntax, quoted or bare, with or without a bind address
  grep -nE '(^|[":[:space:]])(3800|3810|3820):' "$OP_HOME/config/stack/custom.compose.yml"
  # long syntax: published: "3810" on its own line
  grep -nE 'published:[[:space:]]*"?(3800|3810|3820)"?' "$OP_HOME/config/stack/custom.compose.yml"
  ```

  Two greps because Compose has two publish syntaxes and the short-form pattern
  cannot see `published:`. If you would rather not reason about either, ask
  Compose itself — it resolves both forms identically:

  ```bash
  docker compose -f "$OP_HOME/config/stack/custom.compose.yml" config 2>/dev/null \
    | grep -nE 'published:[[:space:]]*"?(3800|3810|3820)"?'
  ```

- **`3820` stops being the `chat` portal.** The `chat` addon is removed, and its
  publish (`${OP_CHAT_PORT:-3820}` → guardian `8182`) goes with it — `OP_CHAT_PORT`
  has no occurrence left anywhere in the tree. The same `8182` upstream survives
  only through `guardian.compose.api.yml` on `${OP_API_PORT:-3821}`, which
  `discoverStackOverlays` includes only when `isOpenaiEdgePublished` is true.
  `migrateChatAddonRemoval` substitutes the `api` addon **only when `chat` was
  the install's sole reason to deploy the guardian** — so if you ran `chat`
  alongside `discord` or `slack`, no substitution happens, and your
  OpenAI-compatible edge on `3820` simply disappears. Enable the `api` addon
  after the upgrade to get it back on `3821`.

Apart from the overlay collision above, none of this is fixable inside the home.
The repairs live in your proxy config, your firewall rules and your client
scripts — run the port check as part of section 3, while you still have the stack
down and time to change them.

## 6. Direct OpenCode Clients Now Need A Password

Independent of the layout change: `OPENCODE_AUTH` is gone and OpenCode requires a
password on every install. `127.0.0.1:3810` answers `401` to anything that does
not attach it.

**This credential is new in 0.13.0.** `op_opencode_password` does not exist
anywhere in `platform-0.12.52`; `ensureSecrets` generates it on the first update
and writes it to `state/secrets/op_opencode_password`. There is no earlier value
to carry over and no 0.12.x file to go looking for.

The UI, the Guardian and the portals attach it server-side and are unaffected.
Anything you pointed at OpenCode yourself — a script, an editor plugin, another
host — needs **two** changes, not one: the address moved from `3800` to `3810`
(section 5), and the request now needs a credential:

- username: `opencode`
- password: the contents of `state/secrets/op_opencode_password`

```bash
curl -sf -u "opencode:$(cat "$OP_HOME/state/secrets/op_opencode_password")" \
  http://127.0.0.1:3810/health
```

The same value is revealable in the admin UI: **Host → Secrets**, select
`op_opencode_password`, tick **Reveal**. (Not the Assistant tab — it has no
password surface at all; its "Show advanced access options" disclosure is a set
of access toggles. The Connections page carries the same stale pointer.)

It is seeded once and never reissued on its own; rotate it by editing the file
and restarting the `assistant` container.

## 7. Verify

The migration leaves its evidence on disk. Check that first:

```bash
cat "$OP_HOME/state/schema-version"          # 10
ls "$OP_HOME/state/secrets"                  # the delegated credentials
ls "$OP_HOME/knowledge/secrets"              # auth.json, plus anything you put here yourself
ls "$OP_HOME/system/skills"                  # the shipped skills
ls "$OP_HOME/state/stack.env"                # exists
ls "$OP_HOME/knowledge/env/stack.env"        # No such file or directory
grep -E '^[[:space:]]*(OP_ASSISTANT_PORT|OP_UI_PORT)=' "$OP_HOME/state/stack.env"
grep -E '^[[:space:]]*(OPENCODE_ENABLE_SSH|OP_TTS_|OP_STT_)' "$OP_HOME/state/stack.env"
```

The real tripwire is the third line. Any name from the delegated list still
sitting in `knowledge/secrets/` means the relocation did not complete for that
credential — go to section 8. Your own files there are expected and are not a
sign of failure.

The last line printing **nothing** is the expected result, not a problem — it
confirms the section-2 prune ran. If you had any of those eleven keys set, your
only record of them is now
`./openpalm-0.12-rescue/retired-stack-env-keys.txt` and the step-1 tarball.

The **ports** grep — the second-to-last line — should show
`OP_ASSISTANT_PORT=3810` and `OP_UI_PORT=3800` on a default home; that is the
swap from section 5, materialized. Confirm what is actually bound:

```bash
docker ps --filter label=com.docker.compose.project=<project> \
  --format '{{.Label "com.docker.compose.service"}}\t{{.Ports}}'
```

(`<project>` is what the discovery command in section 1 printed.) Expect the
`assistant` container to publish both `3810->4096` (OpenCode) and `3800->3000`
(the admin UI co-process).

Then check the stack:

```bash
openpalm status
openpalm validate
openpalm audit-secrets --format human
openpalm doctor
```

**These four are CLI-only.** There is no equivalent in the admin UI — no
`doctor`, `validate` or `audit-secrets` route exists in it — so a desktop-app
operator cannot run them. What a desktop operator has instead: the on-disk
checks above (plain shell, no binary needed), the `docker ps` line above, the
Host page's **Containers** tab for per-service state, and the **Secrets** tab,
which lists everything in `state/secrets/` plus `auth.json` — an empty or
missing entry there is the same signal `openpalm audit-secrets` would give.

`openpalm validate` checks only that `state/stack.env` exists and that the
required secrets are present and non-empty; it and `doctor` never read
`config/stack/custom.compose.yml`.

**`audit-secrets` does read your overlay, and two of its findings are expected
on a correct upgrade.** If you added your own service, it reports
`compose-service-env-file` for any `env_file:` you give that service, and
`compose-secret-boundary` for a `secrets:` entry whose name does not begin with
the service's own name — which is exactly the case when you reuse a platform
credential like `op_guardian_admin_token`. Both make it exit 1. Neither means
the upgrade failed. Read its output for findings that name `state/`-era paths;
ignore those two if they describe the overlay you deliberately kept.

If you have your own services, verify their mounts directly — pass the project
name, as in section 1:

```bash
docker compose -p <project> exec <your-service> ls <mount target>   # content, not an empty dir
```

An empty, root-owned directory where a credential used to be is a stale bind
mount in your overlay that Docker recreated at container start — not a migration
conflict. Go back to section 3, fix the path, then remove the directory. (A
directory with *contents* is the section 8 case.) This is also how a `private/`
or `knowledge/paperclip/` tree can reappear on a home that never had one.

And confirm by hand:

1. The UI requires the configured login password.
2. Assistant chat reaches the selected provider.
3. Each enabled portal authenticates through Guardian.
4. Every direct OpenCode client you own points at `3810`, not `3800`, and
   carries the password from section 6.
5. Any MCP servers or provider settings you rescued from `opencode.jsonc` in
   section 2 are back in `config/assistant/opencode.json`.
6. Anything you had reverse-proxied, firewalled or scripted against `3800`,
   `3810` or `3820` still reaches what you meant (section 5).
7. If you ran `chat`, whatever consumed its `3820` OpenAI-compatible edge now
   points at `3821` with the `api` addon enabled.
8. If you used `OPENCODE_ENABLE_SSH`, you have a `docker exec` path into the
   assistant instead; if you had voice configured, the TTS/STT settings are
   re-entered per browser.

## 8. If The Update Fails, Or Reports A Conflict

### Ignore the `openpalm rollback` line the CLI prints

On failure the CLI prints *"your previous state was backed up before this update
— run `openpalm rollback` to restore it."* **After the migration has run, that is
actively harmful.**

The snapshot is taken *before* the migration, deliberately, so it pairs the env
with the `system/` tree it was written for. Restoring it puts pre-0.13 Compose
files — whose secret sources are `${OP_HOME}/knowledge/secrets/...` — over a home
whose credentials now live in `state/secrets/`. Guardian and every portal fail to
come back up. `performUpgrade` already attempted this automatically on your
behalf if containers were mutated, which is where *"automatic rollback did not
fully recover"* comes from. Running it again by hand repeats the same broken
restore, and additionally overwrites `config/stack/custom.compose.yml` from the
snapshot — silently reverting any section-3 edit you made after the failed run
(recoverable only from `data/backups/<ts>-pre-rollback/`).

`openpalm start` cannot fix it either: it never re-seeds `system/`.

There are exactly two forward paths:

1. Correct the overlay per section 3 and rerun `openpalm update` — the only
   command that re-seeds `system/`. This is the fix for nearly every case.
2. Restore the step-1 archive in full (section 9).

### A credential left in both locations

A file present in both the old and the new location with **different** content is
not resolved automatically. Choosing between two versions of a signing key is not
a decision a migration gets to make, so it leaves both files in place and logs:

```
delegated secret present in both knowledge/secrets and state/secrets with DIFFERENT content — leaving both in place for manual review
```

(A 0.13.0-beta home moving `private/` can instead log `file present in both the
old and new location with DIFFERENT content — leaving both in place for manual
review`, from `relocateFile`.)

Resolve it by hand. Compare the two copies first — **read the diff before you run
anything**, because the two branches below write in opposite directions:

```bash
diff "$OP_HOME/knowledge/secrets/<name>" "$OP_HOME/state/secrets/<name>"
```

Then pick the branch that matches what you see. Whichever you pick, the value you
keep ends up at the `state/` path at mode `0600` and the `knowledge/` copy goes
away.

**Branch A — the `state/` value is the live one.** This is the usual case: the
`state/` copy is what every 0.13.0 compose file reads, so if the stack has been
up since the upgrade, that is the credential in use. The `knowledge/` copy is a
stale pre-upgrade value. Drop it, and change nothing else:

```bash
rm "$OP_HOME/knowledge/secrets/<name>"
```

**Branch B — the `knowledge/` value is the live one.** Only when you can point at
why: you edited it after the failed update, or the `state/` copy was freshly
generated by `ensureSecrets` and never distributed to whatever consumes it.
Promote it, then drop it:

```bash
install -m 600 "$OP_HOME/knowledge/secrets/<name>" "$OP_HOME/state/secrets/<name>"
rm "$OP_HOME/knowledge/secrets/<name>"
```

**Neither branch — the two files are unrelated.** Section 3 warns about this: a
file of your own whose name collides with a `DELEGATED_SECRET_NAMES` entry
produces the same `skippedMismatch` log, and the two sides are not two versions
of one credential. Running Branch B here overwrites the platform's real
`op_session_signing_key` or `op_ui_login_password` with your unrelated file.
Rename yours to something outside the set and leave the `state/` copy alone:

```bash
mv "$OP_HOME/knowledge/secrets/<name>" "$OP_HOME/knowledge/secrets/<name>-mine"
```

Then rerun `openpalm update` and restart the stack so containers re-read the
changed secret. Do not keep editing a partially migrated tree hoping it settles;
if the conflict is not obvious, restore the archive and report it with every
secret value redacted.

## 9. Rollback

Restore the step-1 archive in full, to the same parent directory `OP_HOME` points
at, and go back to the 0.12.x harness with it:

```bash
openpalm stop     # or the project-aware `docker compose -p <project> down` from section 1
mv "$OP_HOME" "$OP_HOME-0.13-failed"
sudo tar -xzpf openpalm-0.12-backup-YYYYMMDD.tar.gz --same-owner --numeric-owner \
  -C "$(dirname "$OP_HOME")"
```

**Extract as root and keep the archived ownership. Do not `chown -R` to
yourself.** `resolveOperatorIds` prefers the `OP_HOME` *owner* over the process
uid, precisely so an admin can run `sudo openpalm install` on behalf of a service
account, and the containers then run as the `user: ${OP_UID}:${OP_GID}` that
resolution produced. A blanket `chown -R "$(id -u):$(id -g)" "$OP_HOME"` rewrites
that — including everything under `data/` — to whoever happened to type the
command, which is wrong on exactly the deployment shape the codebase goes out of
its way to support. `tar -xzpf --same-owner --numeric-owner` restores the uid/gid
the archive recorded, which is the same value in the ordinary single-user case,
so it is correct either way.

If ownership really is wrong — a genuine host-identity change rather than a
restore artifact — 0.13.0 has a supported repair that does not require you to
guess the ids:

```bash
openpalm repair-ownership          # add --adopt after a deliberate host swap
```

It is a **0.13.0** command; `platform-0.12.52` has no such subcommand. Use it
only if you are staying on 0.13.0. Do not run it against a home you have just
restored to 0.12 layout.

Then reinstall the 0.12.x CLI or desktop app from the releases page before
starting. A 0.13.0 harness would migrate the restored home forward again on its
very next command — including `openpalm stop`.

**A partial rollback is not safe.**

- `openpalm rollback` is not a version rollback. It restores one narrow snapshot
  — `state/stack.env`, `state/schema-version`, `config/stack/custom.compose.yml`,
  `.skeleton-version` and the managed `system/` tree — and nothing else.
  Credentials do not move back. See section 8.
- Hand-copying `state/secrets/` back into `knowledge/secrets/` leaves
  `state/schema-version` at `10`, so nothing re-runs and the two trees drift from
  then on.

Restore the whole archive, or stay on 0.13.0 and fix forward.
