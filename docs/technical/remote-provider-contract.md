# Remote Provider Contract

**Status:** Implemented (Tailscale is the reference provider)
**Roadmap:** `.github/roadmap/0.14.0/remote-access-providers.md` (the design
this implements), `pangolin-remote-access.md` (the next provider's plan)

The `remote` addon is one capability with mutually-exclusive **provider
variants**: each provider is a compose profile (`addon.remote.<id>`), exactly
one is active per stack, and `OP_REMOTE_PROFILE` selects which. This document
is the durable contract a new provider implements, with the Tailscale
implementation as the worked example throughout — it is the gold standard in
the literal sense: copy its shape, and the shared machinery (enable paths,
status card, guardian ingress, secret seeding, login throttle) needs no
changes.

## Provider Model

`packages/lib/src/control-plane/remote-providers.ts` holds the registry —
one `RemoteProviderInfo` per provider: id, selector label, compose profile,
services (the recreate scope), owned env keys, secret files to seed, the
guardian-ingress predicate, and the exposure-summary lines. The module
depends only on leaves (env, profile-ids, remote-access, access-toggles) so
both `addons.ts` and each provider's apply module can import it without
cycles.

Two node-side dispatchers key off the registry without the registry knowing
them:

| Dispatcher | Job | Tailscale arm |
|---|---|---|
| `remote-provider-apply.ts` — `applyRemoteProviderConfig(homeDir)` | Regenerate the selected provider's artifacts around every enable/disable/save; report services to recreate, warnings, errors. Never throws. | `applyRemoteAccess` (remote-apply.ts): serve.json regeneration, hostname pin, guardian-ingress env |
| `remote-provider-status.ts` — `fetchRemoteProviderStatus(state, deps?)` | Observed state, mapped into the shared `RemoteAccessStatus` vocabulary. Injected Docker deps; never throws. | `tailscale --socket=/tmp/tailscaled.sock status --json` via `composeExec`, with a `compose ps` fallback that distinguishes never-started / crashed / booting |

The dispatchers, not the callers, know which provider is selected:
`addons.ts` and the credentials route call the dispatch and nothing
provider-specific. Adding a provider means one registry entry plus one arm
in each dispatcher — no caller changes.

## Variant Profile and Activation

The provider's services are gated behind its variant profile with the
selector's display labels:

```yaml
  tunnel:
    profiles: ["addon.remote.tailscale"]
    labels:
      openpalm.profile.label: Tailscale
      openpalm.profile.default: "true"
```

Activation is decided by `resolveActiveProfiles` (compose-args.ts), **not**
by the labels — its variant-defaults table reads `OP_REMOTE_PROFILE` and
falls back to the default provider's profile, which is what keeps a
hand-edited `OP_ENABLED_ADDONS=remote` deploying the default variant with no
selection stored. `OP_REMOTE_PROFILE` is deliberately **not** in
`PROFILE_ONLY_ENV_KEYS`: the selection survives disable (provider state
stays on disk for switching back) and never implies enablement on its own.

## Status Vocabulary

Every provider's `fetchStatus` maps into `RemoteAccessStatus`: one of eight
states (`off · awaiting-config · awaiting-authentication · pending-external
· starting · up · degraded · error`), one sentence, at most one action
button, copyable facts (with an optional QR flag), and named progress
stages. Two invariants, both pinned by tests:

- **States clear only by observation.** The card polls; nothing advances on
  a clicked "done". Tailscale's sign-in state clears when
  `status --json` stops reporting an `AuthURL`, not when the operator
  returns from the browser.
- **A URL is advertised only in `up`**, and only from observed state —
  Tailscale's from the node's own reported `Self.DNSName`, never
  interpolated from config (the tailnet suffix is assigned at registration
  and unknowable before it).

The Tailscale mapping also demonstrates the honesty bar for failure states:
an exec failure is disambiguated through `compose ps` (never-started →
`starting` with the start hint; stopped/crash-looping → `error` with the
logs pointer; healthy-but-socket-dead → `degraded`, a named contradiction),
and node-key expiry surfaces before it bites (`up` with a dated warning
inside 14 days, `degraded` with re-sign-in guidance once expired).

## Secrets

Registry `secrets` lists are seeded as empty files by `ensureSecrets` on
every install — required because Compose fails container creation outright
when a declared secret's source file is missing, so the hand-edit enable
path can never brick the stack. For Tailscale, blank `ts_authkey` is
meaningful, not placeholder: it selects interactive login. Delegated-secret
placement (`state/secrets/`, never the assistant-visible stash) follows
`secrets-files.ts`.

## Guardian Ingress

`computeGuardianIngressRequired(env)` in remote-providers.ts is the single
writer feeding `resolveAccessEnv`'s `guardianIngressRequired` option:
addon enabled AND the selected provider's own predicate. All three
consumers (access-apply.ts, setup.ts, the provider apply) call it with
whatever env snapshot they already hold. A provider never writes
`GUARDIAN_DIRECT_INGRESS` itself.

## Login Throttle Behind a Sidecar

Provider-independent, handled by the apply dispatcher: behind any remote
sidecar every request reaches the UI container from one address, which
turns the per-client login throttle into a global lockout. The dispatcher
maintains `OP_UI_ADDRESS_HEADER` / `OP_UI_XFF_DEPTH` (consumed by
adapter-node via core.compose.yml): set to `x-forwarded-for` / `1` while
the addon is enabled, cleared when disabled — cleared because a LAN client
hitting the container port directly could forge the header to rotate
throttle keys. The assistant joins the recreate scope only on that
enable/disable edge, never on a config save.

## UI Surface

One provider-agnostic card (`RemoteStatusCard.svelte`) renders the
vocabulary — state chip, message, action button, copy rows, QR (the status
route decorates qr-flagged copyables with a `uqr`-rendered SVG), progress
list — polling every 5 s while mounted. The drawer's schema fields sit
collapsed under Advanced settings; the default Tailscale setup needs no
fields at all. `OP_REMOTE_PUBLIC` has no UI control by design
(public-unauthenticated exposure is a documented hand-edit; public exposure
with an auth gate is a future provider's job). The addon row shows a
compact status chip; the provider selector renders only once the registry
holds more than one entry. Deep link: `/host?tab=addons&addon=remote`.

## Adding a Provider — Checklist

1. Registry entry in `REMOTE_PROVIDERS` (id, label, profile, services,
   envKeys, secrets, predicates).
2. Compose service block(s) under `addon.remote.<id>` with
   `openpalm.profile.label`, following every addon convention
   (`docs/technical/adding-an-addon.md`) — digest pin, rootless, log caps,
   no host ports unless publishing is the provider's purpose, stated
   network exceptions.
3. An apply module (artifact generation, fail-closed disable semantics) and
   its arm in `remote-provider-apply.ts`.
4. A status mapping and its arm in `remote-provider-status.ts`, with every
   reachable state unit-tested through injected deps.
5. Schema fields merged into `BUILTIN_ADDON_ENV_SCHEMAS.remote`, filtered
   in the drawer by the provider's `envKeys`.
6. Contract tests mirroring `remote-providers.test.ts` /
   `remote-compose.test.ts`: registry↔compose agreement, digest pin,
   network posture, no literal secrets in `environment:`.
7. Docs: this file's table, the headless section in
   `docs/operations/manual-headless-install.md`, and
   `docs/technical/environment-and-mounts.md`.

## Verification

Covered by tests: registry↔compose agreement; the profile grammar
(provider suffixes admitted, hardware readers unchanged); default-provider
fallback and selection-never-implies-enablement; every Tailscale status
state through injected deps; the forwarded-address env lifecycle and its
recreate scope; the guardian-ingress predicate's agreement with the
pre-registry logic it consolidated.

**Not covered:** a live tailnet round-trip. The status mapping was
verified against a running tunnel before this refactor; re-verify after
it (enable → Connect → up → phone opens the URL → tokens stream → disable
closes fail-closed) — the checklist the roadmap's Implementation status
carries.
