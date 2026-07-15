# Client, Assistant, and Host Separation Plan

**Date:** 2026-07-14
**Status:** Implementation plan
**Scope:** `packages/client`, `packages/ui`, CLI/Electron launch routing, and the Guardian/OpenCode boundary
**Authority:** Subordinate to `docs/technical/core-principles.md` and `docs/technical/code-quality-principles.md`.

## 1. Decisions

| Boundary | Owns | State authority | UI owner |
|---|---|---|---|
| App | Chat, Advanced mode, browser-local assistant connections, device preferences | Browser storage and the selected connection's chat/session API | `packages/client` |
| Assistant | Persona, models/providers, provider credentials, and AKM behavior for this installation | User-owned files and auth state under current `OP_HOME` | `packages/ui` |
| Host | Docker, addons, networking, pairing, service secrets, updates, recovery, and diagnostics | Host process, Docker, and current `OP_HOME` | `packages/ui` |

The implementation decisions are:

1. `packages/client` becomes the only app surface, but host app implementations are not deleted until Guardian conversation/history, voice, launch, and recovery parity gates pass.
2. Every assistant/provider/catalog/OAuth/import operation in the host process targets the local managed assistant. Selected endpoints remain a chat-only concern until the legacy host chat is deleted.
3. One shared resolver returns the local assistant URL and optional Basic auth. It must support the home-network preset, where `OPENCODE_AUTH=true`, and resolve the same username and password semantics used by both the assistant and Guardian.
4. `/assistant` is one local configuration page. `/host` remains the host dashboard. A large new route tree is not required.
5. Guardian `/oc` remains chat ingress. It does not become an assistant-configuration or host-control plane.
6. Existing provider APIs are not all renamed. Keep the production paths, delete verified duplicate/dead paths and branches, and avoid compatibility aliases.
7. AKM literal API keys must be migrated out of `config/akm/config.json` through one lib-owned, operator-authorized, crash-recoverable mutation path before Assistant separation is considered complete.
8. CLI, Electron, and landing consumers migrate to the client artifact before host app implementations are removed. Host chat deletion requires a released contract-v2 Electron harness that starts the client server and a published `@openpalm/ui` with `minHarnessContract: 2`; the existing compatibility gate must keep frozen v1 harnesses on their last compatible host-chat UI. The redirect-only host `/chat` route remains for contract-v2 consumers that still read only `{ landing: '/chat' }`.
9. `config/endpoints.json` cannot be retired while `core-principles.md` defines it as an active filesystem contract. That retirement requires separate architectural approval and a principles update first.

This plan does not add a remote-config service, generic capability negotiation, a generic file editor, a new voice data plane, or a third UI artifact.

## 2. Verified Findings

### 2.1 Current routes

| Artifact | Current routes | Finding |
|---|---|---|
| `packages/client` | `/`, `/chat`, `/advanced`, `/connections`, `/connections/new` | Intended canonical app, but not yet at full host-chat parity |
| `packages/ui` | `/`, `/chat`, `/advanced`, `/connections`, `/connections/new`, `/host`, `/setup`, `/attention`, `/login` | Host console still includes the duplicate app and mixed assistant settings |

### 2.2 Local/remote split-target bug

The model route demonstrates the current bug:

1. `GET /api/assistant/model` calls `getOpenCodeClient().getConfig()`.
2. `getOpenCodeClient()` binds to `getActiveEndpoint()` from `config/endpoints.json`.
3. GET can therefore display a selected remote endpoint's model.
4. POST calls `setMainModel()` or `unsetMainModel()`, which writes local `${OP_HOME}/config/assistant/opencode.json`.
5. `patchConfig()` then best-effort PATCHes `/config` through `opencodeFetch()`.
6. `opencodeFetch()` also follows `getActiveEndpoint()`, so the local change can be applied to the selected remote endpoint. Failure is swallowed.
7. If the local file cannot be read, `getCurrentConfig()` can fetch remote `/config` and then persist that state locally.

The same selected-endpoint dependency is used beyond the model route. It reaches provider catalogs, provider auth, OAuth, setup, and both host-credential import paths. Fixing only `/api/assistant/model` is insufficient.

Required invariant:

> A local assistant operation reads, persists, authenticates to, and live-applies against one explicitly resolved local installation. Selecting a chat connection cannot change any of those targets.

### 2.3 Deletion blockers

| Finding | Consequence |
|---|---|
| Client history calls `GET /session/{id}/message`; Guardian does not allowlist that route | Guardian history parity is incomplete; host chat cannot be deleted |
| Electron defaults to host chat unless client chat is explicitly opted in | Electron launch migration must happen before host route deletion |
| Frozen Electron harness v1 consumes `{ landing: '/chat' }` but does not start a client server | It cannot use a host-to-client redirect; before host chat deletion, publish `@openpalm/ui` with `minHarnessContract: 2` so the existing update gate rejects v1 and leaves its compatible host chat installed |
| Contract-v2 Electron starts the client server, but a frozen v2 consumer may still read only `{ landing: '/chat' }` | Landing fields remain additive and host `/chat` redirects to client `/chat` for v2 compatibility |
| `VoiceTab.svelte` calls `speakText()`, which uses `/api/speak` | `/api/speak` remains while VoiceTab uses it, even after chat movement |
| Client lacks the host listening/TTS behavior and Electron mic integration | Voice parity or approved feature retirement is a deletion gate |
| AKM PATCH writes literal `apiKey`, setup and host-sharing import can preserve/import it, and these paths write the same config independently | Every app-controlled AKM writer/import must use one lib-owned normalizer and transaction; secret migration is a security gate for Assistant separation |
| `core-principles.md` defines `config/endpoints.json` as the admin connection list | Its active contract cannot be retired by this plan alone |

## 3. Target Route Inventory

### 3.1 Client

| Route | Purpose | Connection constraints |
|---|---|---|
| `/` | First-run or active-connection landing | No host authority |
| `/chat` | Canonical chat/session UI | Existing direct OpenCode and Guardian transports |
| `/advanced` | Raw OpenCode web UI | Credential-free direct OpenCode only |
| `/connections` | Browser-local assistant connection management | IndexedDB only |
| `/connections/new` | Add direct OpenCode or Guardian connection | Browser-local write only |

`/advanced` is explicitly part of the target client artifact:

| Connection | Auth | Result |
|---|---|---|
| `local-opencode` | `none` | Allowed after safe-URL validation and direct health success |
| `remote-opencode` | `none` | Allowed after safe-URL validation and direct health success |
| Either direct OpenCode kind | `basic` or `bearer` | Refused; iframe navigation cannot attach the stored secret safely |
| `openpalm-client-api` | Any | Refused; Guardian `/oc` is an API allowlist, not a raw UI proxy |
| No active connection | N/A | Redirect to `/connections/new` |

The URL must be HTTP(S), without URL userinfo or a query string. Client-issued probes and session lookups use `credentials: 'omit'`. No stored connection secret is placed in an iframe URL, query string, cookie workaround, or navigation workaround.

### 3.2 Host UI

| Route | Purpose |
|---|---|
| `/assistant` | Local persona, Models & Providers, and AKM configuration for current `OP_HOME` |
| `/host` | Docker, network, access/pairing, addons, voice service configuration, secrets, updates, recovery, and diagnostics |
| `/chat` | Compatibility-only redirect to sibling client `/chat`; no host chat UI, state, or transport |
| `/setup`, `/attention`, `/login` | Existing setup, blocking recovery, and authentication flows |

There is no final host chat implementation and no host `/advanced` or `/connections`. The redirect-only `/chat` exception is retained for contract-v2 harnesses that start the client server but still consume the legacy `landing` field. Contract-v1 harnesses must never receive this host UI build because `minHarnessContract: 2` rejects it. Do not create more Assistant/Host subroutes until independent navigation needs justify them.

## 4. Security and Storage Boundaries

### 4.1 Guardian

Guardian `/oc` remains authenticated, owner-scoped, rate-limited chat ingress. History parity requires `GET /session/{id}/message`, but adding that route alone is insufficient: client conversation keys, durable target/ownership state, restart reclaim, and cross-principal denial are all deletion gates. Do not add config, provider, auth, AKM, file, or host passthrough.

Describe the current validation pipeline precisely:

1. Guardian authenticates a principal, enforces listener `expectedKind`, rate limits, bounds the body, and applies method/path allowlisting before session ownership and forwarding. Portal route parameters use the hardened allowlist; direct ingress additionally permits `GET /doc` and its explicitly matched chat routes. This is route/path validation, not general JSON body-schema validation.
2. For `POST /session/{id}/message` and `POST /session/{id}/prompt_async`, Guardian extracts `parts[].text` and optional `system` from the pinned OpenCode shape and screens only that text. It does not structurally validate the complete prompt body. Malformed JSON or a nonconforming shape currently extracts no text and is forwarded for OpenCode to reject; do not claim a Guardian `validatePayload` gate that the `/oc` proxy does not have.
3. Read, delete, abort, permission, and question routes are not content-screened. Responses are not content-screened. A `flag` verdict is logged and forwarded unchanged.
4. A `block` verdict is a hard `403` for a `portal` principal, with no assistant call. For a `direct` principal, Guardian drops untrusted prose, preserves only the allowlisted routing fields, substitutes a refusal prompt, and forwards that rewritten body. The original blocked content does not reach the assistant in either case.
5. A direct principal remains a chat principal, not a host or Assistant administrator. Its extra `GET /doc` access and rewrite-on-block policy do not grant config, provider, AKM, file, Docker, or admin routes. Portal credentials cannot authenticate on the direct listener, and direct credentials cannot authenticate on the portal listener.
6. Ownership identity is `(principal kind, principal id, user id)`. `x-openpalm-user`, when present, supplies that user id and is trusted from the already-authenticated portal; it separates declared users in ownership records but is not an independently authenticated boundary against a holder of that portal token. Cross-principal tests therefore use different principal credentials, with separate same-principal/different-declared-user routing tests.

There is also a current default mismatch to resolve in Slice 0: `contentValidationEnabled()` currently treats an absent or empty `GUARDIAN_CONTENT_VALIDATION` as enabled, while core principles require the package fallback to be off. Shipped `portals.compose.yml` supplies `${GUARDIAN_CONTENT_VALIDATION:-1}`, so shipped installations remain on after the package fallback is corrected. When enabled, content at or above the risk threshold escalates to the moderator and moderator failure/no valid verdict produces `block`, followed by the principal-kind behavior above.

Explicitly denied through Guardian:

- `/config`, `/config/providers`, `/provider`, `/provider/auth`, and `/auth/*`
- OAuth operations
- Persona, AKM, extensions, and arbitrary files
- `/api/assistant/*` and `/api/host/*`
- Docker, secrets, networking, pairing, updates, and diagnostics

### 4.2 Provider credentials

`OP_HOME/knowledge/secrets/auth.json` is the installation-shared OpenCode provider credential store. The assistant mounts it read-write; Guardian mounts the same file read-only so its moderation OpenCode runtime can use the installation's configured provider. Provider auth changes can therefore affect both assistant inference and Guardian moderation availability.

This shared provider file is distinct from Guardian edge credentials. Guardian admin tokens, direct/portal principal secrets, and the OpenAI-compatible edge API key authenticate ingress or management of Guardian principals; they are host/access credentials, not LLM provider credentials, and remain under Host.

### 4.3 `config/endpoints.json`

The current core principles explicitly define `config/endpoints.json` as the admin UI connection list. Removing its active readers/writers changes the filesystem contract. Before that removal:

1. Obtain explicit architecture approval.
2. Update `docs/technical/core-principles.md` in a separate approved change.
3. State the replacement and migration behavior.
4. Preserve the existing user-owned file on disk; lifecycle operations never delete it automatically.

Until those steps complete, host connection persistence may be deprecated but not retired.

## 5. Ordered Implementation

### Slice 0: Reconcile the Guardian package default

Core principles are authoritative: the Guardian package fallback is off when `GUARDIAN_CONTENT_VALIDATION` is fully unset, while shipped Compose supplies `1` by default. Reconcile implementation and tests before the separation slices proceed:

1. Make the package-level environment resolver return disabled when the variable is absent or empty.
2. Keep explicit truthy values enabled and explicit falsy values disabled.
3. Keep `portals.compose.yml` at `${GUARDIAN_CONTENT_VALIDATION:-1}` so shipped installations remain on by default unless the operator opts out.
4. Pin package-unit and shipped-Compose tests separately; do not infer one layer's default from the other.

Slice 0 gate:

- Package test with a fully unset variable returns disabled.
- Package tests cover explicit enabled and disabled values.
- Compose test proves an omitted operator value resolves to `1`.
- Shipped-stack integration proves validation is enabled by default and explicit opt-out disables it.

### Slice 1: Isolate every local assistant call path

Add one resolver in `@openpalm/lib` that returns the local managed OpenCode connection:

```ts
type LocalAssistantConnection = {
  baseUrl: string;
  auth: { mode: 'none' } | { mode: 'basic'; username: string; password: string };
};
```

Resolver requirements:

1. Do not use `resolveAssistantEndpoint()` as-is; its client-facing precedence includes full-URL overrides that may intentionally point at a remote assistant.
2. Derive the local URL only from current `OP_HOME` stack settings: `OP_ASSISTANT_BIND_ADDRESS` and `OP_ASSISTANT_PORT`, with process values overriding the persisted stack env for those same keys.
3. Build `http://<host>:<port>`. Use `127.0.0.1` for an unset, loopback, or wildcard bind (`0.0.0.0`, `::`, or `[::]`); preserve a concrete configured LAN address because Docker may publish only on that interface.
4. Explicitly ignore `OP_CLIENT_DEFAULT_ASSISTANT_URL`, `OP_OPENCODE_URL`, `OP_ASSISTANT_URL`, client runtime config, `config/endpoints.json`, active connection state, and request-supplied URLs.
5. Resolve auth only from current `OP_HOME` stack settings: parse `OPENCODE_AUTH` with the same truthy rules as the home-network preset, resolve `OPENCODE_SERVER_USERNAME` with process-over-persisted precedence and default `opencode`, and read `${OP_HOME}/knowledge/secrets/op_opencode_password`.
6. When auth is off, return no auth and do not read or attach a stale secret. Do not accept a raw password environment variable as a substitute for the file secret.
7. Fail closed when auth is enabled but the password is missing or empty. Never retry unauthenticated.
8. Strip only trailing LF characters from the secret, equivalent to `raw.replace(/\n+$/, '')`. Preserve leading/trailing spaces, tabs, and carriage returns; use trimming only to reject a whitespace-only result. This must stay identical to the assistant entrypoint and Guardian upstream resolver.
9. Plumb `OPENCODE_SERVER_USERNAME` into both managed assistant and Guardian Compose environments with the same `opencode` default. Validate it as a non-empty Basic-auth username without `:`, CR, or LF. The host resolver, assistant OpenCode server, Guardian upstream auth, health checks, and tests must all use that one value.
10. Never log, serialize, cache in browser state, or return the password from an API.

This is required for the home-password network preset: wildcard LAN bind resolves to loopback for the host process, while Basic auth still uses the preset's shared `opencode_server_password` value.

Durable OpenCode config is fail-closed. If `${OP_HOME}/config/assistant/opencode.json` exists, check it with `lstat` before reading and require a regular file; symlinks, directories, FIFOs, sockets, and devices are invalid. If it is non-regular, unreadable, or malformed JSON, every read or mutation depending on it must stop before network I/O or filesystem mutation. Do not fall back to live `/config`, replace it with an empty object, or rewrite, rename, normalize, or back it up as a side effect of the failed request. The original path and bytes must remain unchanged. A live response may supplement a successfully parsed durable config, but it must never repair or hydrate an invalid durable file implicitly.

Replace selected-endpoint transport in every local operation:

| Call path | Current selected-endpoint use to remove |
|---|---|
| `/api/assistant/model` and OpenCode config helpers | GET config, fallback GET, and live PATCH |
| Provider page/catalog loaders | `/provider`, `/provider/auth`, `/config`, `/config/providers` |
| Provider API-key write/delete and model lookup | `getOpenCodeClient()` proxy calls |
| Provider OAuth start, callback/poll, and finish | `opencodeFetch()` or `getOpenCodeClient()` |
| Custom provider registration with API key | `getOpenCodeClient().setProviderApiKey()` |
| Setup recommend/status/provider/auth/OAuth paths | All `getOpenCodeClient()` and `opencodeFetch()` calls |
| `POST /api/setup/import-host` | Best-effort credential push after local file import |
| `POST /api/host/providers/import-host` | Best-effort credential push after local file import |

Host credential import is explicitly local: copy and merge into current `OP_HOME`, push the resulting installation `auth.json` only to the resolved local assistant, and restart only local provider consumers. A selected remote endpoint must receive zero imported credentials.

Slice 1 gate:

- A repository check finds no `getActiveEndpoint()` dependency in assistant, setup, provider, catalog, OAuth, or import call paths.
- The legacy active endpoint is used only by host chat/proxy code awaiting deletion.
- Tests cover auth off, home-password Basic auth, missing-secret failure, custom username consistency across host/assistant/Guardian, trailing-LF-only password stripping, wildcard bind, concrete LAN bind, process overrides of local bind/port/auth keys, and explicit rejection of all full-URL/client-facing overrides.
- With a selected remote mock, every listed call path sends zero requests and no credentials to it.
- Model GET, local persistence, and live apply all resolve the same local installation.
- Malformed, unreadable, and non-regular durable config each cause a fail-closed error, perform zero local/remote OpenCode requests and zero writes, and leave the original path/bytes unchanged.
- Provider catalog, model, OAuth, registration, and import tests cannot trigger fallback fetch/write when durable config validation or reading fails.

### Slice 2: Separate Assistant and close secret/provider debt

Move existing UI behavior without inventing new features:

| Current | Action |
|---|---|
| Persona half of `AssistantTab.svelte` | Move to `/assistant` |
| Project name and LAN half of `AssistantTab.svelte` | Keep under `/host` |
| `ProvidersPanel.svelte` | Render under `/assistant` as Models & Providers |
| Assistant AKM config sections | Move to `/assistant` |
| AKM health/reindex/host sharing | Keep under `/host` |
| Guardian edge credentials and host credential import | Keep under `/host` |

Do not move every provider API to a new namespace. Keep current production callers on one implementation and delete verified duplicates/dead code:

| Current provider surface | Disposition |
|---|---|
| `GET /api/host/providers` | Keep; local-target it |
| `/api/host/providers/oauth/*` | Keep as the production OAuth flow; local-target it |
| `POST/DELETE /api/host/opencode/providers/[id]/auth` | Keep API-key write and disconnect; local-target them |
| `GET /api/host/opencode/providers/[id]/auth` and its OAuth polling state | Delete after confirming no production caller; duplicates the used OAuth flow |
| OAuth mode in `POST /api/host/opencode/providers/[id]/auth` | Delete after confirming no production caller |
| `GET /api/host/opencode/providers/[id]/models` | Delete; current audit finds no production caller |
| `PATCH /api/host/providers/[id]` | Keep only mutation kinds with production callers |
| Dead `options`, `toggle`, `register-local`, or `set-model` branches | Delete when the caller audit is encoded as a test; do not carry dormant APIs into Assistant |
| Host import/status and assistant-CLI routes | Keep as host operations; local-target any OpenCode calls |

Do not add replacement aliases for deleted routes.

Pairing moves in Slice 2, before any host connection module is eligible for deletion:

1. Move `POST /api/connections/pairing` to `POST /api/host/access/pairing`.
2. Move the pairing UI from host connection management to the Host access/network section.
3. Update all callers and host-authority tests in the same change.
4. Delete the old pairing route without a compatibility alias.
5. Leave the remaining connection CRUD/store modules in place until the Slice 4 contract and deletion gates pass.

AKM secret migration is part of this slice and is a release gate. Implement one mutation boundary in `@openpalm/lib`; route handlers may validate transport input and build a requested patch, but they must not write `config/akm/config.json` or `knowledge/env/user.env` directly.

The lib-owned boundary must cover every app-controlled AKM config writer/import:

- Assistant AKM PATCH and its GET/read projection
- setup `persistAkmConfig()`
- `addHostStashToOpenpalmConfig()`
- `importHostProfiles()` and `enableHostAkmSharing()`
- future config writers through one exported API, enforced by a repository test that rejects direct production writes to `config/akm/config.json`
- direct `env:user` write/delete APIs for lock coordination; deleting a key still referenced by AKM config is refused unless the reference is removed in the same transaction

Normalization rules:

1. Treat non-empty literal `profiles.llm.*.apiKey` and `embedding.apiKey` values as secrets. Preserve valid `${ENV_NAME}` references and unknown config keys; omit empty `apiKey` fields rather than persisting empty literals.
2. Derive deterministic names such as `AKM_LLM_<NORMALIZED_PROFILE>_API_KEY` and `AKM_EMBEDDING_API_KEY`. Detect normalized-name collisions and existing `user.env` entries with a different value; never silently overwrite either.
3. A newly submitted API key in authenticated Assistant PATCH is explicit operator input: write it to `env:user` and put only `${ENV_NAME}` in config. GET and UI state expose only reference/configured/migration-required status, never the literal or resolved value.
4. A legacy literal already on disk is not migrated merely because install, update, startup, setup rerun, source upsert, or another unrelated config write occurs. Without explicit authorization, the shared boundary returns `akm_secret_migration_required` before any write.
5. Provide an explicit authenticated `POST /api/assistant/akm/migrate-secrets` with `{ confirm: true }` and a headless `openpalm akm migrate-secrets --confirm` entry point; both call the same lib function. Return affected field paths and generated env names, never values.
6. Setup and host-sharing imports also pass through this boundary. If a host profile would import a literal key, do not import or persist it silently: require a distinct migration confirmation in that operator action, or leave the source unchanged and report migration required. Host sharing must scan, normalize, stage, and validate the candidate before changing `OP_HOST_AKM_STASH`, so a rejected import does not partially enable sharing. Automatic setup/lifecycle work never uses that confirmation.
7. Manual edits remain user-authorized by the filesystem contract, but the next app-controlled mutation must detect a reintroduced literal and refuse or explicitly migrate it; no app writer can persist a literal.

Transaction and recovery rules:

1. Acquire one AKM config lock under `data/akm/` for all config and `env:user` writers, including setup and host sharing. If an outer install/deploy lock is also needed, acquire it first and the AKM lock second everywhere.
2. Under the lock, require existing config and env paths to be regular readable files, capture their hashes/modes or absence, build both complete candidate files in memory, and stage each beside its destination for same-filesystem rename.
3. Re-read and validate both staged files before touching live state: JSON/schema validation, `.env` parse, reference resolution, deterministic collision checks, and an assertion that no non-empty literal `apiKey` remains.
4. Create a `0700` transaction backup directory under `data/backups/akm/`; copy each existing original as a `0600` file and record absent originals plus hashes in a `0600` manifest. A backup may contain secrets and must never be logged or returned.
5. Write and fsync a `0600` crash journal under `data/akm/` containing transaction id, before/after hashes, backup/stage paths, and phase. Commit `user.env` first, then config, updating/fsyncing the journal and destination directories after each atomic rename. Remove stages and the journal only after both after-hashes are live.
6. On the next explicit AKM mutation or migration command, recover a journal before new work. If each live file matches either its recorded before- or after-hash and valid stages remain, roll forward to both after-hashes. If roll-forward is impossible but backups validate and live files have not diverged, roll back both originals, including restoring absence. If any live hash is unrecognized, fail closed and require an explicit operator choice; never overwrite a manual edit.
7. Install, update, startup apply, and automatic setup reruns neither start this migration nor recover it by overwriting `user.env`; they report the pending journal/migration and leave the file byte-identical. Journal recovery is continuation of an explicit operator-authorized AKM transaction.

Slice 2 gate:

- `/assistant` always identifies itself as Local assistant and has no chat connection selector.
- Selected remote connections cannot affect persona, model, provider, OAuth, import, or AKM operations.
- No literal AKM API key remains in `config/akm/config.json` after successful migration.
- Every app-controlled writer/import rejects or normalizes a literal; setup and host sharing cannot reintroduce one.
- Validation failure before commit leaves both originals intact. Injected crashes after either rename deterministically roll forward or roll back from the journal and `0600` backups without exposing values.
- Concurrent AKM PATCH, user-env edit, setup, and host-sharing operations serialize on the same lock.
- Install/update/startup/setup rerun does not change existing `knowledge/env/user.env` bytes or implicitly authorize migration.
- Provider `auth.json` is documented and tested as installation-shared with Guardian, not as a Guardian edge credential.
- Pairing works only through `/api/host/access/pairing`, requires host admin authority, and has no caller under `/api/connections`.

### Slice 3: Close parity and migrate launchers

Complete these before deleting any host app route.

Guardian conversation and history parity:

1. Allowlist `GET /session/{id}/message` as a chat-read route and apply the same ownership gate as every other session-scoped route.
2. On each Guardian conversation create, the client sends a stable, opaque `x-openpalm-session-key`. Reusing one key for the same authenticated principal/user returns the same live session; choosing New conversation generates a new key and must return a distinct session even for the same user.
3. Move the authoritative session target and ownership records out of module-scoped maps into the Guardian state DB. Persist at least `(principal kind, principal id, user id, session key) -> session id` and `session id -> full principal identity` atomically before returning create success. In-memory maps may remain bounded caches only.
4. On Guardian restart, reclaim only the exact session id in the durable target record after confirming its durable owner matches. If the upstream session is gone, retire the stale mapping and create/persist a fresh owned session. Never claim an unowned same-title session or rebind a session whose durable owner differs.
5. A successful session delete removes target and ownership rows in the same durable operation. Unknown, missing, conflicting, or partially migrated ownership fails closed.
6. Prove one principal/user can create two keys and get two independent histories, reload either history, restart Guardian, reclaim both exact sessions, and reload both histories again.
7. Prove a different authenticated principal cannot list, fetch metadata/history, message, abort, or delete the first principal's session before or after Guardian restart, even when it submits the same `x-openpalm-session-key`. Separately prove a different declared `x-openpalm-user` under one portal credential is routed to different ownership records, without describing that trusted header as an independent authentication boundary.
8. Prove client reload and session switching preserve the conversation key/session mapping through Guardian without collapsing New conversation into the prior session.

Voice gate:

1. Inventory host chat listening, STT, TTS, auto-speak, streaming speech, stop/cancel, error, and Electron mic behavior.
2. Implement equivalent supported behavior in the client, or obtain an explicit product approval documenting which behavior is retired.
3. Keep `/api/speak` while `VoiceTab.svelte` reaches it through `speakText()`.
4. Keep `/api/transcribe` while any listening or Voice UI caller remains.
5. Keep `/api/host/voice` for engine/addon configuration regardless of chat movement.

Launch migration:

1. Keep the existing `GET /api/runtime/landing` field `{ landing: string }`; do not replace or repurpose it incompatibly.
2. Add artifact information alongside it: `{ landing: string, target: 'client' | 'host', path: string }`. Legacy-shape consumers continue reading `landing`; updated launchers use `target` and `path`. Only contract v2 may receive the host-chat-deleting UI.
3. Healthy chat and connection landings target the client. Setup, attention, offline, broken, diagnostics, and host management target the host.
4. Keep `openpalm app` opening the client; remove fallback to host `/chat`. If the client is unavailable, open a host diagnostic/recovery landing.
5. Keep `openpalm admin` opening the host console.
6. Change Electron healthy launch to client `/chat` by default after parity gates pass. Remove the client-chat opt-in and host-chat implementation fallback. Non-chat recovery landings continue to open the host origin.
7. Treat starting/supervising the separate client server as the contract-v2 native capability. Verify a released v2 harness does so before the host chat implementation is eligible for deletion.
8. In the same release that removes host chat, set published `@openpalm/ui` `minHarnessContract` to `2`. The existing self-update/fresh-seed gate must reject this UI on harness v1, which keeps running its last compatible UI with host chat and receives a re-download prompt.
9. Do not bump `HARNESS_CONTRACT_VERSION` to 3 or set `minHarnessContract` to 3 for additive landing fields or redirect semantics. They rely on the already-existing v2 ability to start the client artifact, not a new native surface.
10. Replace the host `/chat` implementation with a minimal redirect to sibling client `/chat`. It must contain no host chat state, transport, component, or active-endpoint dependency.
11. Retain that redirect for frozen contract-v2 Electron consumers that start the client server but still read only `{ landing }`. Contract-v1 is protected by `minHarnessContract: 2`, not by the redirect.
12. Update host root/hooks and all updated landing consumers to use the artifact fields. New launchers go directly to the client; frozen v2 `{ landing }` consumers reach the same client through the compatibility redirect.
13. Pin behavior with new and old landing-response consumers, CLI, Electron, host landing, setup, attention, offline, broken-stack, missing-client, manifest-gate, and redirect tests.

Slice 3 gate:

- Guardian distinct-conversation, history reload, durable ownership/reclaim, restart, and cross-principal denial tests pass.
- Voice parity tests pass, or an explicit approved retirement record exists and retired callers are removed.
- Updated launchers use `target`/`path`; frozen v2 harnesses can still consume `landing` and follow host `/chat` to the client.
- Harness v1 refuses the host-chat-deleting UI because it declares `minHarnessContract: 2`; harness v2 accepts it. No contract-v3 bump is present.
- Missing client builds land on a functioning host recovery surface, not a soon-to-be-removed route.
- The additive landing response is accepted by the frozen v2 consumer shape, and updated Electron launch logic uses `target`/`path`.
- Host `/chat` redirects to client `/chat` without importing or executing host chat code.

### Slice 4: Delete the duplicate host app

Entry gates:

- Slices 0-3 are complete.
- The Slice 2 pairing move is complete and the old pairing route is gone.
- A contract-v2 harness that starts the client server is released, and the host-chat-deleting `@openpalm/ui` declares `minHarnessContract: 2`; v1 rejection and v2 acceptance are tested.
- The additive landing response and redirect-only host `/chat` compatibility route are shipped and tested for frozen v2 consumers. No invalid contract-v3/min-v3 bump is used.
- The `config/endpoints.json` contract change has explicit approval and `core-principles.md` has been updated in a separate change.
- Client direct OpenCode and Guardian chat suites pass, including distinct conversations, history reload, restart/reclaim, cross-principal denial, and approved voice behavior.

Delete or replace as specified:

- Delete the host chat page implementation under `packages/ui/src/routes/chat/`; retain only the minimal compatibility redirect
- `packages/ui/src/routes/advanced/`
- `packages/ui/src/routes/connections/`
- Host-only code under `packages/ui/src/lib/chat/`
- Host-only chat components under `packages/ui/src/lib/components/chat/`
- `packages/ui/src/routes/proxy/assistant/`
- Connection CRUD/active routes under `packages/ui/src/routes/api/connections/` after pairing moves and the contract gate passes
- `packages/ui/src/lib/endpoints-state.svelte.ts`
- `packages/ui/src/lib/server/endpoints.ts` after no setup, assistant, provider, import, or launch caller remains
- Host-only endpoint API wrappers and activation events

Do not delete `/api/speak` while VoiceTab uses it. Delete `/api/speak` or `/api/transcribe` only after the last verified caller moves or the feature is explicitly retired. Keep `/api/host/voice`.

Preserve the physical user-owned `config/endpoints.json` file after contract retirement. Do not export its credentials to client runtime config or delete it during install/update.

Slice 4 gate:

- Host `/chat` redirects to client `/chat`; host `/advanced`, `/connections`, and `/proxy/assistant/*` return 404.
- Only `packages/client` contains user-facing chat, Advanced mode, and assistant connection selection.
- CLI/Electron/client launches remain usable with healthy, offline, broken, setup, and attention states.
- No active server path imports `getActiveEndpoint()` or the legacy endpoint store.

### Slice 5: Remove proven leftovers

1. Delete client `ConnectionEntry.grantedCapabilities` and fixtures; no verified grant flow uses them.
2. Remove host capability branches that only impersonate the static client after CLI/Electron consumers migrate.
3. Do not remove runtime modes based on naming alone; retain any mode with a verified launch consumer.
4. Update route/API documentation in the same release as each deletion.

## 6. Required Acceptance Tests

### Target isolation

- Every assistant/provider/catalog/OAuth/import route is unaffected by selected endpoint changes.
- Home-password preset requests include Basic auth with username default `opencode` and the file secret.
- Auth-off requests send no Authorization header even if the secret file exists.
- Missing required Basic secret fails closed without contacting any endpoint.
- Custom Basic username is identical in the host resolver, assistant, Guardian, and health probes; password handling strips trailing LF only and preserves other whitespace.
- Host credential import never sends imported credentials to a selected remote endpoint.
- Malformed, unreadable, symlinked, and other non-regular durable `opencode.json` cases fail before fetch/write and leave the original path/bytes unchanged after every affected operation.

### Client and Guardian

- `/advanced` allows only credential-free `local-opencode` and `remote-opencode` targets that pass URL and health checks.
- `/advanced` refuses credentialed direct targets and all `openpalm-client-api` targets.
- Guardian creates distinct sessions/histories for distinct `x-openpalm-session-key` values and idempotently reuses only the same key for the same full principal identity.
- Guardian permits owned `GET /session/{id}/message` history before and after reload/restart, reclaims the exact durable target, and denies all cross-principal and cross-user session access before and after restart.
- Guardian still denies config, provider, auth, OAuth, assistant API, and host API paths.
- Validation tests pin canonical route/body-size checks separately from body schema: malformed prompt JSON is left for OpenCode to reject, while prompt text extraction covers `parts[].text` and `system` only.
- Content-validation tests pin package fallback off after Slice 0, shipped Compose default on, explicit operator opt-out, threshold escalation, `flag` forwarding, fail-closed moderator failure, portal hard-block, direct refusal rewrite, and no screening of read/response traffic.

### Secrets

- Every app-controlled AKM config writer/import uses the lib-owned normalizer and shared lock; none can persist a literal API key.
- AKM literal-key migration is explicitly authorized, staged/validated, backup-first, idempotent, collision-checked, journaled, crash-recoverable, and log-redacted.
- Transaction tests inject failure before commit and crashes after each rename; recovery proves both-file roll-forward and rollback, `0600` backup/journal modes, divergent-file fail-closed behavior, and no automatic lifecycle overwrite of `user.env`.
- No assistant/provider API returns provider or AKM credential values.
- Provider auth writes affect installation `auth.json`; Guardian edge credential files remain untouched.

### Launch and deletion

- Landing responses retain `landing` and add client-versus-host artifact fields.
- A frozen contract-v2 `{ landing }` consumer remains compatible by following host `/chat` to client `/chat` because v2 starts the client server.
- The host-chat-deleting UI declares `minHarnessContract: 2`; harness v1 rejects it and retains host chat, while harness v2 accepts it.
- Additive landing/redirect semantics do not cause an invalid `HARNESS_CONTRACT_VERSION` 3 or `minHarnessContract` 3 bump.
- `openpalm app` and healthy Electron launch open client `/chat`.
- `openpalm admin`, setup, attention, offline, broken, and diagnostics open host routes.
- No launch fallback depends on deleted host chat code; the compatibility route is redirect-only.
- Voice/listening/TTS parity or approved retirement is asserted before the host chat implementation is deleted.
- `/api/speak` remains covered while VoiceTab calls it.
- Existing `config/endpoints.json` is never automatically modified or deleted by retirement.

## 7. Completion Criteria

The separation is complete when:

- Client `/chat`, `/advanced`, and `/connections` are canonical and the host duplicates are gone.
- Guardian package fallback and shipped Compose defaults match the split required by core principles.
- All local assistant/provider/setup/import calls use the local URL+auth resolver.
- Malformed, unreadable, and non-regular durable OpenCode config fails closed without network activity or path/byte changes.
- Selected remote connections influence only chat data-plane operations.
- Guardian distinct-conversation, history, durable ownership/reclaim, restart, and cross-principal parity is complete while `/oc` remains chat-only ingress.
- `/assistant` changes only current `OP_HOME`; `/host` changes host/stack state.
- AKM API keys cross the approved secret boundary through the one lib-owned transaction, no app writer/import can reintroduce a literal, and lifecycle operations never overwrite existing `user.env` automatically.
- Provider `auth.json` and Guardian edge credentials are correctly separated in code, UI copy, and documentation.
- Launchers target the correct artifact; contract v1 is held on a compatible UI by `minHarnessContract: 2`, and frozen v2 reaches the client through the redirect-only host `/chat` compatibility route.
- `config/endpoints.json` retirement followed an approved core-principles update and preserved the user file.
- No speculative remote-config service, generic capability contract, or duplicate provider API family was introduced.

## 8. Documentation Follow-up

Update facts with their implementation slice:

- `docs/technical/ui-runtime-modes.md`
- `docs/technical/ui-route-map.md`
- `docs/technical/api-spec.md`
- `docs/technical/opencode-configuration.md`
- `docs/technical/environment-and-mounts.md`
- Operator connection, voice, and remote-access guidance

This documentation-only revision does not edit `docs/technical/core-principles.md`. Its required approval/update is an implementation gate, not an assumed decision.
