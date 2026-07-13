# Changelog

All notable changes to OpenPalm are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **PWA install paths: pairing UX, runtime handshake, install affordances,
  offline verification** (#511). Host admin `/connections` gains a "Pair a
  device" panel (`host:stack:write`-gated): it mints a one-time,
  individually-revocable guardian `direct` principal via the existing
  loopback-only admin listener and renders a QR code + copyable
  `openpalm-pair:` code, shown exactly once and never persisted or logged.
  The `@openpalm/client` `/connections` add form parses that code (a paste
  field, or a `?pair=` deep link stripped from history on consumption) to
  prefill itself — the credential then flows through the existing encrypted
  secret store. A new client-side `/api/runtime` contract-version handshake
  (`checkRuntimeContract`) probes `openpalm-client-api`-kind connections and
  renders a version-skew notice for a `newer`/`older` host, while treating a
  missing endpoint (plain OpenCode/guardian) as the normal legacy case, not
  an error. `ServerRuntimeContext` gains an additive `clientAppUrl` field;
  the host `/connections` page shows an "Install OpenPalm app" button once a
  browser-side reachability probe confirms the sibling static client is
  actually being served. `detectClientDisplayMode()` (electron /
  standalone-pwa / browser) is now stamped on `<html data-display-mode>` and
  drives a browser-only "install as an app" hint on the client's
  `/connections` page. A new Playwright suite
  (`packages/client/e2e/offline-shell.pw.ts`) targets the offline app shell
  and saved IndexedDB connections after a service-worker-controlled reload;
  its two tests are `test.fixme()`-guarded because Chromium's CDP-driven
  `context.setOffline(true)` does not dispatch page navigation to the
  Service Worker's `fetch` handler (reproduced against the same Chromium
  build CI's `client-browser-tests` job installs) — a browser-automation
  limitation, not a product gap. The offline plumbing itself stays covered
  by shipped green unit tests (`pwa-config.test.ts`, `boot.test.ts`,
  `connections-store.test.ts`). Hosted-origin CI deploy to `app.openpalm.dev` (and the matching
  guardian CORS default) remains explicitly deferred pending a hosting
  provider — everything else is origin-agnostic and unblocked by that.
  `docs/managing-openpalm.md` documents the pairing-UI flow as the primary
  remote-client provisioning path, with the manual `curl` mint kept as the
  advanced/headless alternative.
- **Network access presets: bundle binding + auth + mDNS into one wizard
  choice** (#563). A single "Network access" step in the setup wizard (and
  the equivalent `network` block in a headless `SetupSpec`) replaces
  independently-tuned bind vars with four presets — "This PC only" (default),
  "Home network, with password", "Home network, open access", and "Shared
  network, guardian protected" — resolved by a new pure `network-preset.ts`
  in `@openpalm/lib`. The home-password preset turns on OpenCode's own Basic
  auth (`OPENCODE_AUTH` + a password stored as the `op_opencode_password`
  file secret, always materialized but inert until a preset enables it); the
  guardian now attaches the same credential to every upstream assistant call
  (proxy, event-fanout, drift-check) so portal traffic keeps working once
  auth is on. Per-preset `.local` mDNS advertisement is delivered entirely by
  the existing host mDNS responder (#488) via the bind vars each preset
  writes — no new file-assembly step. `collectBindAddressWarnings` and the
  new `collectNetworkExposureWarnings` reword startup warnings to name the
  preset that deliberately configures an exposure, collapsing the noise for
  a matched preset while keeping unexplained exposure loud. The admin
  Assistant tab now shows the detected active preset (read-only; switching
  stays in the wizard via rerun) and the default OpenCode connection picks
  up the preset's password automatically when auth is on. Security defaults
  are unchanged — every knob stays off/loopback unless an operator picks a
  non-default preset.
- **Remote-only (client) install completion** (#486). `openpalm app` now
  tolerates a machine with no local stack: it serves the pwa-static host UI
  plus the localhost `@openpalm/client` connection manager and lands on
  `/connections/new` instead of throwing an install-required error (bare
  `openpalm ui serve` still requires an install). The `openpalm-client-api`
  (guardian `/oc`) connection kind is now wired end to end: both connection
  forms (client app and host UI) offer a Kind selector, guardian URLs are
  normalized to end in `/oc` on save, health checks probe the allowlisted
  `GET /session` route instead of the guardian's un-allowlisted root (so a
  healthy guardian no longer misreports `unreachable HTTP 404`), and a 404
  from a guardian-kind connection now names `GUARDIAN_DIRECT_INGRESS` in its
  remediation copy. `docs/managing-openpalm.md` documents the manual
  remote-client provisioning flow (enable `GUARDIAN_DIRECT_INGRESS`, add the
  client origin to `GUARDIAN_CORS_ALLOWED_ORIGINS`, mint a `direct` principal
  via the guardian admin listener). A new end-to-end suite
  (`packages/client/tests/remote-attach.e2e.test.ts`) drives a real spawned
  guardian with the real client transport to verify the full remote-attach
  path.
- **Standalone OpenCode-compatible portal packages** (#491). `@openpalm/discord-portal`
  and `@openpalm/slack-portal` are now runnable standalone with Bun
  (`bunx @openpalm/discord-portal` / `@openpalm/slack-portal`) against any
  OpenCode server, not only the shipped guardian-fronted stack: new `bin/`
  CLI entrypoints (`openpalm-discord-portal`, `openpalm-slack-portal`) with a
  crash safety net, a client-side session-reuse fallback
  (`PORTAL_SESSION_REUSE=client`, `PORTAL_SESSION_TTL_MS`) for plain OpenCode
  servers that ignore the guardian's session-reuse hint header, a direct-env
  secret fallback alongside the existing `*_FILE` discipline
  (`readRequiredSecret`: `PRINCIPAL_SECRET`/`OPENCODE_PASSWORD`,
  `DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`), a
  `SLACK_BOT_NAME` branding variable, and rewritten standalone READMEs
  carrying the mandated security framing (guardian-fronted vs. personal /
  small-trusted-team standalone use).
- **Remote-access TLS guide and client-side HTTPS enforcement** (#557).
  `docs/remote-access-tls.md` documents fronting the guardian direct listener
  with real HTTPS for phones/remote clients: Tailscale `serve` as the
  recommended default (automatic Let's Encrypt, no port forwarding), Caddy +
  a user-owned domain (DNS-challenge Let's Encrypt) as the alternative, and
  an explicit non-goal of ever installing a private CA on a phone. The
  OpenPalm client now refuses a plain-HTTP connection URL for a non-loopback
  host whenever it itself runs on an `https:` origin (the mixed-content
  platform rule) — the add/edit connection form rejects the entry with a
  message deep-linking the guide, and connection health reports a `needs
  HTTPS` badge instead of a misleading "unreachable" for an existing
  connection that becomes insecure. Loopback targets, the loopback-origin
  desktop default, and the LAN-served plain-HTTP client tier are unaffected.
- **Host control-plane LAN mDNS self-advertisement for the guardian and
  assistant** (#488). A hand-rolled `node:dgram` responder in `@openpalm/lib`
  runs inside the long-lived host UI process (started from
  `hooks.server.ts`; every supervisor — `openpalm ui serve`, `openpalm`,
  Electron — spawns it) and advertises `<name>-guardian.local` /
  `<name>.local` (`<name>` derived from `OP_PROJECT_NAME`, default
  `openpalm`) whenever the corresponding bind address
  (`OP_BIND_ADDRESS` / `OP_ASSISTANT_BIND_ADDRESS`) is set non-loopback. The
  loopback-only default opens no socket at all. A new `OP_MDNS=0|false|off`
  knob in `stack.env` force-disables the responder (e.g. to avoid conflicting
  with an operator's existing avahi/Bonjour setup). The admin UI's LAN
  Exposure card (Assistant tab) now shows the derived `.local` name(s) and
  whether each is currently advertised. This replaces the guardian container
  as the advertisement locus documented in the original issue — container
  mDNS on the default Docker bridge network never reaches the physical LAN
  (see `docs/technical/network-partitioning-d5a.md`); the guardian
  container/image is unchanged by this work. OpenCode's native in-container
  mDNS responder (`server.mdns`/`server.mdnsDomain` in the assistant/guardian
  `opencode.jsonc`) remains as a manual/advanced fallback.
- **Opt-in mTLS adapter transport identity on the guardian direct listener**
  (port 3830 only — internal 8080 and admin 3831 stay plain HTTP; #435). Set
  `GUARDIAN_TLS_CERT_FILE` / `GUARDIAN_TLS_KEY_FILE` / `GUARDIAN_MTLS_CA_FILE`
  (all three together or none — any partial combination is a fail-closed boot
  error) to require every direct-listener connection to present a client
  certificate signed by the operator's adapter CA. Default off; existing
  behavior is byte-for-byte unchanged when unset. The Principal still comes
  from HTTP Basic auth exactly as before — this is a machine/transport
  identity for adapters, not an identity provider. A pre-spec spike found
  Bun's `Bun.serve({ tls })` and the `node:https` shim both accept a client
  certificate signed by *any* CA on the current runtime, so the guardian
  instead terminates via a verified `Bun.listen` TCP passthrough that checks
  the handshake's `authorizationError`, and CI pins the wrong-CA-rejection
  case. See `docs/technical/guardian-direct-mtls.md` for the design note,
  spike evidence, operator provisioning (openssl one-liners), and rotation
  procedure.
- **New `@openpalm/client` npm package** — the unprivileged chat/connections
  static app extracted from the admin UI (host/client split, #555). It joins the
  platform release exactly like `@openpalm/ui`: published by `platform`/`all`
  releases, always exact-pinned to the platform version. The assistant container
  installs it at startup as a co-process next to OpenCode (#510), pinned via
  **`OP_CLIENT_VERSION`** in `stack.env` (empty = the image's `PLATFORM_VERSION`;
  never `latest` — the same contract as `OP_UI_VERSION` for the host UI), and
  serves it on **`OP_CLIENT_PORT`** (default host bind `127.0.0.1:3810`, behind
  the existing `OP_CLIENT_BIND_ADDRESS`/`OP_BIND_ADDRESS` loopback policy).
  `docker restart` with a new `OP_CLIENT_VERSION` picks up the new client. CI now
  enforces a client-bundle purity gate: the built artifact must contain no
  `@openpalm/lib` and no host control-plane (`/api/host`) code. The shared
  `@openpalm/ui-kit` workspace package is inlined at build time and is never
  published.
- The guardian thin-host entrypoint can now install and boot a configurable
  guardian composition package via `OP_GUARDIAN_PACKAGE` (default
  `@openpalm/guardian`) with an overridable boot entry `OP_GUARDIAN_ENTRY`
  (default `src/server.ts`). The OpenAI-compatible API server is resolved from
  the public core `@openpalm/guardian`, and defaults are byte-for-byte unchanged.
  - The entrypoint can optionally install the guardian package from a **private,
    authenticated npm registry**. Supply an `.npmrc` (registry + auth) via
    `OP_GUARDIAN_NPMRC_FILE` (a mounted secret file — e.g. a Key Vault secret
    volume; preferred) or `OP_GUARDIAN_NPMRC` (inline content). It is written to
    `$HOME/.npmrc` (mode 600) so Bun applies it to every install; the token is
    never logged. Purely opt-in — when neither is set, nothing is written and the
    default public-registry behavior is byte-for-byte unchanged.

- **`@openpalm/guardian` is now importable as a library** (in addition to being
  a runnable thin host). It exposes composition seams so downstream
  distributions can extend the guardian without forking `server.ts`:
  - `createGuardian()` / `startGuardian()` — the composition root. Importing the
    package no longer binds any listener; `server.ts` only boots when run as the
    entrypoint (`import.meta.main`), so `bun run src/server.ts` is unchanged.
  - `registerTransport()` — register an additive route on the direct listener
    (alongside the built-in `/oc` and `/mcp`), gated by an optional env var.
  - `setAuthStrategy()` / `AuthStrategy` — replace the built-in HTTP Basic /
    principal-token authenticator (e.g. with SSO/OIDC). The default
    `basicTokenAuthStrategy` is unchanged.
  - `setPolicyProvider()` / `PolicyProvider` — a port for richer authorization
    (per-tenant data scope, RBAC, routing). The public default allows all;
    ownership and rate limits still apply.
  - The package now declares `exports`, `main`/`types`, a `bin`
    (`openpalm-guardian`), and a `files` allowlist that excludes test files.
- The audit writer is created lazily on first write, so importing the guardian
  library has no filesystem side effects.
- Guardian admin API: `DELETE /admin/principals/:id` removes a principal row
  outright (Bearer-authed like the rest of `/admin`; 404 for unknown ids; the
  auth cache is invalidated immediately). Principals seeded from
  `PORTAL_*_SECRET_FILE` env are re-seeded at the next guardian boot — use the
  addon/secret lifecycle to retire those. (#433)

### Changed

- **`@openpalm/portal-sdk` removes the unused public `BasePortal.guardianUrl`
  field** (#491). Base URL resolution is now `OcClient`'s job alone
  (`OPENCODE_BASE_URL`, default `http://guardian:8080/oc`) — the field's only
  consumers were the two in-repo portal test suites (updated in this change);
  the guardian's own `GuardianOpenAiApi` has a separate local field and no
  portal-sdk dependency. Breaking change for any out-of-tree consumer reading
  `guardianUrl` directly; the package is pre-1.0 beta.
- **Docs:** the hosted client origin (`https://app.openpalm.dev`) is
  deliberately **not** pre-baked into the guardian's default CORS allowlist —
  it stays an operator opt-in via `GUARDIAN_CORS_ALLOWED_ORIGINS` until #511's
  hosted deploy actually exists. (#557, trails #511)
- **Portal `/health` now reports `service: portal-<name>`** (was
  `channel-<name>`) — update any external monitoring scripted against the old
  string. (#490)
- **Version tags are now bare semver everywhere — the `v` prefix is retired.**
  Docker images publish as `openpalm/<svc>:X.Y.Z` (was `:vX.Y.Z`), the git
  summary tag is `X.Y.Z` (was `vX.Y.Z`), and `OP_*_VERSION` / `.skeleton-version`
  are written bare. Every read path still tolerates a legacy leading `v`
  (`normalizeVersion`, the Docker Hub resolver, the CLI self-update redirect,
  `groupReleasesByUnit`), so images and releases published before the cutover
  keep working. An explicit `--version` pin (CLI install / self-update) is honored
  **verbatim** — bare stays bare, and a legacy `vX.Y.Z` is preserved (not stripped)
  so a pre-cutover `v`-tagged image/release stays pinnable. The platform's own
  default tag is `PLATFORM_VERSION`, always bare. Removed the now-unused
  `formatForDocker` helper.
- The `@openpalm/guardian` `AuthStrategy` seam is now async-capable: a strategy's
  `authenticate()` may return a `Promise` (enabling JWKS/OIDC bearer-token
  strategies that verify against a remote JWKS), and the exported `authenticate()`
  is now async. The built-in `basicTokenAuthStrategy` and its behavior are
  unchanged (it still resolves synchronously).
- The guardian state DB (`data/guardian/state.db`) now runs in SQLite WAL
  mode with `PRAGMA user_version` schema-migration bookkeeping. `-wal`/`-shm`
  sidecar files appear next to `state.db` inside `data/guardian/` and are kept
  guardian-private (mode 0600). (#433)

### Removed

- **The deprecated `channel_lan` Docker network** (renamed to `portal_net` in
  0.12.0, retained one release as an empty bridge) is gone from
  `core.compose.yml`. Custom `custom.compose.yml` overlays still attaching
  services to `channel_lan` must rename to `portal_net`; lifecycle operations
  now fail fast with an actionable message (before changing anything) when
  such a reference is detected, and warn when an overlay self-defines a
  deprecated `channel_lan` network. (#490)
- **The legacy `CHANNEL_NAME` compose marker is no longer recognized** for
  portal discovery — `PORTAL_NAME` is the only marker. (#490)
- Dead control-plane exports pruned from `@openpalm/lib`: `formatForDocker`
  (the `v`-prefix boundary, no longer needed), `ensureCoreCompose`, and
  `seedAssistantPersonaFiles` (zero production callers after the 0.12.34–0.12.40
  reconcile consolidation). Also deleted the unused client-side
  `packages/ui/src/lib/version-compare.ts` duplicate; the one server route that
  needed semver comparison now imports `compareComparableVersions` from the lib.

### Fixed

- **mDNS honors the QU (unicast-response) bit** (PR #564 retest P3-5): the
  responder now parses the RFC 6762 §5.4 unicast-response bit off each question's
  qclass and, when a querier on port 5353 sets it, answers by unicast to the
  querier instead of multicasting — but with a normally-shaped response (ID 0,
  no echoed question, cache-flush bit, full TTL), distinct from the legacy-
  unicast shaping still reserved for non-5353 source ports. Plain multicast
  queries are unchanged.

- **mDNS advertisement follows the effective config compose deploys** (PR #564
  retest P2-4): `reconcileMdnsResponder` (and the read-only `GET /api/host/stack`
  status echo) now resolve advertisement against fresh stack.env layered over
  the host process env — the same precedence `docker compose` uses (it runs with
  `env: { ...process.env, ...<parsed stack.env> }` plus `--env-file`). A
  process-env-only bind override that Compose honors (a leftover shell export
  absent from stack.env) is now reflected in what the responder advertises, and
  a fresh stack.env pin always wins over a stale promoted process-env copy, so
  the advertised status can no longer disagree with the running stack in either
  direction. `OP_MDNS=off` in the process env remains a hard responder-only kill
  switch on top.

- **Network-preset host-env validation covers every managed key** (PR #564
  retest P2-6): `validateNetworkPresetEnv` now fails closed on a host-process
  override that would widen exposure past the target preset for ANY managed key
  it pins — the client and voice binds (`OP_CLIENT_BIND_ADDRESS`,
  `OP_VOICE_BIND_ADDRESS`), not just the assistant/guardian binds — plus an
  `OPENCODE_AUTH=false` override that would strip the sign-in password off a
  LAN-exposed assistant under `home-password`. The check keys off the raw
  process value (never the `OP_BIND_ADDRESS` compose cascade, which the written
  stack.env row already pins) and only rejects exposure-widening overrides;
  restrictive fail-closed drift is still allowed through.

- **mDNS admin status reports `advertised:true` only when a real record is
  emitted** (PR #564 retest P2-5): `resolveMdnsStatus` now shares the exact
  decision path as `resolveMdnsAdvertisements`, so a service whose bind resolves
  to zero A records (an IPv6-literal or hostname bind, or a host with no
  non-loopback IPv4) reports `advertised:false` instead of a phantom `true`. The
  admin surface can no longer promise a `.local` name that the responder never
  answers.

- **`channel_lan` deprecation guard rejects a stale overlay before any writes on
  update too** (PR #564 retest P2-3): the guard now blocks install, update, and
  upgrade (only uninstall is exempt) before `applyHome` touches any managed,
  state, config, or secret file — so the operator gets the pre-write migration
  instruction instead of a late post-write Compose failure.

- **Host UI Basic auth sends the exact bytes OpenCode expects** (PR #564 retest
  P2-1): all host forwarders (default/probe endpoint, host health, host proxy,
  host OpenCode API client) now share one UTF-8-safe Basic-auth encoder instead
  of Latin-1 `btoa`, and the file-backed password is stripped of trailing
  newlines only (matching the assistant/guardian) instead of `.trim()`. A
  password with surrounding spaces or non-ASCII characters (accents, CJK,
  emoji) now authenticates identically everywhere.

- **Unchanged setup rerun no longer rotates the UI login password or corrupts
  portal credentials** (PR #564 retest P1-1, P1-2). The wizard no longer
  generates a UI login password on a rerun; `security.uiLoginPassword` is
  optional and omitted on an unchanged rerun, and the server preserves the
  existing secret (failing closed only when there is nothing to preserve). And
  secret-presence metadata from current-config is never assigned into string
  credential fields (which previously serialized as `[object Object]` and
  overwrote Discord/Slack secrets) — presence-only credentials stay empty and
  are preserved server-side.

- **Rootless smoke fixture hygiene** (PR #564 P3-3, P3-4): the `stack` and
  `portal-discord` smoke targets now use distinct default assistant ports
  (3896 / 3996) so they can run concurrently, and cleanup enables the addon
  profiles on `down` (plus a project-label force-remove backstop) so a
  successful run no longer leaks the guardian/discord containers.

- **Guardian mTLS server wiring** (PR #564 r3566888940, r3566889234): under
  mTLS the direct handler now recovers each request's real client IP from the
  passthrough (correlating the loopback peer port) instead of seeing every
  client as `127.0.0.1` — restoring per-IP pre-auth rate limiting and accurate
  audit source IPs; and the MCP `ask_assistant` self-dial now targets the
  plain-HTTP loopback port (not the TLS passthrough port), so MCP works when
  mTLS is enabled.

- **Guardian mTLS passthrough robustness** (PR #564 r3566890023, r3566890224,
  r3566890583, r3566890804): the raw-byte relay now caps each direction's
  userspace queue (dropping a connection past 8 MiB instead of growing the
  guardian heap unboundedly on a slow reader), flushes queued bytes before
  ending a peer on close (no truncated response body), tears down an upstream
  that finished connecting after its client already disconnected (no orphaned
  loopback socket), and reaps a connection that never completes its TLS
  handshake (slowloris fd exhaustion).

- **Re-running setup over a home-password install no longer rotates the
  password** (PR #564 r3566887969): re-selecting the already-active
  home-password preset on a rerun (empty box because the secret is never
  returned) now keeps the existing OpenCode password instead of minting a new
  one, so already-paired devices are not silently 401'd. Typing a new password
  still rotates it as intended.

- **Guardian upstream auth matches OpenCode exactly** (PR #564 r3566888272,
  r3566889740): the guardian now strips only trailing newlines from the
  OpenCode password (matching the assistant entrypoint's `$(cat)` instead of
  `.trim()`, so a password with surrounding spaces no longer 401s every
  guardian→assistant call), and honors `OPENCODE_SERVER_USERNAME` (default
  `opencode`) instead of hardcoding the username.

- **Host-UI Basic auth to OpenCode is correct on every path** (PR #564
  r3566888629, r3566889513): all host-UI forwarders (default/runtime endpoint,
  probe, chat proxy, host health, opencode http client) now default the Basic
  username to OpenCode's server default `opencode` instead of `openpalm`, so a
  correct password no longer 401s a user-added remote-OpenCode connection; and
  the synthesized Local Assistant endpoint reads `OPENCODE_AUTH` and the
  password fresh from stack.env / the secret file, so completing the
  home-password wizard takes effect without restarting the host UI.

- **Pairing principal IDs are collision-resistant and oversized labels are
  rejected** (PR #564 r3566891355, r3566891768): the device-principal id suffix
  widened from 16 to 64 bits so a same-label collision can no longer silently
  overwrite (unpair) an existing device via the upsert store; and the pairing
  endpoint caps the device label (and no longer lets a QR-render failure escape
  after minting), so an oversized label can never orphan a durable guardian
  principal.

- **mDNS record correctness** (PR #564 r3566892051, r3566892362): a specific
  non-IPv4 bind (IPv6 literal or hostname) is no longer encoded into a
  malformed A record — such addresses are skipped. Legacy-unicast replies
  (RFC 6762 §6.7, queries from a non-5353 source port) now echo the question,
  clear the cache-flush bit, and use a short (≤10s) TTL so conventional
  one-shot resolvers accept them.

- **`channel_lan` deprecation guard no longer blocks uninstall/update**
  (PR #564 r3566892768): the guard now throws only on activation
  (install/upgrade), so a leftover `channel_lan` reference in a user
  `custom.compose.yml` can no longer prevent tearing down or updating the stack.
- **Bind-address warning no longer claims "guardian protected" without a
  guardian** (PR #564 r3566893095): a non-loopback `OP_BIND_ADDRESS` with no
  guardian-ingress addon enabled now warns that services are exposed
  UNPROTECTED, instead of falsely asserting guardian protection.

- **`this-pc` network preset now fails closed against host-env bind overrides**
  (PR #564 r3566887693): `validateNetworkPresetEnv` rejects a setup when the
  host process env exposes `OP_ASSISTANT_BIND_ADDRESS` or `OP_BIND_ADDRESS`
  under the "This PC only" preset, instead of silently writing a loopback row
  that Compose's process-env precedence would override — which could publish an
  unauthenticated OpenCode/guardian on the LAN despite the operator's choice.

- **Guardian mDNS no longer advertises an unreachable front door** (PR #564
  P2-1): the `<name>-guardian.local` advertisement is now gated on
  `GUARDIAN_DIRECT_INGRESS` being enabled, so a LAN-visible guardian bind with
  direct ingress off (e.g. the shared-guardian preset default) stops pointing
  the LAN at a `:3830` listener that returns 404.

- **`OPENCODE_BASE_URL` was ignored by the portal adapters** (#491).
  `BasePortal.createOcClient` hardcoded `baseUrl: 'http://guardian:8080/oc'`,
  so `OcClient`'s existing `OPENCODE_BASE_URL` env fallback was dead code
  even though the shipped compose overlay and both READMEs advertised it.
  The shipped compose sets `OPENCODE_BASE_URL` to exactly the old hardcoded
  value, so first-party installs see no behavior change; custom-compose users
  who set `DISCORD_OPENCODE_BASE_URL`/`SLACK_OPENCODE_BASE_URL` now get the
  documented behavior.
- **`packages/skeleton/tools.json` now installs the real `opencode-ai` npm
  package.** It referenced `opencode`, which does not exist on npm (404), so the
  tool install never produced the `opencode` binary. With
  `GUARDIAN_CONTENT_VALIDATION` enabled, the guardian entrypoint's
  `command -v opencode` check then hard-failed the boot. `opencode-ai`
  (the official OpenCode package) ships the `opencode` bin and resolves the same
  `^1.17.0` range. (#524)
- **Guardian thin-host container boots again.** The entrypoint installed the
  exact-pinned `@openpalm/guardian` / `@openpalm/skeleton` artifacts with
  `npm`, but the image is `FROM oven/bun:1.3-slim`, which ships no node/npm —
  the container exited 127 with `npm: command not found`. It now installs with
  `bun add ... --production` (the runtime it already uses), keeping the exact
  version pin and the `$prefix/node_modules/@openpalm/...` layout the final
  `bun run` depends on. (#518)
- **The assistant's `/health` probe and its password export are now
  consistent with `OPENCODE_AUTH`.** Under the home-password network preset
  (or any real install/update, since `ensureSecrets` always materializes a
  non-empty `opencode_server_password` secret file), the assistant enabled
  OpenCode Basic auth while its own healthcheck probed `/health`
  unauthenticated — the probe always 401'd, the assistant never reported
  healthy, and guardian's `depends_on: service_healthy` then blocked the
  whole stack from deploying. The assistant entrypoint now only resolves and
  exports `OPENCODE_SERVER_PASSWORD` when `OPENCODE_AUTH` is truthy (an
  explicit `OPENCODE_SERVER_PASSWORD` env value is still never unset when
  auth is off — no silent auth downgrade); the `core.compose.yml` and image
  `HEALTHCHECK` probes now send Basic credentials (read from the same
  mounted secret file) exactly when the container-side `OPENCODE_AUTH` is
  truthy, and stay a plain probe otherwise. `OPENCODE_AUTH` remains off by
  default — no behavior change for the default (loopback, no auth) posture.
  (PR #564 P1-1/P1-2)

## [0.12.10] - 2026-06-17

### Fixed

- **Guardian no longer creates root-owned files under OP_HOME.**
  The `guardian` and `guardian-api` services were missing the `user: "${OP_UID:-1000}:${OP_GID:-1000}"`
  directive that every other service in the stack already carries. Files written
  into `data/guardian` and `data/logs` were owned by root, causing backups (and
  other host-process operations) to fail with `EACCES`. The fix is a one-line
  compose change — the same pattern already used by assistant (via gosu), ollama,
  and voice.

## [0.12.9] - 2026-06-17

### Fixed

- **Upgrades no longer abort when Docker-owned data directories are unreadable.**
  The safety backup silently skips directories it cannot read (e.g. `data/guardian`,
  which is written as root by the Docker container) instead of throwing `EACCES` and
  refusing to proceed. User-owned config and knowledge are still fully backed up.

## [0.12.8] - 2026-06-17

### Fixed

- **Tool activity icons no longer render as pills.** The tool-use bubbles in
  chat now appear as bare emoji inline with the message — no background fill,
  no border, no fixed-size circles.
- **Send button uses standard styling.** The chat send button now inherits the
  global `btn-primary` shape, eliminating the visual misalignment with the rest
  of the app.
- **Settings drawer replaced with a 3-state theme toggle.** The theme button
  cycles system → light → dark and is visible across chat, advanced, and admin
  pages. The now-empty settings drawer has been removed.
- **Persona editor targets the correct file.** The assistant persona editor
  (Admin → Assistant) now reads and writes `config/assistant/persona.md`
  (previously pointed at the wrong filename).
- **Stale addon IDs purged on upgrade.** A new migration removes addon names
  from `OP_ENABLED_ADDONS` that are no longer part of the known addon set,
  preventing phantom entries after addon renames or removals.
- **Automations surface run errors in the UI.** When a manual automation run
  fails the error detail is now shown in the notification instead of a generic
  failure message. The success message no longer incorrectly says "in a few
  seconds" for synchronous runs.

## [0.12.2] - 2026-06-16

### Fixed

- **Advanced no longer throws "Session not found" when switching Chat↔Advanced.**
  The embedded OpenCode deep link hardcoded a workspace path, and OpenCode scopes
  its session list by directory — so a session that lived in a different directory
  (or on a different endpoint entirely) couldn't be found and the embedded app
  errored. Advanced now resolves the requested session against the **active**
  endpoint (via the same-origin proxy), deep-links using the session's **real
  directory**, and falls back to the endpoint's default view when the session
  doesn't exist there instead of rendering a broken frame.

## [0.12.1] - 2026-06-16

### Fixed

- **Advanced mode works with the local admin assistant.** The Electron-spawned
  admin OpenCode is now served without Basic auth (loopback-only, mirroring the
  assistant), so the cross-origin Advanced iframe no longer 401s when the
  "OpenPalm Admin" connection is selected. (#507)
- **Advanced recovers from a dead/stale session.** Advanced pre-flight-probes the
  active endpoint and, when it is unreachable, shows an inline Reconnect
  affordance (which re-reads the endpoint URL and reloads the frame) instead of a
  silent broken iframe. (#507)
- **Discord & Slack portals deliver messages again.** The 0.12.0 `@opencode-ai/sdk`
  bump (1.15.13 → 1.17.7) changed `session.*` calls to resolve to a `{ data, error }`
  envelope; the adapters read the session off the envelope directly, so the session
  id was `undefined` and prompts were sent to the un-substituted path
  `/session/{id}/message` — which the guardian denied as `no_route`. Both adapters
  now read the session from `.data` (and surface prompt errors). A portal-secret
  contract test plus adapter regression tests guard against recurrence.

## [0.12.0] - 2026-06-15

The "channels" subsystem is renamed to **portals**, the guardian gains a
moderated front door for direct OpenCode/MCP clients, and setup/release
plumbing is hardened. The portal rename ships with automatic upgrade
migrations — see **Migration** below.

### Changed

- **BREAKING — "channels" → "portals" across the stack.** The platform/adapter
  ingress concept (Discord, Slack, chat, API) is now called a **portal**. This
  touches user-visible and runtime surfaces:
  - Compose: `channels.compose.yml` → `portals.compose.yml`; the per-portal
    verification secrets `knowledge/secrets/channel_<name>_secret` →
    `portal_<name>_secret`; guardian env `CHANNEL_<NAME>_SECRET_FILE` →
    `PORTAL_<NAME>_SECRET_FILE` and `GUARDIAN_REQUIRE_CHANNEL_SECRETS` →
    `GUARDIAN_REQUIRE_PORTAL_SECRETS`.
  - Networking: the adapters↔guardian network is `portal_net` (was `channel_lan`).
  - Guardian: principal `kind` `channel` → `portal`; `/stats` fields
    `channel_window_ms`/`channel_max_requests`/`active_channel_limiters` →
    `portal_*`.
  - Release: the `release_channels` workflow input → `release_portals`; the
    `channels` release unit → `portals`.
  - Docs moved: `docs/channels/` → `docs/portals/`.
- **Guardian: opt-in moderated front door for direct OpenCode + MCP clients.**
  A transparent OpenCode reverse-proxy (`/oc`) and an in-process MCP server
  (`/mcp`, `ask_assistant`) sit behind the same moderation → ownership → bounds
  pipeline; both are off by default. (#429, #343, #432)
- **Per-image release pinning.** Each image (`OP_*_IMAGE_TAG`) can be pinned
  independently of the platform tag. (#477)
- **`OP_BIND_ADDRESS` global** collapses the per-service port/bind-address pairs
  into one opt-in LAN switch (loopback by default). (#395)
- **mDNS discovery now uses OpenCode's native in-process responder** instead of
  avahi `apk add` sidecars. The `mdns-guardian` / `mdns-assistant` compose
  services (and the `addon.mdns` / `addon.mdns.assistant` profiles) are removed.
  mDNS is configured via `server.mdns` / `server.mdnsDomain` in the assistant
  and guardian `opencode.jsonc` files and ships **off** (LAN-first). The
  assistant can advertise `<name>.local` once LAN-exposed (Linux host +
  `network_mode: host`); the loopback-only guardian moderator never advertises.
  Note: the service-instance label is OpenCode's hardcoded `opencode-<port>` —
  only the resolved `.local` hostname carries the custom name. See
  `docs/technical/network-partitioning-d5a.md`.

### Added

- **Connections tab for CLI agent tools** (Codex, Claude Code, Copilot, Pi) with
  shared provider-key handling. (#479, #480)
- **Launch routing**: first-run `/splash`, hooks-based routing, and a CLI
  `openpalm status` command, all from one shared launch-status helper. (#440)
- **Setup resilience**: deploy journal / restart-resume, centralized Docker
  error mapping, managed-asset refresh on every apply, and reconcile-on-install.
  (#465)
- **Self-updating control plane (thin Electron harness).** The desktop app is now
  a thin native harness: the admin UI build, the `@openpalm/lib` control plane
  (including `RELEASE_MIGRATIONS`), and the Docker stack images self-update in
  place over npm / `compose pull` with **no app re-download**. A re-download is
  required only when the native harness surface (IPC / preload / spawn-env / FS
  conventions) changes — tracked by a single `HARNESS_CONTRACT_VERSION` (starts at
  `1`) that is independent of the control-plane `PLATFORM_VERSION`. Both
  supervisors (the Electron harness and `openpalm ui serve`) self-update `data/ui`
  before spawning and can hot-restart the UI child in place after a UI-build
  update. A published `@openpalm/ui` build declares `minHarnessContract`; the
  harness refuses to self-update onto a build its native surface can't satisfy and
  prompts a re-download instead of failing at runtime. A CI guard
  (`scripts/validate-thin-harness-boundary.sh`) pins the boundary: the frozen
  harness bundle carries zero migration symbols; the UI build carries them.
  (#495, #496)
- **`openpalm update --pre`** opt-in for prerelease (rc/beta) stack versions.
  (#494)
- **Desktop Docker preflight.** The Electron app runs the CLI's Docker probes at
  launch and shows a legible install/retry screen instead of an opaque
  `503 docker_unavailable` ~60s into the splash. (#493)
- **Upgrade preview.** `openpalm migrate --dry-run --to <version>` previews the
  exact copy-only release migrations an upgrade *would* run (read from the target
  version, not the current `stack.env`; defaults to the newest published tag for
  the current major). The UI's Advanced options gains a matching "Preview changes"
  button that lists the operations before you apply. (#497)
- **"An update is available" signal.** `openpalm status` prints a one-line,
  channel-correct advisory to stderr (stdout JSON stays clean for scripts) when a
  newer release is published, and the web UI shows a persistent "An update is
  ready — review it" banner in the shell that jumps to the Updates tab. (#498)
- **Backup safety and visibility.** A pre-backup free-space check blocks a
  full-home layout backup that would exceed a safe fraction of free disk (with a
  plain-language message; nothing is deleted — proceed by confirming) instead of
  silently filling the disk. The UI surfaces backups (count, total size, last
  time, per-backup list, restore guidance) and a confirm-gated "Prune…" that
  drives the *existing* `openpalm backups prune` — there is no automatic
  deletion. (#499)
- **Stuck-operation recovery.** A new `openpalm unlock` command (and a UI "An
  operation seems stuck — clear it?" affordance) clears a **stale** install lock
  after validating staleness (dead PID or older than 30 minutes); a live lock is
  refused with the auto-heal note. Install/update/migrate abort paths now point at
  the backup that was just made and `openpalm rollback`. (#500)
- **Electron prerelease opt-in.** A "Check for prerelease versions" tray toggle
  switches the desktop update check to the full releases list and notifies on
  newer prereleases for users piloting an rc — notify-only, default off. (#504)

### Changed

- **Version / release-semantics reconciliation.** `PLATFORM_VERSION` in
  `@openpalm/lib` is now the single source of truth for the control-plane version
  (replacing the implicit `v${libPkg.version}` scattered through lifecycle /
  migrations). Canonical helpers (`normalizeVersion`, `formatForDocker`,
  `formatForDisplay`, `isPrerelease`, `distTagForVersion`) are the one place that
  reconciles the Docker-tag (`v`-prefixed), npm (bare), and dist-tag
  (`latest`/`next`) vocabularies. The UI build update channel is decoupled from
  `app.getVersion()` (declared platform channel via `OP_UI_CHANNEL`). (#495)
- **Unified version display.** Every version label the user reads (Assistant /
  App / UI rows and the update action buttons) is normalized to one canonical
  no-`v` spelling, and the Updates tab shows a one-line active-channel indicator
  ("You're on the **stable** / **prerelease** channel."). Internal tag formats are
  unchanged; only what the user reads is unified. (#503)

### Fixed

- **Prerelease / cross-version bootstrap trap (#492).** A host running an older
  control plane could point the *stack* at a newer tag through the version picker,
  running the new release's migrations against the old `@openpalm/lib` and coming
  up half-migrated. `applyTagChange` / `performUpgrade` now hard-block (with a
  plain-language message) when the target tag is newer than the running
  `PLATFORM_VERSION`, and the UI version dropdown is filtered server-side to tags
  ≤ the running platform so the trap is unreachable.
- **`openpalm update` no longer auto-jumps a stable install onto a prerelease
  (#494).** `resolveNewestDockerTag` skips prerelease tags when the base is
  stable; a prerelease base stays on its channel, and `--pre` is the explicit
  opt-in. This aligns the CLI, the UI "Update now" card, and the desktop update
  check on one definition of "latest."
- **Downgrades via the version picker now require confirmation (#501).**
  Selecting a tag older than the running version is detected in `applyTagChange`
  as a downgrade and blocked with a typed signal; the UI shows a plain
  forward-only-migrations / restore-from-backup warning and re-submits with an
  explicit `confirmDowngrade` only after the user agrees. (The CLI `migrate --to`
  path is preview-only.)
- **Secret-like keys removed from `stack.env` are no longer stripped silently
  (#502).** `writeSystemEnv` still removes `*_API_KEY` / `*_TOKEN` / `*_SECRET` /
  `*_PASSWORD` keys per the secret-boundary contract, but now logs a structured
  warning and surfaces a one-time, dismissible UI notice naming the removed keys
  and pointing the user at the Connections tab to re-add them.

### Deprecated

- **`channel_lan` Docker network.** Renamed to `portal_net`. `channel_lan` is
  retained as an empty bridge for this release so existing
  `custom.compose.yml` overlays that still reference it keep validating on
  upgrade. **It is removed in 0.13.0** — update any custom overlay to
  `portal_net` before upgrading past 0.12.0.
- **`CHANNEL_NAME` compose marker.** `PORTAL_NAME` is canonical; the legacy
  `CHANNEL_NAME` marker is still recognized for migration safety and **removed
  in 0.13.0**.

### Migration

- Upgrading from 0.11.x is automatic and non-destructive for these surfaces: the
  per-portal secrets `knowledge/secrets/channel_<name>_secret` are renamed to
  `portal_<name>_secret` (value preserved), the guardian's SQLite principal
  `kind` is migrated `channel` → `portal`, and `portals.compose.yml` is
  re-materialized (the stale `channels.compose.yml` is inert — the control plane
  loads an explicit overlay list, not a glob).
- A user-authored `custom.compose.yml` overlay referencing the `channel_lan`
  network is **auto-migrated**: the upgrade rewrites `channel_lan` → `portal_net`
  in place (backing the original up to `custom.compose.yml.pre-portal-rename.bak`
  first; idempotent). It still validates in 0.12.0 via the deprecated bridge and
  now keeps working past the 0.13.0 removal with no manual edit. If your overlay
  *defines* its own external `channel_lan` network, review the rewrite against the
  `.pre-portal-rename.bak` copy.

## [0.11.1] - 2026-06-08

A macOS + setup-experience stabilization patch. No migration needed from 0.11.0.

### Changed

- **Desktop app ships as plain archives for the simplest unsigned install.** macOS
  is a `.app` `.zip` and Windows is a portable `.zip` (extract and run) instead of
  a `.dmg` / NSIS installer — removing the installer + Gatekeeper/SmartScreen
  install-time friction. macOS still shows a one-time prompt for unsigned apps
  (right-click → Open, or clear quarantine). Trade-off: the desktop app no longer
  auto-updates (it never could on unsigned macOS anyway) — re-download to update.

### Added

- **GPU-aware setup recommendation.** When setup starts with no provider
  configured, OpenPalm now detects host GPUs (VRAM-aware) and local providers and
  recommends the right path automatically: use a connected cloud provider; or
  auto-add a host Ollama/LM Studio that's already running; or, when a capable GPU
  (≥ 8 GB VRAM) is present, enable in-stack Ollama with the matching hardware
  profile; otherwise prompt to connect a provider (OpenCode flow or a custom
  OpenAI-compatible endpoint). (#453, #454)
- **Semantic embeddings work out of the box with no configuration.** The default
  local embedding model is pre-baked into the assistant image, so akm self-embeds
  offline on first run instead of silently falling back to keyword search. (#453)

### Fixed

- **macOS: app failed to launch from the Finder icon.** The desktop app now runs
  the UI server with its bundled Node and augments PATH, fixing the silent launch
  failure (terminal-only PATH). Added file logging to `~/Library/Logs/OpenPalm/`
  and a "Show Logs" tray item. (#456)
- **macOS: oversized menu-bar tray icon** is now correctly sized. (#455)
- **macOS/OrbStack: Ollama failed to start** ("access denied creating
  `data/ollama`"). The data dir is mounted at Ollama's native `$HOME/.ollama`
  path (no container mounts a generic `/data`), and pre-created bind-mount targets
  are owned by the operator UID. (#452)
- **Setup wizard dark mode** is readable again — the wizard inherits the app's
  themeable design tokens instead of a light-only stylesheet. (#451)
- **No more needless Ollama embedding config.** Enabling Ollama no longer writes
  an embedding config that overrode akm's local embedder. (#454)
- **Check-up: installing version `latest` failed** with a raw GitHub asset error.
  `latest` now resolves to the concrete newest release tag before fetching stack
  assets (or fails with a clear message). (#449)
- **"Update now" now recreates the guardian and channel containers** so channel
  adapters re-resolve their npm dist-tag packages and guardian picks up the new
  image. (#450)
- **Admin no longer re-prompts for the UI password with a valid session.** The
  session cookie is cookie-first with sliding renewal (httpOnly, Secure on HTTPS
  only so LAN installs still work). (#437)

## [0.11.0] - 2026-06-07

### Changed (BREAKING — automatic migration on upgrade)

The secrets/env filesystem layout was reorganized to align with the akm
`env` + `secret` asset model and to consolidate all env files and secrets out
of `config/stack/`. **`openpalm update` migrates an existing 0.10.x home
automatically** — it takes a full backup first, then copies your env/secret
files into the new locations (copy-only; your original `vault/` is left in place
as a recovery copy, with a `README.md` describing safe removal) and aborts with
no changes if the backup fails. **Upgrading from 0.10.x? Start with the
[0.10.x → 0.11.0 upgrade guide](docs/operations/upgrade-0.10-to-0.11.md)** (what
the migration does, file/env/port mapping, ordered procedure). The only manual
follow-up is re-adding provider API keys (Connections) and LLM/embedding config
(`config/akm/config.json`), whose formats changed.

- **akm `vault` → `env` + `secret`** — akm 0.8.0 removed the `vault` type
  (per-entry `vault set`/`unset` hard-error). The user-managed env moves from
  `vault:user` at `knowledge/vaults/user.env` to the akm **`env`** type
  `env:user` at `knowledge/env/user.env`. OpenPalm now owns the file directly —
  admin writes/deletes are atomic `.env` edits (mode 0600), no `akm vault`
  subprocess. The admin route `/admin/secrets/user-vault` is now
  `/admin/secrets/user-env` (`envRef: env:user`). gws-setup credentials move
  from `knowledge/vaults/.gws` to `knowledge/secrets/.gws`.
- **`config/stack/stack.env` → `knowledge/env/stack.env`** — the Compose
  `--env-file` (non-secret system config) joins the env files under
  `knowledge/env/` as `env:stack`.
- **`config/stack/auth.json` → `knowledge/secrets/auth.json`** — OpenCode
  provider credentials move out of `config/stack/`; `config/stack/` now holds
  only non-secret compose assembly (compose files + `stack.yml`).
- akm-cli is pinned to the stable **0.8.0** release (it provides the `env` +
  `secret` asset types).
- **`OP_ADMIN_PORT` → `OP_HOST_UI_PORT`** — the host admin/UI port env var was
  renamed and the legacy name is no longer emitted or read anywhere. The
  auto-migration renames it for you (in `knowledge/env/stack.env`); installs that
  never customized it simply pick up the default `3880`.
  `OP_ADMIN_OPENCODE_PORT` and `OP_GUARDIAN_PORT` were removed outright (emitted
  but never read; the guardian is network-only, no host port mapping).
- **`config/stack/stack.yml` is removed entirely** — stack composition + versions
  are consolidated into `knowledge/env/stack.env` as the single authoritative
  record: addon enablement is `OP_ENABLED_ADDONS` (was `stack.yml addons[]`), and
  versions are `OP_IMAGE_TAG` / `OP_LAYOUT_VERSION` / `OP_UI_VERSION`. The
  `capabilities:` block / `OP_CAP_*` are gone; LLM/embedding config lives in
  `config/akm/config.json`. The auto-migration converts `addons[]` →
  `OP_ENABLED_ADDONS` and deletes nothing.
- **Admin UI is now a host process** (`openpalm ui serve`, `@openpalm/ui` from
  npm), not a container. The `admin` container/service, `docker-socket-proxy`,
  and the Caddy reverse proxy are all gone — services bind localhost (LAN-first).
  Anything referencing an `admin` compose service or addon no longer applies.
- **`memory` (mem0/Python) and `scheduler` containers removed** — memory is
  handled through the akm knowledge tools and scheduling runs inside the
  assistant (`crond` + `akm tasks sync`).
- **Custom addon drops moved to the compose-profile model** — addon overlays
  under `config/stack/` activated via `--profile addon.<name>` (the old
  `registry/addons/<name>/compose.yml` layout no longer applies).

### Added

- **Rich channel UX (live streaming)** — the guardian runs a transparent OpenCode
  reverse proxy (`/oc`), so Discord/Slack/API channels stream assistant responses
  in real time with typing indicators and tool-activity reactions, plus opt-in
  fail-closed content moderation (heuristic screen → local OpenCode moderator).
- **Advanced chat view** — an embedded OpenCode web UI under a full-width
  navbar (Chat / Advanced / Admin).
- **Voice addon** — local speech (Kokoro TTS + faster-whisper STT) as an opt-in
  addon with CPU/CUDA compose profiles, a prebuilt model bundle, and out-of-band
  image publishing decoupled from the platform release.
- **Independent UI distribution** — the operator UI ships as `@openpalm/ui` on
  npm and is fetched + integrity-verified at runtime, versioned independently of
  the platform.
- **Host ↔ assistant knowledge sharing** — the host akm stash can be shared
  (symmetric, writable) with the assistant.
- **Automatic 0.10.x → 0.11.0 layout migration** — `openpalm update` / `install`
  (and a standalone `openpalm migrate [--dry-run]`) detect a 0.10.x home and
  migrate it to the `knowledge/env` + `knowledge/secrets` layout: full backup
  first, copy-only (originals retained, with a safe-removal `README.md` written
  into `vault/`), channel-secret split, `stack.yml addons[]` → `OP_ENABLED_ADDONS`,
  gated by `OP_LAYOUT_VERSION` and idempotent. Aborts safely (no changes) if the
  backup fails.
- **Desktop tray mic** — the Electron app supports push-to-talk voice recording
  from the system tray with updated shortcuts.

### Changed

- **OpenCode runtime bumped to 1.15.13** (assistant + admin tools).
- **Portal adapters are baked into the portal image**, and the OpenAI-compatible
  API is served by the guardian image.
- **Runtime env vars are `OP_`-prefixed** (e.g. `OP_TTS_*`, `OP_STT_*`,
  `OP_VOICE_*`) to avoid host-environment collisions.
- **Release pipeline consolidated** into a single coordinated, manually-dispatched
  `platform-release.yml` orchestrator (version-synced bump → ordered npm publish →
  Docker/CLI/Electron/voice → tag + GitHub release last; fail-safe, resumable).
  Auto-publish-on-merge triggers removed.
- **CI moved off the deprecated Node 20 actions runtime** to Node 24
  (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`,
  `actions/download-artifact`, `softprops/action-gh-release`).
- **Operator UI: server-side auth** — admin auth is enforced in the SvelteKit
  server hook with a dedicated `/login` route; the login screen no longer flashes
  on navigation and pages carry no client-side auth code.
- **Operator UI: standardized chrome + chat layout** — shared `IconButton` /
  `ToggleButton` components; the assistant + session selectors are drawers, with
  a persistent assistant/session side panel on large screens; centralized
  date/time formatting; session names OpenCode left as a default timestamp now
  render as a formatted date.

### Fixed

- **Stack upgrade no longer fails resolving the asset version** — the target
  release tag is passed explicitly into the core-asset download. It previously
  degraded to `"main"` when `@openpalm/lib` was bundled into the UI/electron
  (the `import.meta.url` package.json read does not resolve in a bundle), 404ing
  the compose files on both the release and raw URLs.
- **`/login` no longer redirects to a 404 after sign-in** — a stale post-login
  navigation target (`invalidateAll()` racing the redirect) sent the browser to
  `/undefined`; it now navigates to the originally-requested page.

## [0.11.0-beta.11] - 2026-05-29

### Changed

- **Assistant compose mounts simplified** — logs and lifecycle backups moved
  under `data/`, AKM cache/data share the backed-up `data/akm` runtime
  data, and `/opt/persistent` is documented as an escape hatch for global-prefix
  installs while `$HOME/.local/bin` remains the preferred install target.

### Fixed

- **Secret files now live under `stash/vaults/secrets/`** — Compose file grants,
  dev/release scripts, validation, and setup docs now use the stash-backed
  secret path instead of `config/stack/secrets/`, keeping assistant-readable
  secrets out of the general stack config tree.
- **First-run auth no longer auto-materializes an admin password** — secret
  bootstrap now leaves `OP_UI_LOGIN_PASSWORD` unset until setup explicitly
  writes it, so setup/login routes correctly preserve the unconfigured state.
- **Host OpenCode import now preserves model defaults** — host imports fill in
  `model`, `small_model`, and `disabled_providers` only when the destination
  config has not already set them, avoiding silent resets while still carrying
  forward useful defaults.

## [0.11.0-beta.10] - 2026-05-26

### Changed

- **Removed dead code left by the capabilities → akm migration** — `readStackSpec`
  dead import in `lifecycle.ts`, unused `stackSpecFilePath` export in `paths.ts`,
  `stackSpecPath` helper in `stack-spec.ts` (never called in production), and the
  unused `spec: StackSpec` parameter in `deriveSystemEnvFromSpec`. Stale wizard
  comment referencing `stack.yml capabilities.tts.provider` updated to reflect
  current stack.env path.

## [0.11.0-beta.9] - 2026-05-26

### Fixed

- **All CLI commands now guarantee exit code 1 on failure** — ten command
  `run()` handlers (`logs`, `restart`, `start`, `stop`, `status`, `update`,
  `automations`, `scan`, `rollback`, `uninstall`) were missing try-catch.
  Unhandled rejections could leave the process with exit code 0 in scripts and
  CI pipelines. Each handler now catches, prints the error message, and calls
  `process.exit(1)`.
- **`stack.yml` seed file stripped to `version: 2` only** — the repo-shipped
  seed contained a full `capabilities:` block (LLM provider, embedding model,
  memory config) that was removed in the capabilities-to-akm-config migration.
  The stale block was a documentation hazard and incompatible with the current
  `StackSpec` type.
- **CHANGELOG stale `OP_CAP_*` references corrected** — two lines in the
  `[0.11.0]` section described provider/model config as driven by `OP_CAP_*`
  env vars and `stack.yml` capabilities; updated to reflect that config now
  lives in `config/akm/config.json`.

## [0.11.0-beta.8] - 2026-05-26

### Fixed

- **npm `files` whitelist added to `packages/cli`** — the CLI package had no
  `files` field or `.npmignore`, so `npm publish` would have included `src/`,
  test files, and `playwright.config.ts`. Now limited to `bin/`, `dist/`, and
  `README.md`.
- **`install`, `update`, `uninstall` endpoints now return structured errors** —
  unhandled exceptions inside the serial-queue lifecycle callbacks previously
  fell through to a raw SvelteKit 500. Each handler now catches errors and
  returns `errorResponse()` with code `install_failed` / `update_failed` /
  `uninstall_failed`.
- **`@openpalm/lib` now exports `types` field** — TypeScript consumers using
  older toolchains that don't resolve via `exports` can now auto-discover types.

### Docs

- **`SECURITY.md` updated** — supported versions table now shows `0.11.x`
  (was `0.9.x`); stale reference to Caddy reverse proxy replaced with the
  current localhost-binding architecture.

## [0.11.0-beta.7] - 2026-05-26

### Security

- **System-managed config files now written with restrictive modes** —
  `stack.env` and files under `config/stack/secrets/` are created with
  restrictive permissions, and `chmodSync` is applied to enforce permissions on
  pre-existing files.

### Fixed

- **`opencode.jsonc` no longer overwritten on upgrade** — `config/assistant/opencode.jsonc`
  was in the managed-assets refresh list and would silently reset user-customised
  model/agent settings on every `openpalm update`. It is now seeded-only: written
  on first install (or when missing), never overwritten by the upgrade path.
- **Corrupt `stack.env` now backed up before silent discard** — `parseEnvFile`
  previously returned `{}` on any parse error, causing the next write to silently
  discard all existing env vars. It now copies the corrupt file to
  `stack.env.corrupt-<timestamp>` before returning empty.
- **UI tarball extraction clears stale build files** — `seedUiBuild` now removes
  and recreates `state/ui/` before extracting a downloaded tarball, preventing
  old build files from persisting across version changes.
- **Admin API error envelopes** — `stack-version`, `ui-version`, and `versions`
  endpoints now use `errorResponse()` consistently (matching the API contract)
  instead of raw `json({ error })` calls; `versions` also guards against a
  missing `stackDir` before setup completes.

## [0.11.0-beta.6] - 2026-05-26

### Fixed

- **`channel-api`: `forwardToGuardian` not a function** — all three API handlers
  (`/v1/chat/completions`, `/v1/completions`, `/v1/messages`) were calling a
  non-existent method and returning 502 for every request. Replaced with the
  correct `this.forward({ userId, text, metadata })` pattern from `BaseChannel`.
- **`channel-api`: userId not namespaced** — API channel was passing raw user
  values (`u1`, `api-user`) to the guardian without the required
  `${channel}:` prefix. External callers could accidentally collide with other
  channels. Fixed to `${this.name}:${rawUser}` in all three handlers.

### Added

- **"Enable Voice" toggle on Welcome step** — the one-click auto-mode path now
  includes a checkbox (off by default). When checked, the CPU voice addon is
  deployed on first boot (~2.4 GB download). When unchecked, voice is fully
  disabled (no browser fallback). Engine value is passed through directly so
  the Review step shows "Disabled" when unchecked.

## [0.11.0] - 2026-05-26

### Security

- **SEC-4: Setup routes restricted to localhost until setup completes** —
  `hooks.server.ts` now checks the TCP client IP on all `/setup` and
  `/api/setup/*` paths while `isSetupComplete()` is false. Remote clients
  receive a 403; this prevents a race where a remote actor reaches the
  unauthenticated first-run wizard before the owner does. Post-install
  re-runs (`/setup?rerun=1`) require admin auth and are not affected.
- **HMAC constant-time compare** — guardian uses timing-safe comparison for all
  channel HMAC validation.
- **Path traversal rejection** — assistant-client rejects path-escape requests.
- **argv-leak prevention** — `akm vault` secret operations pass secrets via
  stdin; unconditional CI test coverage verifies this.

### Added

- **"Use recommended defaults" is now a true one-click auto-install path** —
  clicking the primary button on the Welcome step now completes setup without
  walking through Providers, Models, Voice, or Options. If host providers were
  already detected (OpenCode running on the host), they are imported in the
  background and the best model defaults are selected automatically. If nothing
  is detected, the stack installs without a provider.
- **"System Check" wizard step (index 0)** — runs Docker + Compose v2 detection
  via `/api/setup/system-check`, with platform-specific install/start guidance
  and port-availability warnings. Blocks navigation forward until Docker is
  healthy. Suppresses port-conflict warnings in re-run mode (the running stack
  itself).
- **`FriendlyError` component + `friendlyError()` utility** — every wizard
  error site now maps raw API/network/Docker errors to user-actionable
  `{ title, body, hint, links }` cards. Applied to provider verification,
  setup-complete failures, deploy errors, and deploy-poll loss-of-contact.
- **DeployStep phased progress** — `phase` field surfaced through the
  deploy-status API and consumed by the UI: `writing-config → pulling-images
  → starting → ready`, with realistic ETA copy for first-time image pulls.
- **Wizard re-run from admin** — "Update Settings" in the admin overview links
  to `/setup?rerun=1`. The wizard pre-populates admin token, owner, image tag,
  host AKM toggle, LLM/embedding selections, voice fields, enabled addons, and
  channel credentials from the existing install.
- **Electron update banner (notify-only)** — Electron checks the latest
  GitHub release on startup (5 s timeout, 6 h cache). When a newer version
  exists, a dismissible banner is shown with a download link. Dismissal
  persists per-version in `localStorage`.
- **Electron startup polish** — frameless splash window while `startUIServer`
  runs; main window shows only after the UI server reports ready. The window
  navigates directly to `/setup` or `/chat` based on `setupComplete` status.
- **Electron auto-publish to GitHub releases** — `electron-builder.yml`
  publishes installers (`.dmg`, `.exe`, `.AppImage`) to the GitHub release tag
  automatically via CI.
- **`@openpalm/admin-tools-plugin` bundled in Electron** — the admin OpenCode
  plugin is now prebuilt and shipped as an Electron `extraResource` instead of
  resolving from npm. The plugin path is resolved from `process.resourcesPath`
  (packaged) or the workspace `dist/` directory (dev), with an npm name as a
  last-resort fallback. `@openpalm/admin-tools-plugin` added to platform
  manifests so it version-syncs with the rest of the release.
- **Persistent install prefix (`/opt/persistent`)** — named volume
  `assistant-persistent` mounted into the assistant container; first on
  `$PATH`. Survives `--force-recreate` and image upgrades.
- **`/api/setup/complete` `dryRun` flag** — persist config without triggering
  a Docker deploy. Used by tests and any validation flow.
- **Cross-OP_HOME compose-project collision guard** — `startDeploy` refuses
  to deploy if existing containers in the same compose project belong to a
  different `OP_HOME`. Prevents the dev/host stacks from clobbering each other.
- **Distinct dev compose project name** — `OP_PROJECT_NAME=openpalm-dev`
  is seeded by `scripts/dev-setup.sh` so the dev stack can never collide
  with a production stack on the same machine.
- **README + setup-guide lead with the Electron download** — desktop app is
  the primary install path; the CLI is collapsed into an "Advanced / headless
  install" disclosure. Gatekeeper/SmartScreen first-launch notes added.
- **Assistant `openpalm.md` install-location matrix** — assistant now has
  explicit guidance on where to install tools (`$HOME`-based installers
  persist for free, `/opt/persistent` for prefix-style installs, `apt` for
  one-off session-only tools).
- **UI as a host process** — the bare `openpalm` command starts the
  SvelteKit UI directly on the host at `http://localhost:3880`. No UI
  container, no docker-socket-proxy. The setup wizard runs at `/setup`
  on first boot and auto-redirects there until setup is complete.
  Configurable via `OP_HOST_UI_PORT`; operator password is stored in
  `config/stack/secrets/op_ui_login_password`.
- **`openpalm` smart default** — running the bare command detects state
  and does the right thing: bootstraps the install if not installed,
  starts the Docker stack if it's down, then runs the UI server in the
  foreground. There is no separate `admin`/`ui` subcommand.
- **akm stash as the shared knowledge layer** — akm-cli 0.8.0 is installed in
  the assistant container. The stash at `OP_HOME/stash/` is mounted at `/stash`
  and shared with the host-side UI process.
- **Scheduler co-process inside the assistant container** — the standalone
  `scheduler` compose service has been removed. The scheduler now runs as a
  lightweight co-process inside `containers/assistant/entrypoint.sh`.
- **Seeds in the akm stash** — built-in skills, commands, and agents are seeded
  into `OP_HOME/stash/` on first install via the CLI embedded assets.
- **Periodic `akm improve` automation** — a catalog automation that runs
  `akm improve` on a schedule to continuously refine stash assets.
- **SSH addon overlay** — SSH port binding is now an optional addon
  (`config/stack/addons/ssh/`) rather than baked into the core compose file.
- **`withAdminBody` route handler helper** — new typed request-body helper for
  admin API route handlers, replacing ad-hoc body parsing.
- **`askAssistant()` one-shot semantics** — the channels-SDK `askAssistant()`
  function now automatically deletes the OpenCode session after receiving a
  response. Pass `{ keepSession: true }` to retain the session.

### Changed

- **`MANAGED_ASSETS` points at the v0.11 paths** — `core-assets.ts` now
  refreshes `config/assistant/opencode.jsonc`, `openpalm.md`, and `system.md`
  from `.openpalm/config/assistant/`.
- **`seedOpenPalmDir` always refreshes system-managed stack assets** — fixed
  compose files now update on every install/upgrade, fixing the case where
  stale overlays persisted through reinstalls.
- **`performSetup` enables addons end-to-end** — `addons: { discord: true }`
  in the wizard payload now calls `setAddonEnabled`, which copies the
  compose overlay AND generates the channel HMAC secret file under
  `config/stack/secrets/`.
  Previously the addon was never enabled.
- **Provider verification error UX** — inline provider errors run through
  `friendlyError` so raw `Failed to fetch models (HTTP 401)` becomes a
  user-actionable card.
- **README "Where things stand"** — updated to describe 0.11.0 as a refactor
  and simplification release; 0.12.x will focus on stabilization and hardening
  before v1.
- **`@openpalm/lib` and `@openpalm/channels-sdk` READMEs** — added Bun-only
  notice: these packages ship TypeScript source and require Bun.
- **Directory layout restructured** — the `OP_HOME` layout is now:
  - `config/stack/` — compose runtime: `core.compose.yml`, non-secret
    `stack.env`, file-based `secrets/`, `addons/`
  - `stash/` — akm knowledge; `stash/vaults/user.env` replaces `vault/user/`
  - `state/` — service-persistent data, logs, AKM cache/data, backups, rollback
  - `workspace/` — shared `/work` mount
- **Provider/model configuration moved to `config/akm/config.json`** —
  `OP_CAP_*` env vars and `stack.yml` capabilities removed. No more env-schema files.
- **akm secret store replaces vault/user** — user secrets live in the akm
  `vault:user` store at `stash/vaults/user.env`. It is not passed to Compose as
  an env-file; stack/service secrets live under `config/stack/secrets/`.
- **`opencode-providers.ts` split into focused modules** — provider logic split
  into `providers-read`, `providers-write`, and `providers-dispatch`.
- **Single-implementation interfaces converted to type aliases** — unnecessary
  interface indirection removed across packages.
- **Channel SDK unified** — channel adapter internals consolidated.
- **`readUserVaultSync` removed** — replaced with async `readUserVault`.

### Fixed

- **`readFileSync` missing import in `ui-assets.ts`** — `svelte-check` was
  reporting a TS error; added `readFileSync` to the `node:fs` import.
- **Silent error swallowing in setup wizard** — five `.catch(() => { /* ignore */ })`
  and `.catch(() => { /* fall through */ })` calls now log to `console.error`
  so wizard failures are visible in browser devtools without changing UX.
- **Port conflict message when Docker is unreachable** — system-check response
  now carries `portCheckReliable: boolean`; when false, the conflict hint reads
  "Docker is not running — start Docker and click Retry to confirm" instead of
  "Another program is using this port".
- **Path traversal guard in assistant-client** — requests escaping the allowed
  path prefix are rejected before reaching the assistant.
- **HMAC constant-time comparison in guardian** — timing-safe comparison for all
  channel HMAC validation, closing a potential timing-oracle side channel.
- **Session cleanup ordering** — OpenCode session teardown follows correct
  dependency order, preventing resource leaks on shutdown.
- **argv-leak test coverage made unconditional** — secret-in-argv tests run in
  all CI contexts without an opt-in flag.
- **`akm vault` secret operations use stdin** — secrets passed via stdin, not
  command-line arguments.

### Removed

- **`containers/assistant/opencode/`** — legacy assistant config location. Now lives
  solely at `.openpalm/config/assistant/`.
- **`ControlPlaneState.setupToken`** — field, generator, all test fixtures,
  and the `state.vitest.ts` "generates setupToken on each reset" test.
  Was unused everywhere outside tests.
- **`mirrorUserVaultToAkm()` and `migrateAndCleanupLegacyUserEnv()`** —
  no-op stubs alongside their call sites in `setup.ts` + `lifecycle.ts`,
  `MirrorResult` type, re-exports in `index.ts`, and their test `describe`
  blocks (~330 lines of test code).
- **Legacy planning artifacts** — `docs/technical/capability-injection.md`,
  `admin-simplification-plan.md`, `akm-capabilities-refactoring-audit.md`,
  `connections-simplification-plan.md`, `release-publish-remediation-plan.md`,
  `proposals/`.
- **`maybe_configure_lmstudio_provider()` in the assistant entrypoint** —
  superseded by OpenCode's auth.json + Connections tab provider management.
  `LMSTUDIO_BASE_URL` plumbing removed from `core.compose.yml`.
- **Admin container** — `openpalm/admin` Docker image is gone. The UI runs
  as a host process via the bare `openpalm` command. `docker-socket-proxy`
  also removed.
- **`admin`/`ui` subcommand** — folded into the bare `openpalm` command.
  Use `openpalm --no-open` for headless invocation (systemd, scripts).
- **Shared `openpalm-base` Docker image** — inlined into
  `containers/assistant/Dockerfile` since it was the only consumer.
- **Memory service** (`packages/memory`) — the Bun-based memory service and all
  OpenMemory integration deleted. Memory and knowledge recall now live in the
  shared akm stash.
- **`*.env.schema` files and varlock** — env-schema validation removed.
  Provider/model configuration migrated to `config/akm/config.json`.
- **Standalone `scheduler` compose service** — replaced by the in-process
  co-process inside the assistant container.
- **Dead code and dead exports** — unused functions, types, and barrel re-exports
  deleted across all packages.
- **SSH port binding from core compose** — SSH is no longer exposed by default.
- **Stale historical comments** — "Phase N of #388 (closes #406)" prefixes
  scrubbed from every active source file. `setup-token.txt` migration comments
  removed.

## [0.9.0-rc2] - 2026-03-10

### Added

- **SvelteKit admin UI** — full rewrite of admin panel as a SvelteKit app with
  server-side rendering, typed API routes, and Svelte 5 runes.
- **Setup wizard** — browser-based first-boot wizard that walks through provider
  connection, channel selection, and stack startup.
- **Connection profiles** — named LLM provider configurations (`connections/profiles.json`)
  with assignment to system, embedder, and channel roles via the admin UI and API.
- **Bun-based memory service** — replaced the Python/mem0 memory backend with a
  lightweight Bun.js service using sqlite-vec for vector storage. Removes the
  Python runtime dependency entirely.
- **Channels SDK** (`packages/channels-sdk/`) — `BaseChannel` abstract class,
  HMAC crypto helpers, structured logger, and typed payload definitions for
  building channel adapters.
- **Channel adapters** — web chat (`channel-chat`), OpenAI-compatible API
  (`channel-api`), and Discord (`channel-discord`) channels, each running as a
  standalone Docker container.
- **Guardian** (`containers/guardian/`) — Bun HTTP server enforcing HMAC verification,
  timestamp skew rejection, replay detection, and rate limiting on all channel
  ingress traffic.
- **Automation scheduler** — in-process Croner-based scheduler on the admin
  container. Drop a YAML file into `automations/` to schedule API calls, HTTP
  requests, or shell commands on a cron expression.
- **XDG directory model** — three-tier filesystem layout (CONFIG_HOME /
  DATA_HOME / STATE_HOME) following the XDG Base Directory Specification.
  CONFIG_HOME is user-owned and never overwritten by automatic lifecycle
  operations.
- **Docker socket proxy** — admin accesses Docker via `tecnativa/docker-socket-proxy`
  over an isolated network instead of mounting the socket directly. Eliminates
  socket permission and GID issues across Docker Desktop, OrbStack, Colima, and
  Podman.
- **CLI** (`packages/cli/`) — cross-platform CLI for setup, status, and stack
  management. Builds native binaries for Linux, macOS, and Windows via Bun.
- **One-line installer** — `setup.sh` (Mac/Linux) and `setup.ps1` (Windows)
  scripts that bootstrap the XDG directory tree, download core assets, generate
  an admin token, and start the stack.
- **Channel registry** — catalog of channel definitions in `registry/` bundled
  into the admin image. Channels are installed from the registry via API or by
  file-drop into CONFIG_HOME.
- **Assistant tools plugin** (`packages/assistant-tools/`) — OpenCode plugin
  providing stack management tools, memory integration, and operational skills
  to the assistant.

### Changed

- Admin API endpoints moved under `/admin/` prefix with `x-admin-token`
  authentication.
- Compose file uses `--env-file` flags instead of `.env` convention for
  explicit env file precedence.
- Memory API switched from REST to a filter-based query model
  (`POST /api/v1/memories/filter`) to work around upstream pagination issues.

### Security

- All channel traffic is HMAC-signed and validated by the guardian before
  reaching the assistant.
- Assistant container has no Docker socket access and communicates with the
  stack exclusively through the admin API.
- Admin panel and all dashboards are LAN-restricted by default (bound to
  `127.0.0.1`).
- Audit logging for admin operations (`admin-audit.jsonl`) and guardian
  requests (`guardian-audit.log`).

## [0.8.0] - 2026-01-15

### Added

- Docker Compose orchestration for core services (Caddy, admin, assistant,
  guardian, memory).
- OpenCode integration as the assistant runtime with project-scoped config.
- Basic admin API for container lifecycle management (start, stop, restart,
  pull).
- Python-based memory service using mem0 for conversation history and context
  recall.
- Channel system foundation with compose overlay and Caddy route discovery.
- Caddy reverse proxy with automatic LAN/public network segmentation.
- Initial XDG directory structure with CONFIG_HOME and DATA_HOME tiers.

[Unreleased]: https://github.com/itlackey/openpalm/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/itlackey/openpalm/compare/v0.9.0-rc2...v0.11.0
[0.9.0-rc2]: https://github.com/itlackey/openpalm/compare/v0.8.0...v0.9.0-rc2
[0.8.0]: https://github.com/itlackey/openpalm/releases/tag/v0.8.0
