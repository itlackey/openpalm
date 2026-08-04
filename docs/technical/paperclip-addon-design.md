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
nothing new is screened unless the operator asks for it. (That is the end-state
default; Phase 1 ships `api` routing as the effective default until the adapter
that makes direct access executable exists — §2, §6, §12.)

It also introduces one stack-wide change that is not Paperclip-specific: a global
`OP_TELEMETRY` toggle, off by default (§11).

---

## 1. Decisions already taken

| Decision | Choice | Consequence |
|---|---|---|
| Scanning granularity | **Reuse the existing global toggle** | No Guardian code changes. `GUARDIAN_CONTENT_VALIDATION` keeps its current semantics; routing choice *is* the scanning choice. Per-principal levels are a documented future extension (§10). |
| `core-principles.md` | **Amend as part of implementation** | §13 carries the exact proposed text. It is deliberately **not** applied yet — amending an authoritative invariant doc to describe behavior that does not exist would make it false in the other direction. |
| Sequencing | **Design first, no code** | This document. Implementation is a follow-up. |
| Paperclip's own config/DB | **Documented deviation from the secret pattern** | Paperclip owns its Postgres and its internal secrets through one `env_file` under `private/env/`. Uses the upstream image unmodified, no wrapper. Narrowly exempted in `secret-audit.ts` (§5). |
| Telemetry | **Global `OP_TELEMETRY`, default `false`** | Stack-wide opt-in toggle, off by default, applied to assistant, guardian, and paperclip (§11). |

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
(§12).

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
- **Not** added to `GUARDIAN_INGRESS_ADDON_IDS` — whether Paperclip needs the
  guardian depends on `OP_PAPERCLIP_ROUTING`, which a static ID list cannot
  express: membership would force a guardian deploy even under `assistant`
  routing, where nothing dials it. Guardian deployment becomes
  routing-dependent instead — `api` and `guardian` routing require it,
  `assistant` does not (§8).
- **Is** added to `PORTAL_SECRET_ADDON_IDS`. The principal secret is minted
  whenever the addon is enabled and simply goes unused in `assistant`/`api`
  routing. Minting unconditionally keeps `secrets-files.ts` and the secret
  audit's static file list honest; conditional minting would make the
  expected-file set depend on a runtime setting.

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
| Networks | `portal_net` always; `assistant_net` by overlay under `assistant` routing (§7) |
| Volumes | `${OP_HOME}/data/paperclip:/paperclip` |
| `env_file` | `${OP_HOME}/private/env/paperclip.env` — Paperclip's own config and internal secrets (§5) |
| Secrets (compose names) | `portal_paperclip_secret`, `opencode_server_password` — file-consumable only by `@openpalm/paperclip-adapter`, which is our code (§5 explains why `op_api_key` cannot be delivered this way) |
| `depends_on` | `paperclip-db: {condition: service_healthy}` only |
| `user` | `"${OP_UID:-1000}:${OP_GID:-1000}"` — upstream's `docker-entrypoint.sh` detects a non-root start and execs directly, so this composes with the repo's rootless posture; the data dirs are pre-created operator-owned by `ensureHomeDirs` like every other bind |
| Logging / health | repo-standard `json-file` caps — `max-size: "10m"`, `max-file: "3"` (30 MB/service ceiling; Docker's default driver is unbounded and every other service in this compose file already sets this cap); portal-style TCP healthcheck on `3100` with `start_period` |

Host port `3840` is free in the documented `38xx` range (`3800` UI, `3810`
assistant, `3821` compatible API, `3830`/`3831` guardian, `3880` host admin).

**Non-secret compose environment.** These live in the compose block, not the
env file:

```yaml
environment:
  # REQUIRED: upstream defaults its bind to 127.0.0.1 (server/src/config.ts —
  # `process.env.HOST ?? fileConfig?.server.host ?? "127.0.0.1"`). A
  # loopback-bound process inside the container is unreachable through the
  # host port mapping AND from the tunnel sidecar — the addon would deploy
  # healthy-looking and serve nothing. In-container bind is not exposure:
  # who can reach it is governed by the host publication bind and network
  # membership, the same split the assistant uses (opencode.jsonc binds
  # 0.0.0.0; OP_ASSISTANT_BIND_ADDRESS controls publication). Upstream's own
  # Docker quickstart (doc/DOCKER.md) sets HOST=0.0.0.0 for the same reason.
  HOST: 0.0.0.0
  PORT: "3100"
  PAPERCLIP_HOME: /paperclip
  SERVE_UI: "true"
  PAPERCLIP_DEPLOYMENT_MODE: ${OP_PAPERCLIP_DEPLOYMENT_MODE:-local_trusted}   # derived, §6
  PAPERCLIP_DEPLOYMENT_EXPOSURE: ${OP_PAPERCLIP_DEPLOYMENT_EXPOSURE:-private} # derived, §6/§9
  PAPERCLIP_PUBLIC_URL: ${OP_PAPERCLIP_PUBLIC_URL:-http://127.0.0.1:3840}     # derived, §6/§9
  PAPERCLIP_ALLOWED_HOSTNAMES: ${OP_PAPERCLIP_ALLOWED_HOSTNAMES:-}            # derived, §6/§9
  PAPERCLIP_TELEMETRY_DISABLED: ${OP_TELEMETRY_DISABLED:-1}                   # §11
  DO_NOT_TRACK: ${OP_TELEMETRY_DISABLED:-1}                                   # §11
```

**Guardian-side change (Mode B `guardian` routing).** Guardian seeds principals
from `PORTAL_<ID>_SECRET_FILE` variables at boot, so the guardian service in
`portals.compose.yml` gains `PORTAL_PAPERCLIP_SECRET_FILE:
/run/secrets/portal_paperclip_secret` plus the matching secret grant, exactly
mirroring the existing chat/api/discord/slack entries. Without this, the
`paperclip` principal never exists and every adapter call 401s.

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
block** — never published, reachable only from the addon's own network. It reads
the same `env_file` (§5) for `POSTGRES_USER` / `POSTGRES_PASSWORD` /
`POSTGRES_DB`.

The two services share one Postgres and one credential file because they are a
single trust domain: `paperclip-db` exists only to serve `paperclip`, and
splitting the file would add a second thing to keep in sync for no boundary gain.

---

## 5. Paperclip's own config — a documented deviation

Paperclip wants a `DATABASE_URL` connection string with the password inline, plus
`BETTER_AUTH_SECRET` and `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` as ordinary
environment values. Both collide with the standard pattern:
`secret-audit.ts:202` bans `env_file` on **every** service, and `:211` rejects
secret-like environment keys, requiring a `*_FILE` indirection the upstream image
does not implement.

Rather than wrap the upstream image, the addon takes an explicit, narrow
exception.

### The file

**`~/.openpalm/private/env/paperclip.env`**, mode `0600`, in a new `env/`
subtree under `private/`.

`private/` is the right tree and not a compromise: it is already the delegated-
credential boundary — never bind-mounted into assistant `/stash`, `0700`
directories, `0600` files, included in backups and `--purge`, excluded from the
assistant's mounts. A secret-bearing env file belongs there, not in `config/`
(user, non-secret by convention) or `state/stack.env` (explicitly non-secret, and
Compose's global `--env-file`, so anything in it would reach every service).

Generated content, seeded once on `openpalm addon enable paperclip`:

```sh
POSTGRES_USER=paperclip
POSTGRES_DB=paperclip
POSTGRES_PASSWORD=<randomHex(32)>
DATABASE_URL=postgres://paperclip:<same>@paperclip-db:5432/paperclip
BETTER_AUTH_SECRET=<randomHex(32)>
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=<randomHex(32)>

# Mode A (`api` routing): the OpenPalm provider, injected into every
# opencode_local agent run by Paperclip's own runtime-config mechanism. The
# seeder runs ensureSecret("op_api_key") first, so enabling paperclip creates
# the key even when no other API consumer ever has. Block shape sketched —
# the exact provider schema is OpenCode's `provider` config, validated in
# Phase 1 against the pinned versions.
OPENPALM_API_KEY=<value of private/secrets/op_api_key>
PAPERCLIP_OPENCODE_PROVIDERS={"openpalm":{"options":{"baseURL":"http://guardian:8182/v1","apiKey":"{env:OPENPALM_API_KEY}"}}}
```

Values come from `randomHex` (`packages/lib/src/control-plane/crypto.ts`), the
same CSPRNG helper behind every other generated credential. **Seed-if-missing,
never regenerate** — matching `ensurePortalSecret`, so an operator edit or a
restored backup survives an apply. Regenerating would silently orphan the
existing Postgres volume and invalidate every Paperclip session.

**Why the compatible-API key is *in* this file rather than a compose secret.**
This is forced, not a style choice. Compose secrets materialize as files under
`/run/secrets/`, and upstream Paperclip reads no credential from a file: its
provider-config expansion resolves `{env:VAR}` placeholders **from the process
environment only** (`packages/adapters/opencode-local/src/server/runtime-config.ts`,
`expandEnvPlaceholders`). A file grant of `op_api_key` would sit unread while
every Mode A run failed 401. So the seeder copies the `op_api_key` value into
`OPENPALM_API_KEY` here, and the provider JSON references it. Two consequences,
both handled:

- **Rotation coupling.** Rotating `private/secrets/op_api_key` must rewrite
  this file's `OPENPALM_API_KEY` line and recreate `paperclip` — the same
  write-then-recreate shape as `OP_REMOTE_*`, recorded in
  `ADDON_ENV_RECREATE_SCOPE`. The secret-rotation path gains one consumer.
- **The exception wording widens by one clause** (below): the file holds what
  Paperclip issues to itself *plus* control-plane-written provider config that
  must embed an OpenPalm-issued key because the image cannot read file secrets.

The Mode B credentials do **not** follow this pattern: `portal_paperclip_secret`
and `opencode_server_password` are consumed by `@openpalm/paperclip-adapter`,
which is our code running inside the Paperclip server process — it reads
`/run/secrets/*` files directly, so those stay ordinary compose secrets.

### The audit exception

`auditComposeSecrets` gains a named allowlist beside its existing per-service
rules, which already use exactly this shape (`allowedSecretForService` carries
per-service branches with WHY comments):

```ts
/**
 * Services permitted to use `env_file`, and the ONE path they may read.
 *
 * The blanket env_file ban exists so a service cannot be handed a broad
 * credential surface it has no role in. `paperclip` is a third-party image
 * that accepts a password-bearing DATABASE_URL and two raw secret env values
 * and implements no *_FILE indirection, so the standard pattern would require
 * wrapping an upstream image we do not build. The exception is bounded on
 * three axes instead: only these services, only a path under private/env/,
 * and only (a) credentials Paperclip issues to ITSELF plus (b) the
 * control-plane-written provider block, which embeds the compatible-API key
 * because upstream resolves {env:} placeholders from the environment only
 * and reads no file secret. Credentials consumed by OUR adapter code —
 * the guardian principal secret, the OpenCode server password — stay
 * ordinary compose secrets with the normal boundary check.
 */
const ENV_FILE_EXEMPT: Record<string, string> = {
  paperclip: "private/env/paperclip.env",
  "paperclip-db": "private/env/paperclip.env",
};
```

The audit still fails on: `env_file` from any other service, an exempt service
pointing at a different path, and more than one `env_file` entry.

**What this exception is not.** It does not widen `state/stack.env`, does not put
a secret in `config/`, does not grant Paperclip a secrets *directory*, and does
not change the rule for any other service. The file-consumable OpenPalm-issued
credentials still arrive as narrowly granted compose secrets, so
`allowedSecretForService` gains a `paperclip` branch permitting exactly
`portal_paperclip_secret` and `opencode_server_password` — `op_api_key` is
deliberately absent from the grant list because a file grant is unreadable to
upstream (see above); its delivery path is this env file.

---

## 6. Configuration model

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

/**
 * Host-only web UI always. Routing default is PHASED (§12): the end state —
 * the operator requirement — is "assistant" (direct, unscreened, host-only).
 * Until @openpalm/paperclip-adapter exists, "assistant" cannot execute a
 * single agent run, so Phase 1 ships "api" as the default and flips this
 * constant in the same release that ships the adapter.
 */
export const PAPERCLIP_DEFAULT_ROUTING: PaperclipRouting = "api"; // Phase 2: "assistant"

export const PAPERCLIP_DEFAULTS: PaperclipConfig = {
  routing: PAPERCLIP_DEFAULT_ROUTING,
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
inherit." The signature takes the remote-access config too —
`resolvePaperclipEnv(cfg, { remoteTargetIncludesPaperclip })` — because tailnet
exposure (§9) forces the same auth posture as LAN exposure.

| Key | `api` | `assistant` | `guardian` |
|---|---|---|---|
| `OP_PAPERCLIP_BIND_ADDRESS` | `127.0.0.1` unless `networkAccess`, then `0.0.0.0` | ← same | ← same |
| `OP_PAPERCLIP_DEPLOYMENT_MODE` | `local_trusted` unless exposed (LAN **or** tailnet target), then `authenticated` | ← same | ← same |
| `OP_PAPERCLIP_DEPLOYMENT_EXPOSURE` | `private`; `public` when the tunnel target includes paperclip **and** `OP_REMOTE_PUBLIC=true` (Funnel = open internet) — upstream disables the browser first-admin claim only in `authenticated/public`, so mislabeling a Funnel deployment `private` would leave instance-claim open to the internet | ← same | ← same |
| `OP_PAPERCLIP_PUBLIC_URL` | `http://127.0.0.1:3840` when loopback; tailnet URL per §9 | ← same | ← same |
| `OP_PAPERCLIP_ALLOWED_HOSTNAMES` | empty when loopback; §9 fills it on exposure | ← same | ← same |
| `OP_PAPERCLIP_UPSTREAM` | `http://guardian:8182/v1` *(informational — the provider block in `paperclip.env` carries the URL Mode A actually uses)* | `http://assistant:4096` | `http://guardian:8080/oc` |
| `PRINCIPAL_ID` | *(unset — the guardian's own API edge acts as the `api` principal)* | *(unset)* | `paperclip` |
| Compose file list | base | base + `paperclip.compose.direct.yml` (§7) | base |

`PRINCIPAL_ID`/`PRINCIPAL_SECRET_FILE` and `OP_PAPERCLIP_UPSTREAM` are consumed
by `@openpalm/paperclip-adapter` as its defaults (Mode B); nothing upstream
reads them. Network membership is **not** an env value — Compose cannot select
`networks:` from a variable — so the routing choice reaches the network layer
as a compose *file-list* change, the same mechanism as `voice.compose.lan.yml`.

**The exposure/auth coupling is mechanical, not advisory.** Paperclip's own
`local_trusted` mode has no login (`doc/DEPLOYMENT-MODES.md`). Publishing that
beyond loopback would put an unauthenticated control plane on the LAN. So
`networkAccess: true` — or selecting Paperclip as a Tailscale target (§9) —
**forces** `authenticated`/`private`. The operator cannot express
"reachable and unauthenticated," which is the combination that would otherwise
be one checkbox away.

**What the flip means in practice** (verified against upstream
`doc/DEPLOYMENT-MODES.md` §7–8 and `server/src/auth/better-auth.ts`):

- A fresh `authenticated` instance starts in `bootstrap_pending`; the first
  browser session on the private network claims it ("Claim this instance" →
  `instance_admin`). An instance that ran `local_trusted` first migrates
  without lockout — the claiming user is promoted and existing companies keep
  an active owner.
- Better Auth validates request origins against `deriveAuthTrustedOrigins`,
  which is fed by `PAPERCLIP_PUBLIC_URL` and `PAPERCLIP_ALLOWED_HOSTNAMES`
  (comma-separated; port variants are added automatically for non-443 ports).
  This is why both are derived keys here rather than operator homework: LAN
  exposure writes the host identities OpenPalm already advertises for its own
  UI (`<name>.local`; the machine hostname), and the addon env schema leaves
  the key operator-extendable for raw-IP access.
- **Claim race, stated honestly:** between the apply that widens the bind and
  the operator's first login, anyone on the LAN/tailnet could register and
  claim the instance. The addon docs must say: claim it immediately, and set
  `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` (a real upstream key,
  `server/src/config.ts`) once your account exists. Tailscale Serve narrows
  this to the operator's own devices; plain LAN does not.

---

## 7. Network membership

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

## 8. Guardian deploy gating

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

Inside the new signature, the routing test itself lives in
`paperclip-access.ts` as one pure helper so the definition exists exactly once:

```ts
/** True when the stored routing needs a deployed guardian: `api` and `guardian`. */
export function paperclipRequiresGuardian(env: Record<string, string | undefined>): boolean;
```

`api` routing needs the guardian just as much as `guardian` routing does — the
compatible edge is a co-process *inside the guardian container*
(`containers/guardian/entrypoint.sh` spawns `openai-api-server.ts` on
`GUARDIAN_OPENAI_PORT`), so there is no edge without the container. Its listener
is `Bun.serve({ port })` with no hostname — all interfaces — which is what makes
`http://guardian:8182/v1` reachable from `portal_net` with **no host port and no
access toggle involved**; the loopback-published `3821` and the
`guardianOpenaiApi` toggle govern LAN callers only, not in-stack ones.

**Profile activation is the second half of the gate.** The guardian service's
compose profiles are `[addon.chat, addon.api, addon.discord, addon.slack,
addon.gateway]`; `addon.paperclip` is deliberately not added to that list (it
would deploy the guardian even under `assistant` routing). Instead the control
plane's profile resolution — where `OP_ENABLED_ADDONS` becomes `--profile`
arguments (`compose-args.ts`) — appends `addon.gateway` when
`paperclipRequiresGuardian(env)` holds, the same profile a community portal
enables by hand (`docs/portals/community-portals.md`). Gate and profile set must
answer from the same helper, or the deploy set and the health-wait can disagree
about whether a guardian exists.

`GUARDIAN_INGRESS_ADDON_IDS` itself stays unchanged.

---

## 9. Tailscale exposure

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

Four required follow-ons:

- `ADDON_ENV_RECREATE_SCOPE` — `OP_PAPERCLIP_ROUTING` and
  `OP_PAPERCLIP_NETWORK_ACCESS` are baked in at container-create time and change
  the compose file list, so they need `["paperclip"]` (and `["tunnel"]` where the
  serve document changes), exactly like `OP_VOICE_LAN_ACCESS`.
- Selecting `paperclip` as a tunnel target must force
  `PAPERCLIP_DEPLOYMENT_MODE=authenticated` (§6). Tailscale Serve is
  device-scoped; Funnel (`OP_REMOTE_PUBLIC=true`) is the public internet and
  additionally forces `OP_PAPERCLIP_DEPLOYMENT_EXPOSURE=public`, which is what
  makes upstream disable the browser first-admin claim (§6 — the correct
  hardening for an internet-reachable instance).
- **Target validation**, mirroring the existing guardian rule at
  `remote-apply.ts:341` (a guardian target requires a guardian-ingress addon):
  a target set including `paperclip` fails validation unless the `paperclip`
  addon is enabled — otherwise the tunnel proxies to a service that does not
  exist and every request 502s with nothing in the stack explaining why.
- **Origin trust for the tailnet URL.** The browser reaches Paperclip at
  `https://<node>.<tailnet>.ts.net:9443`, and Better Auth rejects origins it
  was not told about (§6). The hostname *label* is known statically
  (`resolveRemoteHostname`), but the full `ts.net` FQDN exists only after the
  node joins the tailnet. The apply path therefore reads it the way the
  operator docs already do — `docker compose exec -T tunnel tailscale
  --socket=/tmp/tailscaled.sock status --json` (the exact invocation documented
  on the tunnel service) — then writes `OP_PAPERCLIP_PUBLIC_URL=https://<fqdn>:9443`,
  appends the FQDN to `OP_PAPERCLIP_ALLOWED_HOSTNAMES`, and recreates
  `paperclip`. First bring-up ordering makes this a second step of the same
  apply (tunnel up → read FQDN → write + recreate), the write-then-recreate
  shape `OP_REMOTE_*` already uses; until it runs, the tailnet UI answers but
  login is refused — fail-closed, not open.

---

## 10. Screening

Per the decision in §1, this addon adds **no Guardian code**. The operator's
screening choice is expressed entirely by routing:

| Routing | Principal auth | Ownership | Rate limits | Content validation |
|---|---|---|---|---|
| `assistant` | none | none | none | **none** |
| `guardian` | yes | yes | yes | per `GUARDIAN_CONTENT_VALIDATION` (default on, fail-closed) |
| `api` | yes — Paperclip authenticates with the `op_api_key` API key; the edge then acts as the `api` principal toward `/oc` | yes | yes | per `GUARDIAN_CONTENT_VALIDATION` |

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

## 11. Telemetry — the global `OP_TELEMETRY` toggle

Paperclip enables anonymous usage telemetry by default. Rather than hard-code
`PAPERCLIP_TELEMETRY_DISABLED=1` in one compose block, this addon introduces a
**stack-wide** toggle, because the problem is not Paperclip-specific: the
assistant already installs optional third-party CLIs on demand
(`install-optional-tool`: gcloud, gws, codex, claude, copilot, pi), several of
which phone home with their own defaults.

### Model

New leaf module `packages/lib/src/control-plane/telemetry.ts`, browser-safe, so
the setup wizard can import it the same way it imports `access-toggles.ts`.

```ts
/** Stored intent. Opt-IN: absent or false means no telemetry anywhere. */
export const TELEMETRY_INTENT_KEY = "OP_TELEMETRY";
export const TELEMETRY_DEFAULT = false;

/** Derived, written explicitly on every apply. */
export const TELEMETRY_ENV_KEYS = ["OP_TELEMETRY_DISABLED", "DO_NOT_TRACK"] as const;

export function readTelemetryEnabled(env: Record<string, string | undefined>): boolean;
export function resolveTelemetryEnv(enabled: boolean): Record<string, string>;
```

`resolveTelemetryEnv(false)` → `{ OP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" }`.

**Why a derived inverted key rather than using `OP_TELEMETRY` directly in
Compose.** Compose interpolation supports `${VAR:-default}` and nothing else —
there is no negation. Every consumer expects the *disabled* polarity
(`PAPERCLIP_TELEMETRY_DISABLED`, `DO_NOT_TRACK`), so the inversion has to happen
somewhere. Doing it once in the control plane and writing the result is the same
stored-intent/derived-row split `access-toggles.ts` already uses, and for the
same stated reason: intent stored only as its own consequences cannot be read
back reliably.

`DO_NOT_TRACK` is emitted alongside because it is the cross-vendor convention
(consoledonottrack.com) that Paperclip and several of the optional CLIs already
honour — one stored intent, two derived spellings, no per-tool table to maintain.

### Application

Compose blocks reference the derived key with a **fail-safe default**:

```yaml
environment:
  DO_NOT_TRACK: ${OP_TELEMETRY_DISABLED:-1}
  PAPERCLIP_TELEMETRY_DISABLED: ${OP_TELEMETRY_DISABLED:-1}   # paperclip only
```

Defaulting the interpolation to `1` means an install that predates this key —
or a hand-run `docker compose` without the generated row — gets telemetry
**off**, not on. The unset case must never be the permissive one.

Applied to `assistant`, `guardian`, and `paperclip`. The assistant is the one
that matters most in practice: it is where third-party CLIs get installed and
run.

### Scope, stated honestly

- OpenPalm itself ships **no** telemetry. This toggle governs third-party
  software running inside the stack; it is not a claim that OpenPalm collected
  anything before.
- It is **best-effort**. It sets the documented opt-out for tools that honour
  one. It cannot guarantee a given image respects it, and the docs must not
  imply otherwise.
- Turning it on (`OP_TELEMETRY=true`) is a per-install operator choice that
  propagates to every consumer at once, which is the point.
- `OP_TELEMETRY` and its derived keys are non-secret and live in
  `state/stack.env` with the rest of the generated access row.

---

## 12. Delivery phases

**Phase 1 — addon skeleton, Mode A functional.**
`addon-ids.ts`, both compose services plus the guardian-side
`PORTAL_PAPERCLIP_SECRET_FILE` wiring (§4), the `paperclip.compose.direct.yml`
overlay (§7), `addon-env-schemas.ts` entry, `paperclip-access.ts`
(+ `paperclipRequiresGuardian`) + tests, the `private/env/paperclip.env` seeder
and its `secret-audit.ts` exemption, `telemetry.ts` + the derived row across
assistant/guardian/paperclip, guardian-gate + profile-resolution threading (§8),
Tailscale target incl. FQDN → `PAPERCLIP_PUBLIC_URL` apply step (§9), docs.
Default routing ships as **`api`**, because it is the mode that actually works.
`assistant` and `guardian` are accepted, validated, and documented as requiring
the adapter.

`telemetry.ts` is independent of everything else here and could land first as a
small standalone change — it touches only `state/stack.env` generation and three
compose environment blocks, and it is useful with or without Paperclip.

**Phase 2 — `@openpalm/paperclip-adapter`.** Published to npm, implements
`ServerAdapterModule` over `/oc/*`. On landing, the default routing flips to
`assistant` and this document's §6 default becomes true.

**Phase 3 — admin UI.** Addon panel for routing, exposure, and Tailscale target;
setup-wizard surfacing. Until then the addon is configured through `stack.env`
and the CLI, which is the documented management path anyway.

---

## 13. Proposed `core-principles.md` amendment

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

§ *Filesystem contract → 2b) Private credentials* states that "the secret audit
rejects broad service env files, raw secret-like environment values, and grants
outside a service's role," and § *Addon secret lifecycle* repeats it as "Compose
services must not use broad `env_file`." Both need the same appended carve-out:

> **Named `env_file` exemption.** A third-party addon image that accepts
> credentials only as plain environment values, and implements no `*_FILE`
> indirection, may read exactly one env file under `private/env/`. The
> exemption is per-service and per-path, declared in `secret-audit.ts`, and
> covers credentials that addon issues to *itself*, plus control-plane-written
> configuration that must embed an OpenPalm-issued value because the image
> cannot read file secrets (for `paperclip`: the compatible-API key inside its
> provider block). Credentials consumed by OpenPalm-authored code in the
> container — principal secrets, the OpenCode server password — remain
> narrowly granted Compose secrets under the normal boundary check.
> `paperclip` is the first such addon.

§Filesystem contract, table row for `private/` — extend the Contents column:

> Delegated UI/OpenCode/Guardian/API/portal/bot credentials; `env/` holds
> per-addon env files for images that cannot consume file-based secrets. Never
> part of assistant `/stash`.

§Service port assignments — add:

| Service | Internal | Default host bind | Purpose |
|---|---|---|---|
| **Paperclip** | 3100 | `127.0.0.1:3840` (`OP_PAPERCLIP_BIND_ADDRESS`) | Agent-management control plane (addon) |
| **Paperclip DB** | 5432 | *(none — never published)* | Postgres for the Paperclip addon |

§Operational behavior — add:

> **Telemetry is opt-in.** `OP_TELEMETRY` defaults to `false` and generates
> `OP_TELEMETRY_DISABLED` / `DO_NOT_TRACK` into the services that run
> third-party software. OpenPalm itself sends no telemetry; this toggle governs
> what the stack's third-party images and on-demand CLIs do.

---

## 14. Open items

1. **Image pinning cadence.** Upstream publishes only `latest` and `sha-*`.
   Pinning a digest is correct but means OpenPalm releases carry a manual bump
   with no upstream semver to track.
2. **Resource footprint.** Node + Postgres + agent CLIs is a significant step up
   from the current stack. `docs/system-requirements.md` needs a line.
3. **Backup scope.** `data/paperclip-db/` is service-owned data, excluded from
   lifecycle safety backups by the existing rule. A Postgres volume that is not
   backed up may surprise operators; consider documenting `pg_dump` guidance
   rather than changing backup scope. Note that `private/env/paperclip.env`
   **is** in backup scope (it is under `private/`), so a restore that brings back
   the credentials without the database is a plausible and confusing state —
   worth one line in the addon docs.
4. **`OP_TELEMETRY` for existing installs.** The key is absent on every current
   install. The compose fallback (`${OP_TELEMETRY_DISABLED:-1}`) makes that safe,
   but the apply path should still write the derived row so `stack.env` reflects
   reality rather than relying on the fallback.
5. **First-admin claim race** (§6). Between the exposure apply and the
   operator's first login, an `authenticated` instance in `bootstrap_pending`
   can be claimed by anyone who can reach it. Decide during Phase 3 whether the
   UI should force the claim step into the exposure flow (e.g. refuse to widen
   the bind until an admin account exists); until then it is an addon-docs
   warning plus `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` guidance.
6. **Model list for the Mode A provider.** The seeded provider block gives
   Paperclip the endpoint and key; which model IDs the edge exposes to
   `opencode models` inside the Paperclip container needs a Phase 1 check, and
   the addon docs need the agent-side `model: openpalm/<id>` convention spelled
   out.

*(Resolved since the first draft: `DATABASE_URL` vs. the secret audit and
compatible-API-key delivery — §5; Paperclip telemetry — §11; container user
remapping — upstream's `docker-entrypoint.sh` execs unprivileged starts
directly, so the repo-standard `user:` line composes with it, §4; LAN/tailnet
login origins — derived `PAPERCLIP_PUBLIC_URL`/`PAPERCLIP_ALLOWED_HOSTNAMES`,
§6/§9.)*

---

## 15. Verification plan

Per the delivery checklist in `AGENTS.md`:

- `bun run test` — `paperclip-access.test.ts` covering: default config; invalid
  `OP_PAPERCLIP_ROUTING` throws; derived env per routing mode; exposure (LAN
  **and** tailnet-target) forcing `authenticated`; `paperclipRequiresGuardian`
  true for `api`/`guardian`, false for `assistant`; round-trip through
  `readPaperclipConfig`/`resolvePaperclipEnv`.
- Extend `network-contract.test.ts` and `addon-network-boundary.test.ts` — assert
  Paperclip has `assistant_net` **only** when the `assistant`-routing overlay is
  in the file list, and that the base compose sets `HOST: 0.0.0.0` on the
  `paperclip` service (upstream's loopback default would make the addon deploy
  healthy and serve nothing — §4).
- Extend `remote-access.test.ts` — `paperclip` target derives port `9443`;
  existing `both` configs still resolve to assistant+guardian only; a target set
  with `paperclip` fails validation when the addon is disabled.
- Extend `compose-contract.test.ts` / `skeleton-guardrail.test.ts` — profile gate,
  no `depends_on` on profile-gated services, no published DB port; the effective
  profile set includes `addon.gateway` iff `paperclipRequiresGuardian` (§8).
- Extend `secret-audit.test.ts` — the exemption is narrow, not a hole. Assert:
  `env_file` on any non-exempt service still fails; an exempt service pointing at
  a path outside `private/env/` fails; a second `env_file` entry fails;
  `allowedSecretForService('paperclip', …)` permits exactly
  `portal_paperclip_secret` and `opencode_server_password` (and rejects
  `op_api_key` — its delivery path is the env file, §5); and
  `private/env/paperclip.env` is enforced `0600`.
- `telemetry.test.ts` — default is disabled; `resolveTelemetryEnv(false)` emits
  `"1"` for both keys; `readTelemetryEnabled({})` is `false`; an explicit
  `OP_TELEMETRY=true` round-trips. Plus a compose assertion that every
  `DO_NOT_TRACK` / `*_TELEMETRY_DISABLED` interpolation defaults to `1`, so a
  missing key can never mean "on."
- `bun run lint`, `bun run check`.
- Manual: enable the addon, confirm `http://127.0.0.1:3840` is reachable and
  `http://<lan-ip>:3840` is not; flip `OP_PAPERCLIP_NETWORK_ACCESS=true`, apply,
  confirm the reverse, that Paperclip now demands a login, and that the
  first-login "Claim this instance" step lands the operator as instance admin
  (§6).
- Manual (Mode A): enable the addon with `api` routing and confirm the guardian
  deploys without any other ingress addon enabled (the §8 threading). From
  inside the paperclip container, `curl http://guardian:8182/v1/models` with the
  seeded key — this pins the container-to-container reachability claim (the edge
  binds all interfaces; no host port involved). Then create a Paperclip company,
  configure an agent with `opencode_local` and `model: openpalm/<id>`, run one
  heartbeat, and confirm the request appears in `data/logs/guardian-audit.log`.
- Manual (upstream conformance): after any `OP_PAPERCLIP_VERSION` bump, re-check
  the four upstream contracts this design leans on — `HOST` env overriding the
  loopback default (`server/src/config.ts`), `PAPERCLIP_OPENCODE_PROVIDERS`
  `{env:}` expansion, `PAPERCLIP_ALLOWED_HOSTNAMES`/`PAPERCLIP_PUBLIC_URL`
  trusted-origin derivation (`server/src/auth/better-auth.ts`), and
  `PAPERCLIP_TELEMETRY_DISABLED`/`DO_NOT_TRACK`. Upstream is calendar-versioned
  with no semver contract, so these are pin-bump checks, not one-time facts.
