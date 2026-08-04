# Paperclip Addon — Technical Design

**Status:** Design, not yet implemented. No code has been written for this.
**Date:** 2026-08-04
**Author context:** follows [`../reviews/paperclip-integration-analysis.md`](../reviews/paperclip-integration-analysis.md)
**Upstream reviewed:** [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip) @ `2ab797d`, MIT

Ships Paperclip as a first-party OpenPalm addon (`OP_ENABLED_ADDONS=…,paperclip`)
with operator control over three things:

1. **How Paperclip reaches the assistant** — directly, or through Guardian.
2. **How much screening that traffic gets.**
3. **Who can reach Paperclip's own web UI** — host only, LAN, or tailnet.

**Defaults:** direct assistant access, host-only web UI. Nothing is exposed and
nothing new is screened unless the operator asks for it.

---

## 1. Decisions already taken

| Decision | Choice | Consequence |
|---|---|---|
| Scanning granularity | **Reuse the existing global toggle** | No Guardian code changes. `GUARDIAN_CONTENT_VALIDATION` keeps its current semantics; routing choice *is* the scanning choice. Per-principal levels are a documented future extension (§9). |
| `core-principles.md` | **Amend as part of implementation** | §11 carries the exact proposed text. It is deliberately **not** applied yet — amending an authoritative invariant doc to describe behavior that does not exist would make it false in the other direction. |
| Sequencing | **Design first, no code** | This document. Implementation is a follow-up. |

---

## 2. The correction that shapes this design

The integration analysis implied that pointing Paperclip at OpenPalm was mostly a
matter of choosing a base URL. Reading the adapter source shows that is **not**
true, and the difference drives the whole design.

Paperclip's `opencode_local` adapter **spawns the OpenCode CLI as a child
process** — `packages/adapters/opencode-local/src/server/execute.ts:576` builds
`opencode run --format json [--session …] [--model …]`. Its "remote" support
(`packages/adapter-utils/src/execution-target.ts`) means *running that CLI over
SSH or in a sandbox*, not *talking to an OpenCode HTTP server*. There is no
base-URL setting that makes it drive an existing OpenCode instance.

The built-in `http` adapter is not a substitute:
`server/src/adapters/http/execute.ts` fires a single POST and returns
`{exitCode: 0}` with no text, no usage, and no session — enough for a webhook
ping, useless as an agent runtime.

**Therefore there are two genuinely different integration modes**, and the addon
must name them honestly rather than present one knob that silently means
different things.

### Mode A — `api`: OpenPalm as a screened model gateway

Paperclip runs *its own* OpenCode CLI inside the Paperclip container (its
Dockerfile already installs the OpenCode, Claude, and Codex CLIs). Its **model
provider** is Guardian's OpenAI-compatible edge at `http://guardian:8182/v1`,
injected through `PAPERCLIP_OPENCODE_PROVIDERS`
(`packages/adapters/opencode-local/src/server/runtime-config.ts`).

- **Works today with zero new code in either project.**
- Every token crosses Guardian: content validation, rate limits, audit.
- **But** Paperclip's agents are *not* the OpenPalm assistant. They get no AKM
  memory, no persona, no `system/assistant` instructions. OpenPalm is reduced to
  a filtered LLM endpoint.

### Mode B — `assistant` / `guardian`: OpenPalm as the agent

A custom adapter drives an **OpenPalm assistant session** over the native
OpenCode HTTP API, so the agent has AKM memory, persona, and skills. This is
`@openpalm/paperclip-adapter`, Phase 2 of the integration analysis. Its target is
either:

- `assistant` → `http://assistant:4096` — no Guardian, no screening
- `guardian` → `http://guardian:8080/oc` — principal auth, ownership, rate
  limits, content validation

**Mode B requires the adapter package to exist.** It does not today. The addon
therefore ships with Mode A functional, Mode B's configuration surface defined
and validated, and the default flipping to `assistant` when the adapter lands
(§10).

This is the one place where the operator-facing model and the delivery schedule
disagree, and pretending otherwise would produce an addon whose default setting
does not work.

---

## 3. Classification: service addon, not a portal

A portal translates an **external protocol into Guardian** (`portal_net` only,
never `assistant_net`). Paperclip does the opposite: it is a **consumer** of the
assistant that also serves a web UI of its own.

Its precedent in the tree is `tunnel` (`services.compose.yml`), which joins both
`assistant_net` and `portal_net` and picks its target at runtime from
`OP_REMOTE_TARGET`, with network membership granting only "the reachability
either choice might need." Paperclip is the same shape.

Consequences:

- Defined in `services.compose.yml`, not `portals.compose.yml`.
- **Not** added to `GUARDIAN_INGRESS_ADDON_IDS` — enabling Paperclip must not
  force a Guardian deploy, because the default routing does not use it. Guardian
  deployment becomes routing-dependent instead (§7).
- **Is** added to `PORTAL_SECRET_ADDON_IDS`. The principal secret is minted
  whenever the addon is enabled and simply goes unused in `direct`/`api` mode.
  Minting unconditionally keeps `secrets-files.ts` and the secret audit's static
  file list honest; conditional minting would make the expected-file set depend
  on a runtime setting.

---

## 4. Compose services

Two new services in `packages/skeleton/system/stack/services.compose.yml`, both
gated `profiles: ["addon.paperclip"]`.

### `paperclip`

```yaml
image: ghcr.io/paperclipai/paperclip:${OP_PAPERCLIP_VERSION:?OP_PAPERCLIP_VERSION is required}
```

Upstream publishes `ghcr.io/paperclipai/paperclip` from `.github/workflows/docker.yml`
on tag pushes. **Available tags are `latest` and `sha-<commit>` only — no semver.**
So the pin in `state/stack.env` is a `sha-*` tag, ideally with an
`@sha256:` digest, matching how `ollama` is pinned in `services.compose.yml`.
`latest` must never be the default: image pins are release-controlled state, and
an unpinned third-party image would silently change what the stack runs.

| Concern | Value |
|---|---|
| Container port | `3100` |
| Host publication | `${OP_PAPERCLIP_BIND_ADDRESS:-127.0.0.1}:${OP_PAPERCLIP_PORT:-3840}:3100` |
| Networks | `assistant_net` and/or `portal_net`, per routing (§6) |
| Volumes | `${OP_HOME}/data/paperclip:/paperclip` |
| Secrets (compose names) | `paperclip_better_auth_secret`, `paperclip_tool_signing_secret`, `paperclip_db_password`, `portal_paperclip_secret`, `opencode_server_password`, `op_api_key` |
| `depends_on` | `paperclip-db: {condition: service_healthy}` only |

Host port `3840` is free in the documented `38xx` range (`3800` UI, `3810`
assistant, `3821` compatible API, `3830`/`3831` guardian, `3880` host admin).

**Why `opencode_server_password` is granted.** In `assistant` routing the
assistant accepts unauthenticated `assistant_net` calls *only while
`OPENCODE_AUTH=false`* — and `core.compose.yml` turns it on the moment the
operator enables the `assistantDirect` access toggle. A Paperclip that dialled
`assistant:4096` without a credential would therefore work until an unrelated
toggle flipped, then start 401-ing with no obvious cause. Granting the secret
and attaching Basic auth when `OPENCODE_AUTH=true` is exactly what Guardian does
for its own upstream calls (`portals.compose.yml`), and it makes the two toggles
independent, as they should be.

**No `depends_on` on `guardian` or `assistant`.** `services.compose.yml` already
documents why: guardian is profile-gated, and a `depends_on` naming a service
excluded by the active profile set is a project-level Compose *parse* error that
breaks `docker compose ps`/`down` for the entire stack. Paperclip retries its
upstream on its own.

### `paperclip-db`

`postgres:17-alpine`, pinned by digest. Data at
`${OP_HOME}/data/paperclip-db:/var/lib/postgresql/data`, per the rule that every
persistence-requiring container path is a bind into `data/`. **No `ports:`
block** — reachable only from the addon network. Password from
`paperclip_db_password`; `POSTGRES_PASSWORD_FILE` is used rather than a raw env
value, because `secret-audit.ts` rejects secret-like compose environment keys.

`DATABASE_URL` is the one wrinkle: Paperclip wants a single connection string
containing the password, which the secret audit will reject as an inline
credential. The entrypoint-free fix is to pass discrete `PG*` variables plus
`POSTGRES_PASSWORD_FILE` if Paperclip supports them; **if it only accepts
`DATABASE_URL`, this needs a small wrapper** — flagged as an open item in §12
rather than assumed away.

---

## 5. Configuration model

New leaf module `packages/lib/src/control-plane/paperclip-access.ts`, modelled
directly on `remote-access.ts`: browser-safe (no `node:*`), so the setup wizard
can import it via the `@openpalm/lib/control-plane/paperclip-access.js` subpath.

```ts
export type PaperclipRouting = "api" | "assistant" | "guardian";

export type PaperclipConfig = {
  /** How Paperclip reaches OpenPalm. */
  routing: PaperclipRouting;
  /** Publish the Paperclip web UI beyond loopback. */
  networkAccess: boolean;
};

/** Host-only, straight to the assistant — the safe default for a fresh install. */
export const PAPERCLIP_DEFAULTS: PaperclipConfig = {
  routing: "assistant",
  networkAccess: false,
};
```

**Stored intent, derived consequences** — the same split `access-toggles.ts`
enforces, and for the same reason recorded there: intent stored only as its own
consequences cannot be read back reliably.

| Stored intent key | Meaning |
|---|---|
| `OP_PAPERCLIP_ROUTING` | `api` \| `assistant` \| `guardian` |
| `OP_PAPERCLIP_NETWORK_ACCESS` | `true` \| `false` |

An absent `OP_PAPERCLIP_ROUTING` takes the default. An **explicitly present
invalid** value throws, exactly as `parseRemoteTarget` does — normalizing a typo
to a permissive value is how an unintended exposure happens.

### Derived env (`resolvePaperclipEnv`)

Every key written explicitly on every deploy. No cascade, no "unset means
inherit."

| Key | `api` | `assistant` | `guardian` |
|---|---|---|---|
| `OP_PAPERCLIP_BIND_ADDRESS` | `127.0.0.1` unless `networkAccess`, then `0.0.0.0` | ← same | ← same |
| `PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` unless exposed, then `authenticated` | ← same | ← same |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private` | ← same | ← same |
| `OP_PAPERCLIP_UPSTREAM` | `http://guardian:8182/v1` | `http://assistant:4096` | `http://guardian:8080/oc` |
| `OP_PAPERCLIP_NETWORKS` | `portal_net` | `assistant_net` | `portal_net` |
| `PRINCIPAL_ID` | `api` | *(unset)* | `paperclip` |

**The exposure/auth coupling is mechanical, not advisory.** Paperclip's own
`local_trusted` mode has no login (`doc/DEPLOYMENT-MODES.md`). Publishing that
beyond loopback would put an unauthenticated control plane on the LAN. So
`networkAccess: true` — or selecting Paperclip as a Tailscale target (§8) —
**forces** `authenticated`/`private`. The operator cannot express
"reachable and unauthenticated," which is the combination that would otherwise
be one checkbox away.

---

## 6. Network membership

Compose cannot make a service's `networks:` list conditional on an env var.
Two options:

**(a) Join both, always** — `networks: [assistant_net, portal_net]`, exactly what
`tunnel` does, with the routing setting deciding which one is *dialled*. Simple,
one file, no overlay; the cost is that a compromised Paperclip image can reach
the assistant even when configured for `guardian`.

**(b) Conditional overlay** — base membership is `portal_net`, and a
`paperclip.compose.direct.yml` overlay adds `assistant_net`, joining the compose
file list only when routing is `assistant`. Matches `voice.compose.lan.yml`
precisely, including its `ADDON_ENV_RECREATE_SCOPE` entry.

**Recommendation: (b).** The addon trust boundary at the top of
`services.compose.yml` exists specifically so "a compromised addon image cannot
reach the assistant's OpenCode API," and Paperclip is a large third-party
Node application with its own plugin system and npm-loaded adapters — a much
bigger attack surface than the Tailscale sidecar that motivated option (a).
Granting `assistant_net` only when the operator has actually chosen direct
routing keeps the grant matched to the intent. The cost is one more conditional
compose file and one more entry in the recreate-scope table.

---

## 7. Guardian deploy gating

`hasGuardianIngressAddon(enabledAddons)` currently answers from the addon list
alone. With routing as a setting, "is Guardian needed?" also depends on
`state/stack.env`.

Six call sites, all in `packages/lib/src/control-plane/`:

| File | Line | Role |
|---|---|---|
| `lifecycle.ts` | 66, 99, 468 | deploy set + expected-service seed |
| `deploy.ts` | 489 | activation/health wait |
| `addons.ts` | 515 | portal-secret provisioning |
| `access-apply.ts` | 129 | access-toggle apply |
| `remote-apply.ts` | 341 | tunnel target validation |
| `provider-import.ts` | 23 | restart-on-credential-change |

**Approach:** keep `addon-ids.ts` a pure-constants leaf (its header states it has
no imports so it can be imported anywhere without cycles). Add a **second
required parameter**:

```ts
export function hasGuardianIngressAddon(
  enabledAddons: Iterable<string>,
  env: Record<string, string | undefined>,
): boolean
```

Required, not optional-with-default. An optional parameter would let a call site
that forgets to pass `stack.env` silently answer "no Guardian needed" for a
`guardian`-routed install — the stack would come up without Guardian and every
Paperclip run would fail auth. Making it required turns that into a compile
error. All six sites already have `homeDir` in scope and already call
`listEnabledAddonIds(homeDir)`, so reading `stack.env` beside it is a one-line
change each.

`GUARDIAN_INGRESS_ADDON_IDS` itself stays unchanged, and the compose profile gate
on the `guardian` service is unchanged — Paperclip in `guardian` mode enables the
`gateway` profile the same way a community portal does
(`docs/portals/community-portals.md`).

---

## 8. Tailscale exposure

`remote-access.ts` already models exactly this. Extend it:

```ts
export const REMOTE_TARGETS = ["assistant", "guardian", "paperclip", "both", "all"] as const;

const TARGET_ENDPOINTS = {
  assistant: { port: 443,  proxy: "http://assistant:3000" },
  guardian:  { port: 8443, proxy: "http://guardian:3830"  },
  paperclip: { port: 9443, proxy: "http://paperclip:3100" },  // new
};
```

Port assignment is **stable per service and never reassigned**, per the existing
comment — so adding `paperclip` cannot move an operator's existing assistant or
guardian URL. `9443` continues the established `443` / `8443` progression.

`both` currently means `["assistant", "guardian"]` and is load-bearing in stored
configs, so it keeps that meaning; a new `all` value covers all three. Widening
`both` in place would silently expose Paperclip on the next apply for every
install that already stored `both` — precisely the class of change
`parseRemoteTarget` refuses to make.

The `tunnel` service already joins `assistant_net` and `portal_net`, so it can
reach `paperclip` under either routing with **no compose network change**.

Two required follow-ons:

- `ADDON_ENV_RECREATE_SCOPE` — `OP_PAPERCLIP_ROUTING` and
  `OP_PAPERCLIP_NETWORK_ACCESS` are baked in at container-create time and change
  the compose file list, so they need `["paperclip"]` (and `["tunnel"]` where the
  serve document changes), exactly like `OP_VOICE_LAN_ACCESS`.
- Selecting `paperclip` as a tunnel target must force
  `PAPERCLIP_DEPLOYMENT_MODE=authenticated` (§5). Tailscale Serve is
  device-scoped, but Funnel (`OP_REMOTE_PUBLIC=true`) is the public internet.

---

## 9. Screening

Per the decision in §1, this addon adds **no Guardian code**. The operator's
screening choice is expressed entirely by routing:

| Routing | Principal auth | Ownership | Rate limits | Content validation |
|---|---|---|---|---|
| `assistant` | none | none | none | **none** |
| `guardian` | yes | yes | yes | per `GUARDIAN_CONTENT_VALIDATION` (default on, fail-closed) |
| `api` | yes (`api` principal + `op_api_key`) | yes | yes | per `GUARDIAN_CONTENT_VALIDATION` |

**Known limitation, stated plainly:** `GUARDIAN_CONTENT_VALIDATION` is global.
An operator cannot screen Paperclip while leaving Discord unscreened, or the
reverse. The UI copy must not imply a per-addon scanning level exists.

The future extension — a `scan_level` column on Guardian's `principals` table
(`full` | `heuristic` | `off`), set through the loopback admin API and consulted
in `content-screen.ts` — is the right shape when this is revisited. It should
keep the global default on, keep `full` as the default for every new principal,
and audit every downgrade. It is deliberately out of scope here.

**The honest risk statement for `assistant` routing:** it is unscreened,
unauthenticated ingress to the assistant from a large third-party application
that runs npm-loaded adapter plugins. That is acceptable for an operator running
their own work on their own host, and it is why the default web UI exposure is
loopback. It stops being acceptable the moment Paperclip ingests untrusted
external content — GitHub issues, email, third-party tickets. Operators doing
that should use `guardian`, and the addon docs must say so at that level of
directness.

---

## 10. Delivery phases

**Phase 1 — addon skeleton, Mode A functional.**
`addon-ids.ts`, both compose services, `addon-env-schemas.ts` entry,
`paperclip-access.ts` + tests, secrets, guardian-gate threading, Tailscale
target, docs. Default routing ships as **`api`**, because it is the mode that
actually works. `assistant` and `guardian` are accepted, validated, and
documented as requiring the adapter.

**Phase 2 — `@openpalm/paperclip-adapter`.** Published to npm, implements
`ServerAdapterModule` over `/oc/*`. On landing, the default routing flips to
`assistant` and this document's §5 default becomes true.

**Phase 3 — admin UI.** Addon panel for routing, exposure, and Tailscale target;
setup-wizard surfacing. Until then the addon is configured through `stack.env`
and the CLI, which is the documented management path anyway.

---

## 11. Proposed `core-principles.md` amendment

Approved by the maintainer, **to be applied with the Phase 1 implementation**,
not before.

§2 (*Guardian-only ingress*) currently reads, in part: "Every portal request
enters Guardian; no portal communicates directly with the assistant." Append:

> **Operator-trusted in-stack consumers.** A first-party *service* addon that
> the operator explicitly enables may be granted `assistant_net` and dial
> `assistant:4096` directly, without Guardian. This is distinct from a portal:
> a portal carries traffic from an external protocol and untrusted third-party
> users, and has no direct path. A service addon runs on the operator's own
> host and carries the operator's own work. The grant is per-service, requires
> an explicit routing choice, and is expressed as a conditional Compose overlay
> so the network membership matches the stated intent. `paperclip` is the first
> such addon; see `paperclip-addon-design.md`.

§Service port assignments — add:

| Service | Internal | Default host bind | Purpose |
|---|---|---|---|
| **Paperclip** | 3100 | `127.0.0.1:3840` (`OP_PAPERCLIP_BIND_ADDRESS`) | Agent-management control plane (addon) |
| **Paperclip DB** | 5432 | *(none — never published)* | Postgres for the Paperclip addon |

---

## 12. Open items

1. **`DATABASE_URL` vs. the secret audit.** If Paperclip accepts only a
   password-bearing connection string, satisfying `secret-audit.ts` needs either
   a discrete-`PG*` path upstream or a thin entrypoint wrapper. Resolve before
   Phase 1 — it decides whether this addon can use the upstream image unmodified.
2. **Image pinning cadence.** Upstream publishes only `latest` and `sha-*`.
   Pinning a digest is correct but means OpenPalm releases carry a manual bump
   with no upstream semver to track.
3. **Telemetry.** Paperclip enables anonymous telemetry by default. The shipped
   compose block should set `PAPERCLIP_TELEMETRY_DISABLED=1` — OpenPalm's stated
   posture is private and self-hosted, and an addon that silently phones home
   would contradict it. Operators can turn it back on.
4. **Resource footprint.** Node + Postgres + agent CLIs is a significant step up
   from the current stack. `docs/system-requirements.md` needs a line.
5. **Backup scope.** `data/paperclip-db/` is service-owned data, excluded from
   lifecycle safety backups by the existing rule. A Postgres volume that is not
   backed up may surprise operators; consider documenting `pg_dump` guidance
   rather than changing backup scope.

---

## 13. Verification plan

Per the delivery checklist in `AGENTS.md`:

- `bun run test` — `paperclip-access.test.ts` covering: default config; invalid
  `OP_PAPERCLIP_ROUTING` throws; derived env per routing mode; exposure forcing
  `authenticated`; round-trip through `readPaperclipConfig`/`resolvePaperclipEnv`.
- Extend `network-contract.test.ts` and `addon-network-boundary.test.ts` — assert
  Paperclip has `assistant_net` **only** under `assistant` routing.
- Extend `remote-access.test.ts` — `paperclip` target derives port `9443`;
  existing `both` configs still resolve to assistant+guardian only.
- Extend `compose-contract.test.ts` / `skeleton-guardrail.test.ts` — profile gate,
  no `depends_on` on profile-gated services, no published DB port.
- `secret-audit.ts` must pass with the new secrets — the real gate on open item 1.
- `bun run lint`, `bun run check`.
- Manual: enable the addon, confirm `http://127.0.0.1:3840` is reachable and
  `http://<lan-ip>:3840` is not; flip `OP_PAPERCLIP_NETWORK_ACCESS=true`, apply,
  confirm the reverse and that Paperclip now demands a login.
- Manual (Mode A): create a Paperclip company, configure an agent with
  `opencode_local` against the injected `http://guardian:8182/v1` provider, run
  one heartbeat, and confirm the request appears in
  `data/logs/guardian-audit.log`.
