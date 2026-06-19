# Plan: `op-az` — One-off CLI for OpenPalm on Azure Container Apps

> Status: Proposed (planning). Branch: `claude/op-az-azure-cli-tool-z3b0nk`.
> Author: synthesized from a multi-specialist design debate (Azure Container Apps
> architecture, secrets/Key Vault/identity, CLI design) plus a storage/DB reliability
> verification, refereed against `docs/technical/core-principles.md`. Supersedes/modernizes
> the v0.10-era `.github/roadmap/0.10.0/plans/issue-315-azure-container-apps.md` (which
> targeted a bash `deploy-aca.sh` against the pre-0.11 `channel → guardian → assistant →
> memory` architecture).
>
> **Revision note:** an earlier draft used SMB Azure Files + a Key Vault hybrid for
> secrets. Storage verification (§5a) showed SMB cannot host OpenPalm's SQLite data and
> cannot honor `0600` file modes. The design now uses **a single Azure Files NFS (Premium)
> share for all of `OP_HOME`**, which restores native `0600` secret files and proper POSIX
> semantics — with **one carve-out** (the AKM SQLite subtree) gated on an upstream AKM
> change. See §5.

## TL;DR

Add a **separate, one-off CLI** (`op-az`) that deploys and manages the OpenPalm stack on
**Azure Container Apps (ACA)** with a single **Azure Files NFS share mounted as `OP_HOME`**,
so the file-based config/secret model — and the ability to edit those files by hand — is
preserved in the cloud. It is a thin wrapper that shells out to `az` (exactly as the
existing `openpalm` CLI shells out to `docker compose`), reuses `@openpalm/lib` for all
portable control-plane logic, and **introduces no changes to the runtime container images**.

**MVP scope (decided):**
- Deploy **assistant + guardian** only. The **"platform" (admin UI) app is deferred** —
  config/secret management is done via `op-az` + direct edits on the share. op-az is
  *designed* so platform can be added later as an optional third app without rework.
- **Storage: one Azure Files NFS (Premium) share for the whole `OP_HOME`.** NFS v4.1 is
  POSIX, so it gives real `uid/gid` + `chmod` — which **restores OpenPalm's native `0600`
  secret-file contract** that SMB could not honor. Requires a **custom-VNet ACA
  environment** + a private path to the storage account (NFS is not internet-reachable).
- **Secrets: native file secrets on the NFS share at `0600`** (the original OpenPalm
  contract), with `*_FILE` env vars pointing at `OP_HOME/knowledge/secrets/…`. **Key Vault
  is optional**, used only to keep cross-trust secrets off the shared mount for apps that
  don't (and shouldn't) mount `OP_HOME` — i.e. portal apps. It is no longer required just to
  get correct file modes.
- **One carve-out (blocking dependency):** the AKM SQLite databases (`data/akm/data`) use
  `journal_mode=WAL`, which **cannot run on any network filesystem**. Until AKM exposes a
  journal-mode override, that one subtree cannot live on the NFS share. See §5a for the
  resolution path.
- Commands: `install --resource-group`, `status`, `logs`, `config get/set/edit`,
  `portals list/add/remove`.

---

## 1. Goals & non-goals

### Goals
1. `op-az install --resource-group <rg>` provisions everything and brings assistant +
   guardian up on ACA, idempotently (re-run = reconcile = the upgrade path).
2. `OP_HOME` lives on an Azure Files NFS share; the three-tier config/secret model is
   preserved with **native `0600` file modes** (NFS POSIX).
3. Users can **easily edit the config files** on the share (`config edit`, plus documented
   manual paths: a VNet-reachable NFS mount / `az storage file` over the private path).
4. `portals add <name>` enables and configures a portal add-on (secret generation +
   distribution) the ACA way.
5. `config` manages env values per installation or per app, routing non-secret → env and
   secret → the `0600` file on the share (or Key Vault for portal cross-trust secrets).
6. **Thin wrapper / manual-operability**: everything op-az does is reproducible by a user
   running `az` + editing share files by hand. `--dry-run` prints the exact `az` calls and
   file writes.

### Non-goals (explicitly cut for MVP, per the anti-complexity rule)
- No `start`/`stop`/`restart` (ACA has no compose lifecycle; scaling is a revision/scale
  concern).
- No `update`/`self-update`/`migrate`/`pin`/`rollback`/`backups`/`validate`/`scan`/`unlock`
  — `install` is the update path; ACA keeps revision history for rollback; share snapshots
  cover backup.
- No `automations` command — the scheduler is a co-process inside the assistant container
  driven by AKM task files on the share (`knowledge/tasks/*.yml`).
- No containerized admin UI ("platform") in MVP (deferred — see §10).
- No Azure SDK, no Bicep as the primary mechanism (imperative `az`; Bicep export is a
  possible future escape hatch).
- No multi-cloud abstraction.
- No reworking of `@openpalm/lib`, the local CLI, or the runtime images for ACA.

---

## 2. Where OpenPalm's host model fits / fights ACA (and the resolution)

| OpenPalm assumption | ACA reality | Resolution (all-NFS design) |
|---|---|---|
| `0600`/`0700` per-file secret modes | SMB = one fixed mode for the whole share, no runtime `chmod`; **NFS v4.1 = real POSIX** | **Use NFS** → `chmod` works → native `0600`/`0700` preserved (mind root-squash/uid — see §4) |
| Compose `secrets:` → `/run/secrets/<name>` → `*_FILE` | No Compose `secrets:` analog | Secret files live on the NFS share at `0600`; `*_FILE` points at `OP_HOME/knowledge/secrets/…`. Optional Key Vault → ACA secret-volume file for portal cross-trust secrets |
| Per-service narrow grants | Single shared share = every *mounting* app reads every file | Core apps (assistant/guardian) mount the share; **portals do NOT mount it** and receive only their one principal secret via Key Vault / ACA app secret → grant boundary preserved |
| Admin = host process, loopback, Docker socket | No host, no socket; loopback meaningless | Defer admin/UI ("platform"); provision via `op-az`/`az`, edit files on the share |
| Docker network partitioning (`assistant_net`/`portal_net`) | Flat per-environment network (custom VNet) | Re-express isolation via **per-app ingress scope** (assistant internal, guardian external) + single-tenant environment |
| Scheduler = in-container crond, always on | Scale-to-zero kills it | assistant `minReplicas=maxReplicas=1` |
| Local-disk SQLite (AKM, WAL mode) | **WAL cannot run on any network FS** (SMB *or* NFS) | **Carve-out:** AKM `data/akm/data` cannot live on the share until AKM supports a rollback-journal mode. See §5a |
| OpenCode session state | Flat JSON files (verified — not SQLite) | NFS-safe; single replica removes cross-host racing |
| `OP_UID/OP_GID = 1000` | NFS honors real uid/gid | Works; ensure container runtime uid owns the files (no root-squash surprise) |

**Document these as deliberate, ACA-specific deviations** in the operator README. The
security boundary on ACA = ingress scope + single-tenant VNet environment + native `0600`
files + portals-don't-mount-the-share, *not* Docker networks.

---

## 3. Target topology (MVP)

One **custom-VNet ACA environment per install** (single-tenant isolation), with one ACA app
per service and a single NFS share for `OP_HOME`:

```
Azure Files NFS share (Premium FileStorage) ── mounted as OP_HOME at /op-home
        │   POSIX: uid=1000,gid=1000, files 0600 / dirs 0700 (real chmod)
        │   reached over a private endpoint inside the env VNet (NFS not public)
        ▼   [mounted by the CORE apps; portals do NOT mount it]
ACA Environment (custom VNet, per install)
├── guardian   app   EXTERNAL ingress  HTTP :8080  minReplicas 1   [moderator + chat/api edges + MCP gateway stay in-process]
├── assistant  app   INTERNAL ingress       :4096  minReplicas 1 / maxReplicas 1  [+ scheduler crond co-process]
│        └─ AKM SQLite (data/akm/data) → see §5a carve-out (NOT on the NFS share until AKM supports rollback journal)
├── discord    app   no ingress (egress only)       minReplicas 0–1   (optional, via `portals add`; no share mount)
└── slack      app   no ingress (egress only)       minReplicas 0–1   (optional, via `portals add`; no share mount)
   (platform/admin-UI app — DEFERRED; manage config via op-az + share edits)
   (ollama / voice — optional internal apps, post-MVP)
```

Key properties (unchanged from the prior topology except storage):
- **Guardian is the single external ingress** (HTTP, target 8080, ACA-managed TLS, optional
  custom domain). Its in-process co-processes (content-validation moderator on loopback
  :4097, the OpenAI/Anthropic chat/api edges on :8182, the MCP gateway) ride along inside
  the guardian container exactly as today — no change.
- **Assistant has internal ingress only** (`external: false`, target 4096). Guardian calls
  `http://assistant:4096` — the *identical string* to today's compose `OP_ASSISTANT_URL`,
  so the image needs no change.
- **Portals (discord/slack) have no ingress and do not mount `OP_HOME`** (outbound; they
  call `http://guardian:8080/oc`). They receive only their one principal secret via Key
  Vault / ACA app secret. This keeps the per-service grant boundary even though the share
  itself is single and shared by the core apps.
- **assistant `minReplicas=maxReplicas=1`**: scale-to-zero would kill the crond scheduler
  co-process; multiple replicas would run duplicate cron and (for the carve-out DBs) race.
  Guardian `minReplicas=1` (front door + warm moderator).

Rejected alternatives (record): single multi-container "pod" for guardian+assistant
(collapses the trust boundary, shared ingress/scale); ACA Jobs for the scheduler (needs
in-container `localhost:4096` + shared mounts); Azure SDK/Bicep as the primary mechanism
(heavier, hides operations, fights "no template rendering"); **SMB Azure Files** (cannot do
`0600`, breaks SQLite worse than NFS, no real POSIX — see §5a).

---

## 4. Filesystem & mount mapping (NFS)

- **One Azure Files NFS share** (Premium FileStorage account, default name `ophome`)
  registered once at the environment level via `az containerapp env storage set …
  --storage-type NfsAzureFile`, then mounted per core app at `OP_HOME` (e.g. `/op-home`) via
  `volumes` (`storageType: NfsAzureFile`) + `volumeMounts` in each app's YAML. Multiple apps
  sharing one share is supported and preserves OpenPalm's single-root model.
- **NFS infra prerequisites (all required):**
  - **Premium FileStorage** storage account (NFS is premium-only).
  - **Custom-VNet ACA environment** — a managed/Consumption-only environment cannot mount
    NFS. op-az creates/uses a VNet + an infrastructure subnet delegated to
    `Microsoft.App/environments`.
  - **Private reachability** — NFS is **not** internet-reachable. Use a **private endpoint**
    (recommended) or a VNet service endpoint to the storage account, and lock the account
    firewall to the VNet/subnet. If the subnet has an NSG, **allow ports 445 and 2049**.
  - NFS 4.1 on Azure Files has **no in-transit TLS** — security is network isolation
    (private endpoint/VNet), not encryption.
- **Permissions (the win over SMB):** NFS v4.1 is POSIX, so the container creates
  `auth.json` / `user.env` / secret files at **`0600`** and `knowledge/secrets/` at `0700`
  and the modes **stick**. This restores OpenPalm's native file-secret contract. **Watch
  root-squash:** create the share with `NoRootSquash` (or ensure the container's runtime uid
  owns the files), and validate ownership end-to-end after mount — a squashed root or uid
  mismatch can make `0600` files unreadable by the app.
- **Seed `OP_HOME` on the share during install**, non-destructively (only seed missing
  defaults; never overwrite user-edited files): `config/assistant/`, `config/guardian/`,
  `config/akm/`, `knowledge/env/stack.env`, `knowledge/env/user.env` (empty `0600`),
  `knowledge/secrets/` (`0700`, incl. empty `auth.json` `0600`), `data/…`, `workspace/`.
- **Volume mounts require YAML** — flag-based `az containerapp create` cannot express
  `volumes`/`volumeMounts`, so op-az generates per-app YAML from **fixed static templates**
  and injects values via `--set`/env where possible (assemble from whole template files,
  never string-concatenate YAML — the "file assembly, not rendering" rule).
- **`az` mount-option spelling varies by CLI version** (`--server` + `--file-share` vs
  `--azure-file-account-*` for the NFS variant). op-az preflights `az containerapp env
  storage set --help` and validates against the pinned CLI version.
- See §5a for why **`data/akm/data` is the one subtree NOT placed on the share**.

---

## 5. Secrets & the AKM SQLite carve-out

### 5a. The AKM SQLite carve-out (blocking dependency)

**Verified:** AKM (the external `itlackey/akm` CLI backing assistant memory) opens its
databases — `state.db`, `workflow.db`, `index.db` under `AKM_DATA_DIR` (= container
`/opt/akm/data` ← host `data/akm/data`) — with **`PRAGMA journal_mode = WAL`
unconditionally**, plus `busy_timeout = 30000`. It exposes **no env/config knob** to change
the journal mode and does not use `locking_mode = EXCLUSIVE`. Because `akm` is a CLI, an
interactive call and the scheduler cron co-process run as **separate processes opening
separate WAL connections to the same DB**.

**Why this blocks NFS (and SMB):** SQLite **WAL does not work on any network filesystem** —
it requires a host-local `-shm` shared-memory mmap that all connections share; a network FS
cannot back it. **Single-replica does NOT fix this**: the hazard isn't cross-host, it's that
the two co-located `akm` processes on the one host cannot share the `-shm` over the network
mount (failures range from `SQLITE_IOERR_SHMMAP` to divergent/torn writes). OpenPalm already
notes this internally as known limitation "I-12 network FS" — a constraint written for the
local-disk Docker deployment, not for ACA.

**OpenCode session state is NOT affected** — it's flat JSON files (verified), which are
NFS-safe (single replica removes racing). **AKM's `cache` dir is regenerable**, so it is
NFS-safe too. The carve-out is specifically `data/akm/data`.

**Resolution options (in preference order):**
1. **Upstream AKM journal-mode override (preferred; unblocks true all-NFS).** Add an
   `AKM_SQLITE_JOURNAL_MODE` env (or auto-detect network FS → `DELETE`/`TRUNCATE`). Rollback
   journal uses only `fcntl` byte-range locks, which Azure Files NFS v4.1 supports as
   advisory locks — so with a single writer it is the documented-safe mode on network
   storage. With this, `data/akm/data` moves onto the NFS share and the design is fully
   consistent (everything on one share). **This is the single action that makes "all mounts
   on NFS" literally true; track it as a prerequisite and file it against `itlackey/akm`.**
2. **Interim: keep AKM DB files on container-local ephemeral storage** (an `emptyDir`-style
   ephemeral volume), persisting only the regenerable `cache` and durable non-DB artifacts
   to the share. Cost: `state.db`/`workflow.db`/`index.db` are lost on container
   restart/revision (the index is regenerable; `state.db` history is the real loss to
   weigh). Acceptable as a stopgap if memory-history loss on restart is tolerable; otherwise
   not.
3. **Not recommended:** place WAL DBs on NFS anyway — unsupported; expect I/O errors or
   corruption.

**MVP decision:** ship the all-NFS layout for the entire `OP_HOME`, with `data/akm/data`
handled by option (2) **until** option (1) lands upstream, at which point op-az flips that
subtree onto the share (a one-line template change). op-az emits a clear warning when it
uses the ephemeral fallback so the operator knows AKM history won't survive a restart.

### 5b. Secret tiers on NFS (native `0600`, Key Vault optional)

Because NFS restores real `0600`, the SMB→Key-Vault workaround is **no longer required for
correctness**. The mapping simplifies to the OpenPalm-native model, with Key Vault retained
only where an app must *not* mount the whole share:

| OpenPalm artifact | Azure home | Why |
|---|---|---|
| `knowledge/env/stack.env` (non-secret) | **Plain ACA env vars** per app; file kept on the share for manual editing | Not secret; easy manual edit. Guard with `assertNoSecretLikeStackEnvKeys`. |
| `auth.json`, `user.env`, AKM `secret:<name>` files, guardian/admin tokens, UI login password | **NFS share at `0600`** under `knowledge/secrets/` & `knowledge/env/`; `*_FILE` env points at them | Native OpenPalm contract; readable only by the core apps that mount the share (all uid 1000). Read-write files (`auth.json`) work because the share is read-write (KV files would be read-only). |
| Per-principal **portal secrets** | **Key Vault** (or ACA app secret) → ACA secret-volume file on guardian **and** that portal app → `PORTAL_<NAME>_SECRET_FILE` / `PRINCIPAL_SECRET_FILE` | Portals **don't mount the share**, so they need the secret delivered out-of-band. Keeping it in KV (not the share) preserves the per-service grant: only guardian + that one portal declare it. |

**Net:** native `0600` files on the share for everything the core apps consume; Key Vault /
ACA app secrets only for the handful of cross-trust secrets consumed by non-share-mounting
portal apps. One **optional** user-assigned managed identity + Key Vault per install (only
provisioned if portals are used); the identity also carries `AcrPull` for image pull.

### Hard rules carried over (port the guards into op-az)
- `stack.env` must never contain secret-like keys (`assertNoSecretLikeStackEnvKeys`).
- No broad `env_file`; secret-like container values are `*_FILE` paths.
- Never print secret values; mask with `maskSecretValue`.

### Accepted compromises (document in README)
1. **AKM history persistence** depends on the §5a carve-out (ephemeral until the upstream
   AKM journal-mode option lands).
2. A single shared share means the core apps (assistant/guardian, both uid 1000) can read
   each other's `0600` files — acceptable: they already share `auth.json` today, and the
   genuinely cross-trust secret (portal principals) is kept off the share.
3. NFS `fcntl` lock correctness is "advisory byte-range supported" per Azure; load-test the
   rollback-journal path before trusting it in production (relevant once §5a option 1 lands).
4. NFS has no in-transit TLS — rely on the private-endpoint/VNet network isolation.

---

## 6. Command surface

```
op-az
├── install            Deploy/reconcile the stack into a resource group (idempotent; = upgrade path)
├── status             ACA app + revision status (JSON to stdout)
├── logs <app>         Tail/stream logs for one app
├── config
│   ├── get [KEY]      Read effective config value(s) for the install or an app (secrets masked)
│   ├── set KEY=VALUE  Set a value (non-secret→env / secret→0600 share file / portal→KV); new revision
│   └── edit           Open the relevant share file in $EDITOR (download → edit → upload)
└── portals
    ├── list           List available + enabled portal addons
    ├── add <name>     Enable + configure a portal addon (idempotent)
    └── remove <name>  Disable a portal addon (idempotent)
```

### 6.1 `install --resource-group <rg>`
Required: `--resource-group, -g`. Everything else resolves **flag > env > derived default**:

| Input | Flag | Env | Default |
|---|---|---|---|
| Subscription | `--subscription` | `AZURE_SUBSCRIPTION_ID` | current `az account show` |
| Location | `--location, -l` | `OP_AZ_LOCATION` | RG's location if it exists; else required |
| ACA environment name | `--environment` | `OP_AZ_ENV_NAME` | `openpalm` |
| VNet / subnet | `--vnet` / `--subnet` | `OP_AZ_VNET` / `OP_AZ_SUBNET` | created as `openpalm-vnet` / `aca-infra` (delegated) |
| Image tag | `--image-tag` | `OP_IMAGE_TAG` | `latest` |
| Image namespace | `--image-namespace` | `OP_IMAGE_NAMESPACE` | `openpalm` |
| Owner email | `--owner-email` | `OP_OWNER_EMAIL` | signed-in user UPN |
| Storage account | `--storage-account` | `OP_AZ_STORAGE_ACCOUNT` | derived `op<rg-hash>` (Premium FileStorage) |
| File share name | `--share-name` | `OP_AZ_SHARE` | `ophome` |
| AKM data placement | `--akm-data` | `OP_AZ_AKM_DATA` | `ephemeral` until §5a option 1 lands; then `share` |
| Apps to deploy | `--apps` | — | `assistant,guardian` (platform deferred) |

Sequence (each step idempotent / create-or-update):
1. Preflight: `az account show`, `az extension show -n containerapp`, RG exists or
   `--location` given. Register `Microsoft.App` / `Microsoft.OperationalInsights` /
   `Microsoft.Storage` providers. Validate NFS arg spelling via `… storage set --help`.
2. Resource group; **VNet + delegated infra subnet**; **custom-VNet ACA environment**.
3. **Premium FileStorage account + NFS share**; **private endpoint** (or service endpoint)
   into the env VNet; account firewall locked to the VNet; NSG 445/2049 if present.
4. Register the NFS share on the environment (`az containerapp env storage set …
   --storage-type NfsAzureFile`).
5. Seed `OP_HOME` on the share (non-destructive; native `0600`/`0700`; reuse lib seeding
   helpers — see §7). Validate post-mount ownership (root-squash check).
6. *(Only if portals will be used)* optional UAMI + `AcrPull` + Key Vault for portal
   cross-trust secrets.
7. Create-or-update core apps from YAML templates: share mounted at `OP_HOME` (assistant +
   guardian), `data/akm/data` per `--akm-data` (ephemeral volume or share subPath),
   `*_FILE` env pointing at the `0600` share files, `stack.env` keys projected as plain env
   vars, ingress + scale per §3.
8. Write/refresh state file (§9); print summary (FQDNs, revision names, AKM-data placement
   + warning if ephemeral).

Flags: `--dry-run` (print exact `az` calls + file writes, change nothing), `--no-seed`
(apps only), `--yes/-y`.

### 6.2 `status`
Read-only. `az containerapp show/list` → app name, active/latest revision, running state,
replica count, ingress FQDN, image tag, AKM-data placement. JSON to stdout, advisories to
stderr.

### 6.3 `logs <assistant|guardian> [--follow] [--tail N]`
Thin wrapper over `az containerapp logs show`. Default `--tail 100`. App name required.

### 6.4 `config get/set/edit`
- **get [KEY]**: parse `stack.env` from the share (`parseEnvFile`); mask secrets
  (`maskSecretValue`, classify with `isSecretLikeKey`/`PLAIN_CONFIG_KEYS`); `--app` narrows
  to one container's effective env; `--reveal` to unmask (explicit).
- **set KEY=VALUE [--app <name>] [--secret] [--no-apply]**:
  1. Classify (`--secret` or `isSecretLikeKey`). Guard: refuse a secret-like key in
     `stack.env`.
  2. Non-secret → `upsertEnvValue` in `stack.env` on the share (comment-preserving); project
     as ACA env var.
  3. Secret consumed by a share-mounting core app → write the **`0600` file** on the share
     (`writeSecret`/`ensureSecret`); restart the consuming app.
  4. Secret for a portal (non-share-mounting) → `az keyvault secret set` (new version) +
     ensure the KV-ref secret + secret-volume on the portal/guardian apps.
  5. Project to ACA = new revision (print its name). `--no-apply` writes the file only.
- **edit [--app <name>] [--secrets]**: `az storage file download` (over the private path)
  into `~/.cache/op-az/`, spawn `$EDITOR` (fallback `vi`/`nano`/`notepad`), on save validate
  (secret-boundary guard for `stack.env`) then `az storage file upload`, then offer to
  project to ACA. Always print the NFS-mount hint + raw `az storage file` commands.

### 6.5 `portals list/add/remove`
- **list**: `listAvailableAddonIds()` annotated with `listEnabledAddonIds(homeDir)`.
- **add <name>**:
  1. Validate against `listAvailableAddonIds()`.
  2. `upsertEnvValue` `OP_ENABLED_ADDONS` in `stack.env` on the share (idempotent).
  3. Generate the principal secret; for `discord`/`slack` (separate, non-share-mounting
     apps) store it in **Key Vault** and wire it as an ACA secret-volume file on **guardian**
     and the new portal app (`PORTAL_<NAME>_SECRET_FILE` / `PRINCIPAL_SECRET_FILE`). For the
     guardian-image edges (`api`, `chat`) the secret can live as a `0600` file on the share
     since guardian mounts it.
  4. Accept addon env via `--set KEY=VALUE` (pass-through for MVP).
  5. Restart guardian revision so it reseeds principal records.
- **remove <name>**: reverse; drop from `OP_ENABLED_ADDONS`, delete the portal app, leave the
  KV secret unless `--purge`. Idempotent.

`--dry-run` on add/remove.

---

## 7. Code reuse vs. one-off isolation

**`op-az` lives in this monorepo as `packages/op-az/` and depends on `@openpalm/lib`.**
"One-off" describes its scope (Azure-only, MVP), not a license to fork control-plane logic.

**Reuse from `@openpalm/lib` (by name):**
- Env I/O: `parseEnvFile`, `parseEnvContent`, `upsertEnvValue`, `removeEnvKey`,
  `mergeEnvContent`, `expandEnvVars`, `parseEnabledAddons`.
- Addons/portals: `listAvailableAddonIds`, `listEnabledAddonIds`, `getAddonServiceNames`,
  `portalSecretName`, `ensurePortalSecret`.
- Secret boundary: `isSecretLikeKey`, `assertNoSecretLikeStackEnvKeys`, `PLAIN_CONFIG_KEYS`,
  `maskSecretValue`, `STATIC_CORE_MAPPINGS` (share-vs-KV routing), `writeSecret`,
  `ensureSecret`, `readSecret`, `listSecretNames`, `secretPath`.
- Constants/types: `PROVIDER_KEY_MAP`, `LLM_PROVIDERS`, image-tag helpers, `SetupSpec` /
  `SetupConnection` **types**, `writeFileAtomic`.

**Genuinely new (in `packages/op-az/`, NOT lib):** the `az` invocation wrapper (argv arrays,
no shell), ACA app create-or-update / revision logic, VNet + NFS env + storage-mount setup,
Azure File Share I/O for `config edit`, optional ACA secret/KV wiring for portals, the op-az
state file.

**Do NOT pull** lib's compose/docker/lifecycle/rollback/migration functions — Compose/host
specific, meaningless on ACA.

**Possible small lib extraction:** a share-path-agnostic "seed OP_HOME env/config defaults"
helper if one isn't cleanly callable today (`writeSystemEnv` is close but writes via local
state). Extract the portable part into lib rather than copy it into op-az.

---

## 8. Implementation shape

- **Runtime/framework:** Bun + citty, identical to `packages/cli` — same lazy-loaded
  subcommand pattern, `defineCommand`, `bun build --compile` single binary. Package mirrors
  `packages/cli/package.json` (`"bin": { "op-az": … }`, deps `@openpalm/lib`, `citty`).
- **Azure mechanism:** shell out to `az` with **argv arrays** (`Bun.spawn`, no shell
  interpolation). `--output json` for parsing. Preflight `az --version` + `az extension show
  -n containerapp` like the CLI preflights Docker.
- **YAML:** assemble per-app YAML from fixed template files; inject values via `--set`/env,
  never string-concatenate YAML.
- **Thin:** every command = a small named sequence of `az` calls + file edits, each printable
  via `--dry-run`. No daemons, no hidden state beyond the share state file.

---

## 9. State & idempotency

Single plain JSON state file on the share: `OP_HOME/data/op-az/state.json` (under `data/`,
mirroring how the local CLI keeps `host.json`/journals there). Records desired/last-applied
inputs (subscription, RG, location, env name, VNet/subnet, storage account, share, image
namespace/tag, AKM-data placement, per-app metadata, `lastApplied`). Every command is
**read-state → reconcile → write-state**.
- On the share (not local) because the share is the durable authoritative root.
- **Degrades gracefully if missing**: fall back to `--resource-group` + conventions.
- No DB, no remote state backend, no lock service for MVP (add a share-file lock mirroring
  `acquireInstallLock` later if concurrent operators become a problem).

---

## 10. Deferred: the "platform" / admin-UI app

Deferred for MVP (decided). When revisited, the intended shape is `@openpalm/ui`
containerized as a third ACA app with **internal-ingress-only** + the existing
login-password / session-cookie auth and `Host`-header allowlist — the closest ACA analog to
"host-only." It requires a security decision to relax invariant #1/#6 ("admin is host-only,
never a container") as a documented ACA-specific exception, plus a new control-plane story
(admin manages `docker compose` over a host socket today; on ACA it would manage apps via
the ACA management API / `az`). op-az keeps `platform` as a named, optional, droppable app
(`--apps`). Do not smuggle this into the MVP.

---

## 11. Deliverables

- `packages/op-az/` — Bun + citty CLI: `src/main.ts`, `src/commands/{install,status,logs,config,portals}.ts`,
  `src/lib/{az.ts,aca.ts,vnet.ts,share.ts,keyvault.ts,state.ts}`, `package.json`, tests.
- `packages/op-az/templates/{assistant,guardian,portal}.yaml` — fixed per-app YAML templates
  (NFS volume; assistant variant for ephemeral vs share AKM-data placement).
- `packages/op-az/README.md` — operator guide: prerequisites (Azure roles, `az` +
  containerapp extension, VNet/quota), inputs, deploy flow, **the documented ACA
  deviations** (public ingress vs LAN-first, custom VNet + NFS private endpoint, the AKM-data
  carve-out + the upstream-AKM prerequisite, portal cross-trust secrets in KV), editing files
  on the share, teardown (`az group delete`), troubleshooting (NFS mount/root-squash, KV
  access, revision startup, AKM `SQLITE_IOERR_SHMMAP` if misconfigured).
- **Upstream AKM tracking item:** feature request to `itlackey/akm` for an
  `AKM_SQLITE_JOURNAL_MODE` (or network-FS auto-detect → `DELETE`) override — the
  prerequisite that lets `data/akm/data` move onto the NFS share (§5a option 1).
- Root `README.md` + `CHANGELOG.md` (Unreleased) — note ACA as an **additional** deployment
  target, not a replacement for Docker Compose; no admin UI in this mode.
- Possible minor `@openpalm/lib` extraction (seed-defaults helper) if required by §7.

---

## 12. Validation & testing

- Unit-test the `az` wrapper (argv assembly, no shell), config routing
  (non-secret/share-secret/portal-KV classification), portal secret wiring, state
  read/reconcile, and `--dry-run` output. Mock `az` (no live Azure in CI).
- Confirm secrets never appear in logs, generated YAML, or `az containerapp show` output.
- **Live smoke in a real subscription:** `install` (custom VNet + NFS) → verify `0600` modes
  stick on the share (root-squash check) → request through guardian external FQDN → guardian
  forwards to internal assistant → assistant answers → AKM memory behaves per the chosen
  `--akm-data` placement (and survives a revision restart **only** when on the share with the
  rollback-journal AKM build) → `portals add discord` (KV secret) → `config set`
  (non-secret + secret) → teardown.
- **AKM journal-mode regression:** once §5a option 1 lands, load-test concurrent `akm`
  invocations against the NFS-hosted DBs in rollback-journal mode before defaulting
  `--akm-data share`.

---

## 13. Top risks

1. **AKM forces WAL (blocking for the data subtree).** `data/akm/data` cannot live on any
   network share until AKM gains a rollback-journal option. MVP ships with ephemeral AKM
   data (history lost on restart) until the upstream change lands. This is the #1 dependency.
2. **NFS infra surface.** Custom VNet + Premium FileStorage + private endpoint + NSG
   445/2049 + no-public-access is materially more infra than SMB. op-az must provision it
   correctly and idempotently; root-squash/uid mismatches can silently break `0600`
   readability — validate ownership post-mount.
3. **Public-exposure mismatch.** ACA external ingress is internet-routable by default, unlike
   LAN-first self-hosting. README must not imply the self-hosted security posture.
4. **`az` dependency / version drift / eventual consistency.** Requires `az` + the
   containerapp extension + login; NFS arg spelling varies by CLI version; RBAC grants
   (for the optional KV/UAMI) are eventual → op-az retries and restarts revisions for
   deterministic apply.

---

## 14. Reconciliation note (unrelated, surfaced during research)

The live `portals.compose.yml` sets `GUARDIAN_CONTENT_VALIDATION` default to `1` (on), while
`docs/technical/core-principles.md` describes it as off by default. Not an ACA concern, but
worth the team reconciling separately.

---

## Appendix: source research

Full specialist investigations (debate inputs) were produced under `.scratch/op-az/`
(gitignored — working artifacts): `azure-architecture.md`, `secrets-keyvault.md`,
`cli-design.md`, and `sqlite-nfs-verification.md` (the storage/DB verification that drove the
SMB→NFS revision). Prior art:
`.github/roadmap/0.10.0/plans/issue-315-azure-container-apps.md`. Primary references cited
inline in those docs (Microsoft Learn: ACA ingress/connect-apps/storage-mounts/manage-secrets/
managed-identity-image-pull/scale, NFS file shares, env storage; SQLite WAL / network-FS /
locking docs; AKM repo `itlackey/akm`).
