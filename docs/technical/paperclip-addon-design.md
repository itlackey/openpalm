# Paperclip Addon Implementation Plan

**Status:** Proposed; no Paperclip code or runtime contract is implemented.
**Date:** 2026-08-04
**OpenPalm baseline reviewed:** `01161ded`
**Paperclip baseline reviewed:** [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) at `2ab797d`
**Strategy context:** [`../reviews/paperclip-integration-analysis.md`](../reviews/paperclip-integration-analysis.md)

This plan integrates Paperclip as a first-party service addon without rebuilding
its company, budget, approval, or heartbeat control plane inside OpenPalm. The
first supported route uses an OpenPalm-authored Paperclip adapter to drive the
existing assistant through Guardian's native `/oc/*` proxy.

The implementation follows four constraints:

1. Every delivered phase works end to end. Future routes are rejected until
   their implementation and tests land.
2. The smallest safe deployment lands first: screened Guardian routing,
   authenticated Paperclip, and loopback-only publication.
3. Portable lifecycle logic lives in `@openpalm/lib`; CLI and UI do not duplicate
   orchestration.
4. Security and filesystem invariants change atomically with enforcing code,
   never as forward declarations.

---

## 1. Decisions and non-goals

### Decisions

- Paperclip is a service addon, not a portal. It consumes an assistant and owns
  a separate web UI; it does not translate an external chat protocol.
- The initial route is `guardian`: Paperclip's adapter drives
  `http://guardian:8080/oc` with one addon-level principal.
- Guardian remains deployed whenever Paperclip is enabled. This avoids making
  profiles, expected services, health waits, and restart scopes depend on route
  state.
- Paperclip always runs `authenticated/private`, including host-only operation.
- Postgres is private to Paperclip on a dedicated internal network.
- The adapter is baked into an OpenPalm-owned derived Paperclip image. Nothing
  installs at boot.
- Paperclip telemetry is disabled explicitly. A global telemetry preference is
  separate work.

### Non-goals

- Reimplementing Paperclip's organization, work graph, budgets, approvals,
  users, or heartbeat scheduler.
- Adding multi-user accounts or RBAC to OpenPalm.
- Using Guardian's current OpenAI-compatible API as Paperclip's model provider.
  That endpoint forwards only the latest user text, omits system/history/tool
  fidelity, does not pass the requested model into OpenCode, and reports zero or
  unavailable usage. It is an assistant-response shim, not a sufficient model
  transport for Paperclip's tool-using `opencode_local` agent.
- Per-agent Guardian principals in the MVP. One `paperclip` principal represents
  the installation; dynamic per-agent attribution is deferred.
- Code-worktree execution through the OpenPalm assistant in the MVP. Paperclip's
  local coding adapters remain the right runtime for those roles.
- LAN, Tailscale, or Funnel exposure in Phase 1.

---

## 2. Verified upstream constraints

- The built-in `opencode_local` adapter spawns an OpenCode CLI process. Its
  remote support runs that process on another execution target; it does not
  drive an existing OpenCode HTTP server.
- The built-in `http` adapter is a one-shot webhook shape and does not provide
  agent text, usage, or session continuity.
- External adapters live in Paperclip's persistent plugin store and are installed
  through an instance-admin operation. Publishing or copying an npm package does
  not register it.
- The published image listens on `0.0.0.0:3100` and defaults to authenticated,
  private deployment. OpenPalm still sets these values explicitly.
- `local_trusted` cannot be combined with a LAN bind. Binding container loopback
  would also make Docker publication unreachable, so it is not the host-only
  solution.
- `GET /api/health` checks Postgres and returns `503` when the database is
  unavailable. A TCP-only probe is insufficient.
- Paperclip uses SemVer-compatible calendar versions. Registry tags must be
  checked; every upstream base is pinned by immutable digest.
- The adapter API and Paperclip's baked OpenCode version can move independently
  of the Paperclip source commit. Both are conformance inputs.

---

## 3. Delivery phases

### Phase 0: compatibility and adapter fixture

No product surface lands until CI proves the exact upstream digest, Postgres
digest, derived image, and adapter together:

- `linux/amd64` and `linux/arm64` image manifests exist.
- Paperclip and Postgres run under the chosen rootless strategy with
  host-bind-mounted data that remains operator-readable and writable.
- Postgres initializes, restarts, upgrades, dumps, and restores.
- `/api/health` succeeds with Postgres and returns `503` after database loss.
- The derived image loads the baked adapter package through Paperclip's supported
  plugin loader and verifies its exact version.
- The adapter authenticates to Guardian, creates/resumes an OpenCode session,
  sends a wake prompt, consumes SSE, and handles cancellation.
- The adapter keeps Paperclip's run token local, executes an allowlisted
  Paperclip control-plane action loop, and never sends that credential to the
  assistant.
- One real Paperclip heartbeat mutates its assigned issue through that loop and
  completes through Guardian with session continuation and an audit record.
- Three agents run concurrently with stable agent identities, exact session
  event filtering, no cross-delivery, and no event-stream limit collision.
- Moderation blocks, ownership conflicts, rate limits, malformed SSE, and
  upstream disconnects become explicit failed runs.
- Telemetry opt-out variables remain effective.

If official Postgres cannot satisfy the host-accessibility contract, Phase 1 is
blocked. The plan does not weaken the filesystem contract or silently accept a
root-owned bind.

### Phase 1: screened, loopback-only addon

Phase 1 ships the complete Guardian route, not configuration for later work.

1. The dedicated enable operation starts Paperclip, Postgres, and Guardian on
   loopback/private networks and reports `setup_required`.
2. The operator claims the first Paperclip administrator over loopback.
3. Through Paperclip's own authenticated adapter UI/API, the operator installs
   the baked local adapter directory. OpenPalm never captures the browser session.
4. `openpalm paperclip verify` runs a container-local verifier against the
   persistent plugin store, imports the registered package through the supported
   loader, checks adapter type/version, and runs `testEnvironment()` against
   Guardian. It then reports the addon `ready`.

The verifier does not need the Paperclip browser credential and emits no secret.
CI additionally proves a real authenticated heartbeat with a test instance
administrator. If upstream later exposes a separately authenticated non-browser
admin contract, automated registration may replace the manual step only after
that contract is pinned and tested.

Generic addon UI/API mutation cannot enable Paperclip partially. The CLI routes
`openpalm addon enable paperclip` to the dedicated transaction.

### Phase 2: optional direct-assistant route

Direct routing is an explicit later option, never a default migration:

- A conditional managed overlay grants only the Paperclip service
  `assistant_net` and the OpenCode password secret.
- The adapter targets `http://assistant:4096` and uses a tested explicit auth
  flag; unrelated assistant publication changes cannot break it.
- Guardian remains deployed while the addon is enabled, even if this route does
  not dial it.
- The assistant never receives Paperclip service data. If a role needs shared
  files, both services mount `${OP_HOME}/workspace` at `/work`, and adapter paths
  must remain beneath `/work`.
- The operator-trusted in-stack-consumer exception is added to
  `core-principles.md` in the same commit as this overlay and its isolation tests.

Existing Guardian-routed installs stay Guardian-routed after every update.

### Phase 3: dedicated UI and LAN access

The host UI gains Paperclip status, adapter setup, route, and exposure controls.
LAN exposure remains unavailable until an instance administrator exists and
public sign-up is disabled.

The fail-closed apply sequence is:

1. Verify admin state and sign-up lockout over loopback.
2. Derive `OP_PAPERCLIP_BIND_ADDRESS`, the canonical URL, and full trusted
   origins from the effective host and `OP_PAPERCLIP_PORT`.
3. Validate Compose, write intent, and recreate Paperclip.
4. Verify login with a non-loopback Host/Origin.
5. Restore loopback publication and prior origins on any failure.

The base Compose publication uses the derived bind variable; there is no second
ad hoc ports list. Before Phase 3, validation permits only `127.0.0.1`.

### Phase 4: Tailscale exposure

Tailscale Serve is a new orchestration protocol, not just an enum value. One
shared-lib operation starts the tunnel, waits with a timeout for its FQDN,
derives exact trusted origins, writes the Serve target, recreates Paperclip,
verifies login, and restores the previous target/configuration on failure.

The existing `both` target retains assistant+guardian semantics. A new target or
`all` value never widens stored exposure implicitly. Funnel remains out of scope
until admin provisioning and account recovery require no first-browser claim.

---

## 4. Phase 1 runtime contract

### Images

The release builds `openpalm/paperclip` from a Dockerfile under
`containers/paperclip/`:

- `FROM` uses the reviewed upstream Paperclip digest.
- The candidate-local adapter is built into a materialized package directory
  with every production dependency present, then copied to an immutable image
  path. Paperclip registers that directory through its supported local-path
  install flow; no dependency resolution occurs at boot or registration time.
- A container-local verifier is baked alongside it.
- No package is installed at entrypoint or container boot.

`OP_PAPERCLIP_IMAGE` is a full immutable derived-image reference.
`OP_PAPERCLIP_DB_IMAGE` is the reviewed Postgres reference. Both are seeded
before Compose validation. They are independent addon pins, never inferred from
`PLATFORM_VERSION` and never advanced by an ordinary platform update.

The release workflow builds and smoke-tests the derived image. Updating either
pin is an explicit Paperclip operation guarded by section 8.

### Services and networks

The base service uses `paperclip_net` for Postgres and `addon_net` for ordinary
egress. The Guardian route overlay adds `portal_net`; the direct overlay later
adds `assistant_net`. Postgres joins only `paperclip_net`.

```yaml
networks:
  paperclip_net:
    internal: true

services:
  paperclip:
    image: ${OP_PAPERCLIP_IMAGE:?OP_PAPERCLIP_IMAGE is required}
    profiles: ["addon.paperclip"]
    networks: [paperclip_net, addon_net]
    ports:
      - "${OP_PAPERCLIP_BIND_ADDRESS:-127.0.0.1}:${OP_PAPERCLIP_PORT:-3840}:3100"
    volumes:
      - ${OP_HOME}/data/paperclip:/paperclip
    env_file:
      - ${OP_HOME}/private/env/paperclip.env
    depends_on:
      paperclip-db:
        condition: service_healthy
    environment:
      HOST: 0.0.0.0
      PORT: "3100"
      PAPERCLIP_HOME: /paperclip
      SERVE_UI: "true"
      PAPERCLIP_DEPLOYMENT_MODE: authenticated
      PAPERCLIP_DEPLOYMENT_EXPOSURE: private
      PAPERCLIP_PUBLIC_URL: http://127.0.0.1:${OP_PAPERCLIP_PORT:-3840}
      BETTER_AUTH_TRUSTED_ORIGINS: http://127.0.0.1:${OP_PAPERCLIP_PORT:-3840},http://localhost:${OP_PAPERCLIP_PORT:-3840}
      PAPERCLIP_TELEMETRY_DISABLED: "1"
      DO_NOT_TRACK: "1"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3100/api/health"]
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

  paperclip-db:
    image: ${OP_PAPERCLIP_DB_IMAGE:?OP_PAPERCLIP_DB_IMAGE is required}
    profiles: ["addon.paperclip"]
    networks: [paperclip_net]
    volumes:
      - ${OP_HOME}/data/paperclip-db:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: paperclip
      POSTGRES_DB: paperclip
      POSTGRES_PASSWORD_FILE: /run/secrets/paperclip_db_password
    secrets: [paperclip_db_password]
```

The final block includes the Phase 0-proven user/ownership strategy, Postgres
health check, restart policy, and repository logging caps. The DB has no host
publication and receives no Better Auth, signing, or Guardian credential.

### Managed route overlays

Phase 1 writes `OP_PAPERCLIP_ROUTING=guardian` explicitly. An enabled addon
never relies on an absent route default.

`paperclip.compose.guardian.yml` restates the complete Paperclip network set as
`[paperclip_net, addon_net, portal_net]`, grants
`portal_paperclip_secret`, and passes its path and Guardian URL to the adapter.
Phase 2's direct overlay instead restates
`[paperclip_net, addon_net, assistant_net]` and grants only the OpenCode password
plus explicit auth configuration.

The canonical `discoverStackOverlays()` builder includes exactly one route
overlay on every Compose invocation. No UI or CLI call appends one independently.
Invalid/unavailable routes fail before file or container mutation.

### Guardian deployment

Keep `GUARDIAN_INGRESS_ADDON_IDS` for portal semantics. Add one canonical
`GUARDIAN_REQUIRED_ADDON_IDS` containing those IDs plus `paperclip`, with a pure
`hasGuardianRequiredAddon()` helper in import-free `addon-ids.ts`. Guardian adds
`addon.paperclip` to its profiles. Deploy sets, expected services, health waits,
and restart decisions all use the required-addon helper.

There is no route-dependent `addon.gateway` injection and no stack-env read in
the Guardian helper.

---

## 5. Adapter and principal contract

The adapter package implements:

- `createServerAdapter()` registration and a stable adapter type.
- `supportsLocalAgentJwt: true`; execution fails closed before creating an
  OpenCode session when `ctx.authToken` is absent.
- `execute()` over native OpenCode HTTP/SSE with cancellation.
- Session create/resume and a versioned session codec.
- Prompt/event translation into Paperclip logs and runtime progress.
- Usage/model/cost fields without fabricating unavailable values.
- `testEnvironment()` with authenticated Guardian/direct probes.
- Model/config schema and explicit terminal status mapping.
- Failures for moderation blocks, ownership conflicts, rate limits, malformed
  SSE, and disconnects.

### Paperclip action loop

Paperclip supplies the adapter a run-scoped `authToken` for its own control-plane
API. That value remains inside the adapter process. The remote assistant never
receives it and needs no network path to Paperclip.

For each run, the adapter:

1. Builds a structured action schema from a pinned allowlist of Paperclip
   control-plane operations.
2. Sends heartbeat context and that schema to the OpenCode session through
   Guardian.
3. Parses the assistant's structured action request. Invalid or unlisted actions
   fail closed.
4. Calls the pinned local Paperclip API with the run token. The base URL comes
   from trusted adapter configuration, never model output.
5. Sends the sanitized tool result back to the same OpenCode session.
6. Repeats within bounded steps/time, then returns the final Paperclip result.

Cancellation aborts both the OpenCode request and any in-flight Paperclip API
call. The adapter never accepts an arbitrary API URL from model output, never
logs the token, and never includes it in prompts/events. Phase 0 pins the exact
operations, request schemas, authorization behavior, and responses; a Paperclip
pin bump fails conformance on drift.

`runtimeMcp` is separate: it contains optional external `mcp_remote` connections,
each with its own endpoint token. Phase 1 does not conflate those tokens with the
Paperclip run token or proxy those external tools. Supporting them later requires
an independent allowlist and must use each `server.token` only with its matching
server.

### Identity and event isolation

Every Guardian request carries the addon principal plus a validated, stable
`x-openpalm-user` derived from the Paperclip agent ID. The encoding is bounded
and collision-tested. Session ownership is therefore per Paperclip agent while
credential lifecycle remains per installation.

Guardian event streams can contain multiple sessions for one effective user, so
the adapter forwards only events matching the run's exact OpenCode session ID.
It opens at most one stream per active agent, closes it on every terminal path,
and tests at least three concurrent agents to prove stream limits and event
demultiplexing do not mix runs.

The canonical principal file is
`private/secrets/portal_paperclip_secret`. The Guardian route overlay grants it
to exactly Guardian and Paperclip. Guardian receives the matching principal seed
variable; Paperclip receives only the adapter file path. Secret audit rules allow
this exact service/secret pair.

Rotation stages one value, recreates Guardian and Paperclip together, probes the
new principal, and restores the old value on failure. Disabling Paperclip removes
the grants and revokes the persisted principal through Guardian's admin API;
re-enable explicitly reactivates or remints it.

Per-agent principals remain deferred until one shared lifecycle API can mint,
rotate, revoke, and reconcile dynamic agents safely.

---

## 6. Paperclip secrets and configuration

### Files

- `private/secrets/paperclip_db_password`: canonical database password, `0600`.
- `private/secrets/portal_paperclip_secret`: Guardian adapter principal, `0600`.
- `private/env/paperclip.env`: Paperclip-only upstream values, `0600`.
- `private/paperclip-generation.json`: credential-generation hashes, `0600`.

The env file contains only the password-bearing `DATABASE_URL`,
`BETTER_AUTH_SECRET`, and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET`. It is never
mounted into the assistant. Postgres receives only the canonical DB password via
`POSTGRES_PASSWORD_FILE`.

Paperclip cannot consume all required upstream values through `*_FILE`, so Phase
1 adds a narrow secret-audit exception atomically with the service:

- Raw Compose: only service `paperclip`, only the exact
  `${OP_HOME}/private/env/paperclip.env` path, and only one entry.
- Resolved Compose: only `DATABASE_URL`, `BETTER_AUTH_SECRET`, and
  `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` are allowed as raw secret-like keys for
  Paperclip.
- `paperclip-db` is not env-file-exempt.
- Activation tests audit the real resolved Compose project, not just source YAML.

### Seeding and consistency

One shared-lib operation owns these files. It creates missing Paperclip-issued
secrets with the repository CSPRNG, writes the whole env file atomically, enforces
`0600`, and never regenerates an existing secret during ordinary apply.

DB credentials are valid only when the canonical file and `DATABASE_URL`
password are both absent, or both exist and match. A one-sided/mismatched restore
fails without writing and prints a recovery command.
`private/paperclip-generation.json` stores hashes of both representations. Every
Paperclip start/apply verifies those hashes and, for an initialized DB, a real DB
login. A fresh DB is verified by post-start health and integration probes.

Phase 1 exposes no generic editor for coupled values. Future rotation must define
and test:

- DB password: `ALTER ROLE` with the old credential, verify the new credential,
  then atomically update both representations and recreate services.
- Better Auth secret: session invalidation.
- Tool signing secret: outstanding signature/action invalidation.

---

## 7. Addon lifecycle

Phase 1 adds `paperclip` to built-in addon IDs but not portal-secret IDs. Because
built-in IDs are currently exposed automatically, it also:

- filters Paperclip from generic addon API/UI discovery,
- rejects generic enable/disable API mutations,
- dispatches `openpalm addon enable paperclip` to the dedicated transaction
  before mutating `OP_ENABLED_ADDONS`, and
- dispatches `openpalm addon disable paperclip` and every shared-lib disable
  mutation to the dedicated cleanup operation, and
- tests that no generic path can persist a partial enable.

The shared-lib `enablePaperclip`/`applyPaperclip` operation seeds pins and
credentials, validates the effective Compose project, persists the enabled ID,
starts Paperclip/DB/Guardian, waits on application health, and reports
`setup_required` or `ready`. CLI and the future dedicated UI call this operation.

Disable removes containers, grants, and the active Guardian principal but
preserves `data/paperclip`, `data/paperclip-db`, and all Paperclip private files.
The cleanup is verified while another Guardian addon remains running, and the
old Paperclip credential must fail authentication afterward. Re-enable reuses
preserved state with an explicitly reactivated or reminted principal. Ordinary
uninstall also preserves it. An addon-only
purge requires path-specific confirmation; the existing explicitly requested
global `openpalm uninstall --purge` retains its documented all-`OP_HOME` scope.

---

## 8. Update, rollback, backup, and recovery

Container health cannot make a Postgres migration reversible, and Postgres is
not Paperclip's only durable state. `data/paperclip` contains adapter registration
plus local-disk attachments/work products.

The dedicated backup operation creates one coordinated recovery set:

1. Quiesce the Paperclip service while leaving Postgres available.
2. Create and verify `pg_dump`.
3. Archive `data/paperclip` without following links outside that tree.
4. Copy the matching Paperclip private files and generation record.
5. Write a checksummed manifest containing image pins and DB generation.
6. Restart Paperclip and verify health.

Restore is staged and failure-safe:

1. Create and verify a coordinated recovery set for the currently running
   generation.
2. Restore target private files and `data/paperclip` into staging paths.
3. Start an isolated temporary Postgres using the target image, target DB secret,
   and a fresh staging data directory; apply the logical dump and verify it.
4. Stop production Paperclip/Postgres and swap staged paths using a rollback
   journal. No old path is removed until verification succeeds.
5. Start the target generation and verify DB state, one attachment/work product,
   adapter registration, and health.
6. On any failure, stop the target, reverse every recorded swap, restore prior
   pins/private files, and restart/verify the pre-restore generation.

A partial or checksum-mismatched set is rejected before staging. Failed updates
restore this entire coordinated set, not only the logical dump.

- Ordinary platform updates do not advance either Paperclip pin.
- Before an explicit pin change, create and verify the coordinated recovery set;
  record old/new images and its manifest path.
- A failed update restores old images and app configuration. If migration ran,
  restore the verified dump before restart.
- Until automated DB restore passes integration tests, pin changes remain manual
  documented operations and cannot be initiated by the generic Updates UI.
- General safety backups still exclude service `data/`; Paperclip's dedicated
  backup exists because its DB, plugin store, files, and private config must move
  as one generation.
- Every app-owned Paperclip file mutated by apply is included in rollback or held
  in operation-local staging and restored before failure returns.

Restart, disable/re-enable, pin update, failed migration, mismatched credentials,
attachment/plugin backup, and coordinated restore are required stack tests.

---

## 9. Documentation changes that land atomically

Phase 1 updates:

- `core-principles.md`: Guardian can be required by a first-party service addon,
  the exact `private/env` exception, derived-image behavior, and Paperclip ports.
- `environment-and-mounts.md`: all Paperclip env, mounts, secrets, networks, and
  ports.
- `system-requirements.md`: measured CPU, memory, and disk overhead.
- operator docs: enable, claim, adapter install/verify, disable, backup, restore,
  update, and recovery.

Phase 2 changes the Guardian-only invariant only if direct routing ships. Phase
3/4 document exposure only when those paths are executable.

---

## 10. Acceptance criteria

### Phase 1

- Required pins and `OP_PAPERCLIP_ROUTING=guardian` exist before Compose
  validation.
- Generic API/UI/CLI mutation cannot partially enable Paperclip.
- Postgres joins only `paperclip_net`; base Paperclip has no `assistant_net` or
  `portal_net`; the Guardian overlay adds only `portal_net`.
- Paperclip is loopback-only for every configurable host port and always
  authenticated/private.
- Canonical URL and trusted origins use the effective `OP_PAPERCLIP_PORT`.
- `/api/health` gates activation and detects DB loss.
- Resolved secret audit permits only the documented Paperclip values/grants.
- DB credential copies both exist and match, or both are absent.
- Adapter installation is explicit post-claim; container-local verification
  needs no browser credential.
- One heartbeat mutates a real Paperclip issue through the adapter-owned API loop
  and is audited; three agents run concurrently without event cross-delivery.
- Missing `ctx.authToken` fails before any OpenCode session or Paperclip API
  mutation.
- Principal rotation/revocation and failed-rotation rollback pass.
- Restart and disable/re-enable preserve company, account, agent, and plugin
  state.
- Failed enable/apply leaves the previous stack runnable and retains generated
  credentials for retry.
- `bun run test`, `bun run lint`, and `bun run check` pass.

### Phase 2

- Existing Guardian-routed installs remain Guardian-routed after upgrade.
- Direct routing has `assistant_net` only through its managed overlay.
- It receives only the OpenCode password, not the Guardian principal secret.
- Shared-workspace paths cannot escape `/work`.
- Direct auth works with both assistant publication states.

### Phase 3

- Exposure cannot widen before admin bootstrap and sign-up lockout.
- Effective bind, public URL, and origins derive from one stored intent.
- Login succeeds from the target network before apply reports success.
- Failure restores loopback publication and prior origins.

### Phase 4

- FQDN discovery has a timeout and generates full trusted origins.
- Serve targets the internal Paperclip endpoint and is verified.
- Existing `both` values retain assistant+guardian semantics.
- Failure restores prior tunnel target and Paperclip configuration.

---

## 11. Deferred work

- Per-agent Guardian principals and usage attribution.
- Per-principal moderation policy; Phase 1 stays fully screened.
- Global stack telemetry preference.
- Public Funnel exposure.
- Automatic code-worktree execution through the OpenPalm assistant.
- Bidirectional MCP integration; it needs explicit network, listener, token, and
  isolation design rather than configuration-only claims.
- Remote Paperclip/OpenPalm topologies requiring operator-managed TLS.

---

## 12. Pin-bump conformance checklist

Every Paperclip update verifies:

1. Immutable upstream and derived digests plus both Linux architectures.
2. Entrypoint, runtime user, exposed port, and host data ownership.
3. Paperclip adapter API and baked OpenCode version.
4. Adapter installation, supported-loader import, type/version, session codec,
   execution, cancellation, reinstall, and rollback.
5. Guardian authentication, real tool-using heartbeat, moderation failure, and
   audit output.
6. Authenticated bind rules, first-admin bootstrap, and sign-up lockout.
7. Full trusted origins for every supported external URL/port.
8. Telemetry opt-out behavior.
9. Empty-DB init, existing-DB migration, restart, coordinated DB/files/private
   backup and restore, attachment/plugin recovery, credential mismatch, and
   `/api/health` after DB loss.

No unchecked item becomes a documentation-only warning for a release pin.
