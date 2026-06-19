# Plan: `op-az` — One-off CLI for OpenPalm on Azure Container Apps

> Status: Proposed (planning). Branch: `claude/op-az-azure-cli-tool-z3b0nk`.
> Author: synthesized from a three-specialist design debate (Azure Container Apps
> architecture, secrets/Key Vault/identity, CLI design) refereed against
> `docs/technical/core-principles.md`. Supersedes/modernizes the v0.10-era
> `.github/roadmap/0.10.0/plans/issue-315-azure-container-apps.md` (which targeted a
> bash `deploy-aca.sh` against the pre-0.11 `channel → guardian → assistant → memory`
> architecture).

## TL;DR

Add a **separate, one-off CLI** (`op-az`) that deploys and manages the OpenPalm stack on
**Azure Container Apps (ACA)** with an **Azure File Share mounted as `OP_HOME`**, so the
file-based config/secret model — and the ability to edit those files by hand — is
preserved in the cloud. It is a thin wrapper that shells out to `az` (exactly as the
existing `openpalm` CLI shells out to `docker compose`), reuses `@openpalm/lib` for all
portable control-plane logic, and **introduces no changes to the runtime container
images**.

**MVP scope (decided):**
- Deploy **assistant + guardian** only. The **"platform" (admin UI) app is deferred** —
  config/secret management is done via `op-az` + direct edits on the file share. op-az is
  *designed* so platform can be added later as an optional third app without rework.
- **Secrets posture: SMB Azure Files + Key Vault hybrid.** Cross-trust secrets live in Key
  Vault and are projected into apps as ACA secret-volume **files** (preserving the `*_FILE`
  contract); AKM-consumed and read-write secrets (`auth.json`, `user.env`) stay as files on
  the share. Portals do **not** mount the share.
- Commands: `install --resource-group`, `status`, `logs`, `config get/set/edit`,
  `portals list/add/remove`.

---

## 1. Goals & non-goals

### Goals
1. `op-az install --resource-group <rg>` provisions everything and brings assistant +
   guardian up on ACA, idempotently (re-run = reconcile = the upgrade path).
2. `OP_HOME` lives on an Azure File Share; the three-tier config/secret model is preserved
   as faithfully as Azure primitives allow.
3. Users can **easily edit the config files** on the share (`config edit`, plus documented
   manual paths: Storage Explorer / SMB mount / `az storage file`).
4. `portals add <name>` enables and configures a portal add-on (secret generation +
   distribution) the ACA way.
5. `config` manages env values per installation or per app, routing non-secret → env,
   cross-trust secret → Key Vault, AKM/read-write secret → share.
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
- No containerized admin UI ("platform") in MVP (deferred — see §8).
- No Azure SDK, no Bicep as the primary mechanism (imperative `az`; Bicep export is a
  possible future escape hatch).
- No NFS/VNet, no hub-spoke, no multi-cloud abstraction.
- No reworking of `@openpalm/lib`, the local CLI, or the runtime images for ACA.

---

## 2. Where OpenPalm's host model fights ACA (and the resolution)

| OpenPalm assumption | ACA reality | MVP resolution |
|---|---|---|
| `0600`/`0700` per-file secret modes | SMB = one mode for the whole share, no runtime `chmod` | Accept share-wide mode (`file_mode=0660,dir_mode=0770,uid=1000,gid=1000`); put cross-trust secrets in Key Vault instead of relying on file modes |
| Compose `secrets:` → `/run/secrets/<name>` files → `*_FILE` | No Compose `secrets:` analog | ACA **secret-volume mount** backed by Key Vault refs: each secret becomes a file named after the secret at `/mnt/secrets/<name>`; set `*_FILE` to that path |
| Per-service narrow grants | Single shared share = every mounting app reads every file | Isolation moves to **"which app declares which KV secret"**; portals do **not** mount the share |
| Admin = host process, loopback, Docker socket | No host, no socket; loopback meaningless | Defer admin/UI ("platform"); provision via `op-az`/`az`, edit files on the share |
| Docker network partitioning (`assistant_net`/`portal_net`) | Flat per-environment network | Re-express isolation via **per-app ingress scope** (assistant internal, guardian external) + single-tenant environment |
| Scheduler = in-container crond, always on | Scale-to-zero kills it | assistant `minReplicas=maxReplicas=1` |
| Local-disk SQLite/AKM data | SMB latency + locking | Premium file share; document the risk and the option to keep hot data off SMB |
| `OP_UID/OP_GID = 1000` | Honored via `uid=1000,gid=1000` mount options | Works as-is |

**Document these as deliberate, ACA-specific deviations** in the operator README. The
security boundary on ACA = ingress scope + single-tenant environment + KV-backed
cross-trust secrets, *not* Docker networks + file modes.

---

## 3. Target topology (MVP)

One **ACA environment per install** (single-tenant isolation), Consumption plan, with one
ACA app per service:

```
Azure File Share ── mounted as OP_HOME (SMB; file_mode=0660,dir_mode=0770,uid=1000,gid=1000,
        │           nobrl,mfsymlinks,cache=strict,actimeo=30)   [shared by core apps]
        ▼
ACA Environment (per install)
├── guardian   app   EXTERNAL ingress  HTTP :8080  minReplicas 1   [moderator + chat/api edges + MCP gateway stay in-process]
├── assistant  app   INTERNAL ingress       :4096  minReplicas 1 / maxReplicas 1  [+ scheduler crond co-process]
├── discord    app   no ingress (egress only)       minReplicas 0–1   (optional, via `portals add`)
└── slack      app   no ingress (egress only)       minReplicas 0–1   (optional, via `portals add`)
   (platform/admin-UI app — DEFERRED; manage config via op-az + share edits)
   (ollama / voice — optional internal apps, post-MVP)
```

Key properties:
- **Guardian is the single external ingress** (HTTP, target 8080, ACA-managed TLS, optional
  custom domain). Its in-process co-processes (content-validation moderator on loopback
  :4097, the OpenAI/Anthropic chat/api edges on :8182, the MCP gateway) ride along inside
  the guardian container exactly as today — no change.
- **Assistant has internal ingress only** (`external: false`, target 4096). Reachable only
  inside the environment; never internet-routable. Guardian calls `http://assistant:4096`
  — the *identical string* to today's compose `OP_ASSISTANT_URL`, so the image needs no
  change.
- **Portals (discord/slack) have no ingress** (outbound; they call `http://guardian:8080/oc`).
  They do **not** mount the OP_HOME share — they receive only their one principal secret via
  Key Vault (this is what makes the SMB share-wide-mode compromise acceptable).
- **assistant `minReplicas=maxReplicas=1`**: scale-to-zero would kill the crond scheduler
  co-process, and multiple replicas would run duplicate cron jobs and contend on the AKM
  SQLite DBs over SMB. Guardian `minReplicas=1` (front door + warm moderator for
  fail-closed validation).

Rejected alternatives (with reasons captured for the record):
- **Single multi-container "pod" for guardian+assistant** — collapses the guardian↔assistant
  trust boundary into one network namespace, forces a shared ingress + shared scale count.
  Rejected.
- **ACA Jobs for the scheduler** — the scheduler needs in-container `localhost:4096` access
  and the assistant's shared mounts/env; a separate Job has neither. Stays a co-process.
- **Azure SDK / Bicep as the primary mechanism** — heavier, hides operations from the
  manual-operability contract, adds a templating layer that fights "no template rendering."
  Shell out to `az`. (Bicep export is a possible future advanced aid.)

---

## 4. Filesystem & mount mapping

- One Azure File Share (default name `ophome`) registered once at the environment level via
  `az containerapp env storage set` (SMB, ReadWrite), then mounted per app at `OP_HOME`
  (e.g. `/op_home`) via `volumes` + `volumeMounts` in each app's YAML. Multiple apps sharing
  one share is supported and is what preserves OpenPalm's single-root model.
- **Volume mounts require YAML** — flag-based `az containerapp create` cannot express
  `volumes`/`volumeMounts`, so op-az generates per-app YAML from **fixed static templates**
  and injects values via `--set`/env where possible (consistent with the "file assembly,
  not string interpolation" rule — assemble from whole template files, don't build YAML by
  string concatenation).
- **Seed `OP_HOME` on the share during install**, non-destructively (only seed missing
  defaults; never overwrite user-edited files): `config/assistant/`, `config/guardian/`,
  `config/akm/`, `knowledge/env/stack.env`, `knowledge/env/user.env` (empty),
  `knowledge/secrets/` (incl. empty `auth.json`), `data/…`, `workspace/`.
- **Storage tiering:** use **Premium file shares** for acceptable latency on the hot AKM
  SQLite data (`data/akm/data`) and OpenCode session state. Document the option to keep hot
  data off the shared SMB share if locking/corruption appears. Config/secrets (small, rarely
  written) on SMB is fine.
- The share is accessed via the **storage account key** (no identity-based share access for
  the env storage link). op-az stores the account key reference only as needed; the key
  itself is fetched at provision time (`az storage account keys list`) and never written to
  a checked-in file or echoed in logs.

---

## 5. Secrets, Key Vault & identity (the hybrid)

### Provisioned per install
- **One user-assigned managed identity (UAMI)** attached to all apps, granted:
  - `AcrPull` on the registry (image pull via `--registry-identity`),
  - `Key Vault Secrets User` on the install's Key Vault (RBAC mode, not access policies).
  (System-assigned won't do — multiple apps must share the same KV/registry grants; a UAMI
  is created once and survives app recreation. RBAC role assignment is eventually
  consistent → op-az retries app create/secret resolution for ~a minute after granting.)
- **One Key Vault per install** (RBAC mode). Secrets referenced from apps as
  `keyvaultref:<versionless-uri>,identityref:<uami-id>`. Versionless URIs auto-refresh
  within ~30 min; op-az forces deterministic apply by restarting the affected revision.

### Tier mapping (reuse the existing `@openpalm/lib` classifier to route)

| OpenPalm artifact | Azure home | Why |
|---|---|---|
| `knowledge/env/stack.env` (non-secret) | **Plain ACA env vars** per app; file kept on the share for manual editing | Not secret; keeps easy manual edit; no KV cost. Guard with `assertNoSecretLikeStackEnvKeys`. |
| Per-principal **portal secrets** | **Key Vault** → ACA secret-volume file on guardian **and** that portal app → `PORTAL_<NAME>_SECRET_FILE` / `PRINCIPAL_SECRET_FILE` | Clean per-service grant boundary (only guardian + that one portal declare it); preserves `*_FILE`. KV-backed from day one. |
| Guardian/admin tokens (`op_guardian_admin_token`, `op_guardian_mcp_token`, `op_ui_login_password`) | **Key Vault** → secret-volume files on the consuming app | Single-consumer, clean. |
| `auth.json` (OpenCode provider creds, shared, read+rewritten in place) | **File share** at `knowledge/secrets/auth.json` | Read-write JSON mutated by OpenCode; KV secrets are immutable-versioned and secret-volume files are read-only → KV would break write-back. |
| `user.env` (AKM `env:user`) + AKM `secret:<name>` files | **File share** under `knowledge/env/` and `knowledge/secrets/` | AKM reads from `/stash` filesystem; no Key Vault driver. Must be files the assistant reads. |

**Net:** KV + secret-volume for cleanly-grantable cross-trust **service** secrets; file
share for **AKM-consumed** and **read-write** secrets. Routing decision reuses
`STATIC_CORE_MAPPINGS` (its `scope: user|system` split is exactly share-vs-KV) and
`isSecretLikeKey`.

### Accepted compromises (document in README)
1. `0600` per-file isolation on the share is impossible on SMB. Acceptable because the share
   is mounted only by trusted core apps (assistant/guardian, both uid 1000), and the
   genuinely cross-trust secret (portal principals) is KV-backed and **not** on the share.
2. `secrets:`-style narrow grant is replaced by "which app declares the KV secret" —
   functionally equivalent least-privilege, but an Azure construct, not the Compose one.
3. `auth.json` stays a share file and loses `0600`.
4. Versionless KV rotation is eventual (≤30 min); op-az restarts revisions for deterministic
   apply. Secret-volume **file** refresh on rotation is treated as "requires revision
   restart" until proven otherwise.

### Hard rules carried over (port the guards into op-az)
- `stack.env` must never contain secret-like keys (`assertNoSecretLikeStackEnvKeys`).
- No broad `env_file`; secret-like container values are `*_FILE` paths.
- Never print secret values; mask with `maskSecretValue`.

---

## 6. Command surface

```
op-az
├── install            Deploy/reconcile the stack into a resource group (idempotent; = upgrade path)
├── status             ACA app + revision status (JSON to stdout)
├── logs <app>         Tail/stream logs for one app
├── config
│   ├── get [KEY]      Read effective config value(s) for the install or an app (secrets masked)
│   ├── set KEY=VALUE  Set a value (routes non-secret→env / cross-trust→KV / AKM→share); new revision
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
| Image tag | `--image-tag` | `OP_IMAGE_TAG` | `latest` |
| Image namespace | `--image-namespace` | `OP_IMAGE_NAMESPACE` | `openpalm` |
| Owner email | `--owner-email` | `OP_OWNER_EMAIL` | signed-in user UPN |
| Storage account | `--storage-account` | `OP_AZ_STORAGE_ACCOUNT` | derived `op<rg-hash>` |
| File share name | `--share-name` | `OP_AZ_SHARE` | `ophome` |
| Apps to deploy | `--apps` | — | `assistant,guardian` (platform deferred) |

Sequence (each step idempotent / create-or-update):
1. Preflight: `az account show`, `az extension show -n containerapp`, RG exists or
   `--location` given. Register `Microsoft.App` / `Microsoft.OperationalInsights` providers.
2. Resource group; ACA environment; storage account + SMB share; env storage link.
3. UAMI + role assignments (`AcrPull`, `Key Vault Secrets User`); Key Vault (RBAC).
4. Seed `OP_HOME` on the share (non-destructive; reuse lib seeding helpers — see §7).
5. Generate guardian/admin secrets → write to Key Vault; declare as ACA secrets
   (`keyvaultref…,identityref…`, versionless).
6. Create-or-update apps from YAML templates: UAMI attached, ACR pull via UAMI, share
   mounted at `OP_HOME`, secret-volume mount at `/mnt/secrets`, `*_FILE` env pointing at the
   mounted paths, `stack.env` keys projected as plain env vars, ingress + scale per §3.
7. Write/refresh state file (§9); print summary (FQDNs, revision names).

Flags: `--dry-run` (print exact `az` calls + file writes, change nothing), `--no-seed`
(apps only), `--yes/-y`.

### 6.2 `status`
Read-only. `az containerapp show/list` → app name, active/latest revision, running state,
replica count, ingress FQDN, image tag. JSON to stdout, advisories to stderr.

### 6.3 `logs <assistant|guardian> [--follow] [--tail N]`
Thin wrapper over `az containerapp logs show`. Default `--tail 100`. App name required (ACA
has no "all services" stream — don't fake it).

### 6.4 `config get/set/edit`
- **get [KEY]**: parse `stack.env` from the share (`parseEnvFile`); mask secrets
  (`maskSecretValue`, classify with `isSecretLikeKey`/`PLAIN_CONFIG_KEYS`); `--app` narrows
  to one container's effective env; `--reveal` to unmask (explicit).
- **set KEY=VALUE [--app <name>] [--secret] [--no-apply]**:
  1. Classify (`--secret` or `isSecretLikeKey`). Guard: refuse a secret-like key in
     `stack.env`.
  2. Non-secret → `upsertEnvValue` in `stack.env` on the share (comment-preserving); project
     as ACA env var.
  3. Cross-trust secret → `az keyvault secret set` (new version) + ensure KV-ref secret +
     secret-volume on the app(s).
  4. AKM/read-write secret → write the share file (`writeSecret`) instead, restart assistant.
  5. Project to ACA = new revision (print its name). `--no-apply` writes the file only
     ("edit now, apply later").
- **edit [--app <name>] [--secrets]**: `az storage file download` the target file into
  `~/.cache/op-az/`, spawn `$EDITOR` (fallback `vi`/`nano`/`notepad`), on save validate
  (secret-boundary guard for `stack.env`) then `az storage file upload`, then offer to
  project to ACA. Always print the Storage Explorer hint + raw `az storage file` commands.
  (No persistent local SMB mount — download/edit/upload is portable, stateless,
  dry-runnable.)

### 6.5 `portals list/add/remove`
- **list**: `listAvailableAddonIds()` annotated with `listEnabledAddonIds(homeDir)`.
- **add <name>**:
  1. Validate against `listAvailableAddonIds()`.
  2. `upsertEnvValue` `OP_ENABLED_ADDONS` in `stack.env` on the share (idempotent).
  3. Generate + store the principal secret in Key Vault (`ensurePortalSecret`/
     `portalSecretName` for naming); declare it as an ACA secret on **guardian** and on the
     portal app; set `PORTAL_<NAME>_SECRET_FILE` / `PRINCIPAL_SECRET_FILE`.
  4. For repo edges served by the **guardian image** (`api`, `chat`): flip the flag + secret
     on the guardian app (no new app). For `discord`/`slack` (the `portal` image): create a
     new no-ingress ACA app.
  5. Accept addon env via `--set KEY=VALUE` (pass-through for MVP).
  6. Restart guardian revision so it reseeds principal records (matches on-prem "recreate
     guardian + portal").
- **remove <name>**: reverse; drop from `OP_ENABLED_ADDONS`, delete the portal app, leave the
  KV secret unless `--purge`. Idempotent.

`--dry-run` on add/remove.

---

## 7. Code reuse vs. one-off isolation

**`op-az` lives in this monorepo as `packages/op-az/` and depends on `@openpalm/lib`.**
"One-off" describes its scope (Azure-only, MVP), not a license to fork control-plane logic —
the "never duplicate control-plane logic" rule applies to every consumer.

**Reuse from `@openpalm/lib` (by name):**
- Env I/O: `parseEnvFile`, `parseEnvContent`, `upsertEnvValue`, `removeEnvKey`,
  `mergeEnvContent`, `expandEnvVars`, `parseEnabledAddons`.
- Addons/portals: `listAvailableAddonIds`, `listEnabledAddonIds`, `getAddonServiceNames`,
  `portalSecretName`, `ensurePortalSecret`.
- Secret boundary: `isSecretLikeKey`, `assertNoSecretLikeStackEnvKeys`, `PLAIN_CONFIG_KEYS`,
  `maskSecretValue`, `STATIC_CORE_MAPPINGS` (share-vs-KV routing), `writeSecret`,
  `ensureSecret`, `readSecret`, `listSecretNames`, `secretPath`.
- Constants/types: `PROVIDER_KEY_MAP`, `LLM_PROVIDERS`, image-tag helpers, `SetupSpec` /
  `SetupConnection` **types** (so an `op-az install --file` can consume the same spec format
  as `openpalm install --file`), `writeFileAtomic`.

**Genuinely new (in `packages/op-az/`, NOT lib):** the `az` invocation wrapper (argv arrays,
no shell), ACA app create-or-update / revision logic, env + storage-mount setup, Azure File
Share download/edit/upload, ACA secret/KV wiring, the op-az state file.

**Do NOT pull** lib's compose/docker/lifecycle/rollback/migration functions — Compose/host
specific, meaningless on ACA.

**Possible small lib extraction:** a share-path-agnostic "seed OP_HOME env/config defaults"
helper if one isn't cleanly callable today (`writeSystemEnv` is close but writes via local
state). If needed, extract the portable part into lib rather than copy it into op-az — that
*is* the rule.

---

## 8. Implementation shape

- **Runtime/framework:** Bun + citty, identical to `packages/cli` — same lazy-loaded
  subcommand pattern, `defineCommand`, `bun build --compile` single binary. Package mirrors
  `packages/cli/package.json` (`"bin": { "op-az": … }`, deps `@openpalm/lib`, `citty`).
- **Azure mechanism:** shell out to `az` with **argv arrays** (`Bun.spawn`, no shell
  interpolation — core-principles "No shell interpolation"). `--output json` for parsing.
  Preflight `az --version` + `az extension show -n containerapp` like the CLI preflights
  Docker. Auth is whatever `az login` already established.
- **YAML:** assemble per-app YAML from fixed template files; inject values via `--set`/env,
  never string-concatenate YAML.
- **Thin:** every command = a small named sequence of `az` calls + file edits, each printable
  via `--dry-run`. No daemons, no hidden state beyond the share state file.

---

## 9. State & idempotency

Single plain JSON state file on the share: `OP_HOME/data/op-az/state.json` (under `data/`,
mirroring how the local CLI keeps `host.json`/journals there). Records desired/last-applied
inputs (subscription, RG, location, env name, storage account, share, image namespace/tag,
per-app metadata, `lastApplied`). Every command is **read-state → reconcile → write-state**.
- On the share (not local) because the share is the durable authoritative root — survives a
  different operator running op-az from a different machine.
- **Degrades gracefully if missing**: fall back to `--resource-group` + conventions so op-az
  still works against a hand-deployed stack (thin-wrapper / tooling-not-required).
- No DB, no remote state backend, no lock service for MVP. If concurrent operators become a
  problem, add a simple share-file lock mirroring lib's `acquireInstallLock` later.

---

## 10. Deferred: the "platform" / admin-UI app

Deferred for MVP (decided). When revisited, the intended shape is: **`@openpalm/ui`
containerized as a third ACA app with internal-ingress-only + the existing login-password /
session-cookie auth and `Host`-header allowlist** — the closest ACA analog to "host-only."
This requires a **security decision to relax invariant #1/#6 ("admin is host-only, never a
container") as a documented ACA-specific exception**, plus a new control-plane story (the
admin UI manages `docker compose` over a host socket today; on ACA it would manage apps via
the ACA management API / `az` — a different control plane). op-az keeps `platform` as a
named, optional, droppable app (`--apps`) so it can be added without reworking install.
**Do not** smuggle this into the MVP.

---

## 11. Deliverables

- `packages/op-az/` — Bun + citty CLI: `src/main.ts`, `src/commands/{install,status,logs,config,portals}.ts`,
  `src/lib/{az.ts (az wrapper),aca.ts (app/revision),share.ts (file I/O),keyvault.ts,state.ts}`,
  `package.json`, tests.
- `packages/op-az/templates/{assistant,guardian,portal}.yaml` — fixed per-app YAML templates.
- `packages/op-az/README.md` — operator guide: prerequisites (Azure roles, `az` +
  containerapp extension), inputs, deploy flow, **the documented ACA deviations** (public
  ingress vs LAN-first, share-wide file modes, KV secret model, no admin UI, share-vs-KV
  secret routing), editing files on the share, teardown (`az group delete`), troubleshooting
  (KV access denied, revision startup failures, mount issues, stale internal FQDN, eventual
  KV rotation).
- Root `README.md` + `CHANGELOG.md` (Unreleased) — note ACA as an **additional** deployment
  target, not a replacement for Docker Compose self-hosting; no admin UI in this mode.
- Possible minor `@openpalm/lib` extraction (seed-defaults helper) if required by §7.

---

## 12. Validation & testing

- Unit-test the `az` wrapper (argv assembly, no shell), config routing
  (non-secret/cross-trust/AKM classification), portal secret wiring, state read/reconcile,
  and `--dry-run` output. Mock `az` (no live Azure in CI).
- `bash -n` / `shellcheck` any generated shell; confirm secrets never appear in logs,
  generated YAML, or `az containerapp show` output as literal values.
- Manual smoke in a real subscription: `install` → request through guardian external FQDN →
  guardian forwards to internal assistant → assistant answers without an admin UI → AKM
  persistence survives a revision restart → `portals add discord` → `config set`
  (non-secret + secret) → teardown. Capture an operator verification checklist in the README.
- Confirm each app uses only the env/secrets it needs (least privilege).

---

## 13. Top risks

1. **SQLite/AKM data over SMB** — locking/corruption/latency on the hot DBs. Mitigate with
   Premium shares; test before recommending; document the "keep hot data off SMB" option.
2. **Secret-model fidelity** — the `0600`/per-service-grant contract is only *approximated*
   (KV for cross-trust + share-wide mode for the rest). Acceptable only while portals don't
   mount the share and the environment is single-tenant. Re-validate if that changes (would
   force NFS/VNet).
3. **Public-exposure mismatch** — ACA external ingress is internet-routable by default,
   unlike LAN-first self-hosting. README must not imply the self-hosted security posture.
4. **`az` dependency / eventual consistency** — requires `az` + the containerapp extension +
   login; RBAC grants and versionless KV rotation are eventual → op-az retries and restarts
   revisions for deterministic apply.

---

## 14. Reconciliation note (unrelated, surfaced during research)

The live `portals.compose.yml` sets `GUARDIAN_CONTENT_VALIDATION` default to `1` (on), while
`docs/technical/core-principles.md` describes it as off by default. Not an ACA concern, but
worth the team reconciling separately.

---

## Appendix: source research

Full specialist investigations (debate inputs) were produced under `.scratch/op-az/`
(gitignored — working artifacts): `azure-architecture.md`, `secrets-keyvault.md`,
`cli-design.md`. Prior art: `.github/roadmap/0.10.0/plans/issue-315-azure-container-apps.md`.
Primary Azure references are cited inline in those research docs (Microsoft Learn: ACA
ingress/connect-apps/storage-mounts/manage-secrets/managed-identity-image-pull/scale;
Azure Files SMB permissions; Key Vault limits).
