# Access presets — redesign

Status: proposal
Supersedes: #563 network access presets, and the bind-address model behind them.

## 1. The problem, stated plainly

A non-technical person installs OpenPalm on their desktop and wants to open the
assistant from their phone. Today that requires them to be correct about, at
minimum:

- which of **six** bind-address variables governs the listener they care about,
- that two of those six inherit from a seventh and the rest do not,
- that the thing published on the LAN by "Home network" is *not* the UI they
  were just using,
- that OpenCode needs a **second** password distinct from their UI password,
- and that a **CORS allowlist** must contain the exact origin their phone will
  type, or chat fails with a bare network error and no diagnosis.

None of that is a decision a home user should ever be asked to make. Every one
of those is plumbing that leaked into the operator surface.

## 2. Review of what exists

### 2.1 The knob inventory

| Category | Variables | Count |
|---|---|---|
| Bind addresses | `OP_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`, `OP_UI_BIND_ADDRESS`, `OP_CHAT_BIND_ADDRESS`, `OP_API_BIND_ADDRESS`, `OP_VOICE_BIND_ADDRESS` | 6 |
| Published ports | `OP_UI_PORT`, `OP_ASSISTANT_PORT`, `OP_HOST_UI_PORT`, `OP_GUARDIAN_PORT`, `OP_GUARDIAN_ADMIN_PORT`, `OP_CHAT_PORT`, `OP_API_PORT`, `OP_VOICE_PORT_HOST` | 8 |
| CORS allowlists | `OP_UI_CORS_ALLOWED_ORIGINS`, `GUARDIAN_CORS_ALLOWED_ORIGINS` | 2 |
| Auth toggles | `OPENCODE_AUTH`, `GUARDIAN_DIRECT_INGRESS`, `GUARDIAN_MCP` | 3 |
| Endpoint overrides | `OP_UI_DEFAULT_ASSISTANT_URL`, `OP_OPENCODE_URL`, `OP_ASSISTANT_URL` | 3 |
| Distinct credentials | UI login password, OpenCode server password, guardian principals, API key, guardian admin token, guardian MCP token | 6 |

**22 environment variables and 6 credentials** stand between a user and "open
the assistant on my phone." The four presets move exactly **one** of the 22.

### 2.2 Two inheritance rules in one file

```yaml
# UI — inherits the global bind
"${OP_UI_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_UI_PORT:-3800}:3000"
# OpenCode — does NOT inherit the global bind
"${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3810}:4096"
```

"Unset" means *inherit* for four listeners and *loopback* for one. This single
inconsistency is why `detectNetworkPreset` needs a `OP_BIND_CASCADING_KEYS` set
to reverse-engineer intent, why `OP_BIND_ADDRESS=0.0.0.0` alone silently
exposes the UI and voice, and why the preset resolver has to write all six
values explicitly "so switching between presets always converges."

That last part is the tell: the model needs a convergence mechanism because the
defaults are not expressible.

### 2.3 The root cause

Everything above cascades from **one** architectural decision:

> The browser talks to OpenCode **directly**. No proxy.

Follow the consequences:

1. The browser is on a phone → OpenCode must be published on the LAN.
2. OpenCode is on the LAN → it needs its own auth → a **second password**.
3. The UI origin (`:3800`) differs from the OpenCode origin (`:3810`) → **CORS
   allowlist**, which the container cannot compute because it cannot see the
   host's LAN addresses → the host must resolve and inject it.
4. The seeded connection URL is baked at container start as `127.0.0.1:3810`,
   which is wrong for every remote browser → a client-side **loopback-host
   rewrite** (`rewriteLoopbackUrlForBrowserHost`).
5. Two origins → two TLS decisions, and an `https` UI cannot reach an `http`
   assistant → a **mixed-content policy** module.
6. mDNS has to advertise *something* → it advertises OpenCode, so the admin UI
   hands LAN users a link to the raw OpenCode web UI instead of OpenPalm.

Six subsystems exist to service one decision. The presets are complex because
they are configuring the blast radius of that decision.

### 2.4 What the presets actually deliver today

| Preset | What it changes | What the user gets |
|---|---|---|
| This PC only | nothing (all loopback) | works |
| Home network, w/ password | `OP_ASSISTANT_BIND_ADDRESS` + `OPENCODE_AUTH` | raw OpenCode on the LAN; the OpenPalm UI is **not** reachable |
| Home network, open | `OP_ASSISTANT_BIND_ADDRESS` | same, without a password |
| Shared network, guardian | `OP_BIND_ADDRESS` | guardian front door; UI and voice also silently exposed by the cascade |

The primary use case — "open the assistant UI from my phone" — is not served by
any of the four. (The previous commit on this branch makes the home presets
publish the UI and auto-derive the CORS grant. That is a correct fix *within*
the current model, and it is also evidence the model is wrong: making one
preset work required a new module whose entire job is compensating for
cross-origin transport.)

## 3. Design

### 3.1 The one structural change

**The UI server proxies the local assistant. Same origin.**

The UI is already a SvelteKit `adapter-node` server sitting in the same
container as OpenCode. Give it `/oc/*` → `http://localhost:4096`, behind the
existing UI session.

Consequences, all subtractive:

| Falls away | Because |
|---|---|
| OpenCode on the LAN | the browser never contacts it |
| `OPENCODE_AUTH` + OpenCode server password | it is only ever reachable on loopback |
| `OP_UI_CORS_ALLOWED_ORIGINS` | there is no cross-origin request |
| `rewriteLoopbackUrlForBrowserHost` | the assistant is at `/oc`, relative |
| `OP_UI_DEFAULT_ASSISTANT_URL` seeding in `entrypoint.sh` | nothing to seed |
| mixed-content policy for the local assistant | one origin, one TLS decision |
| `port-contract.ts` legacy-port reconciliation | no browser-facing assistant port |

One password. One origin. One port to know.

**The Connections feature is unaffected.** Remote/third-party assistants keep
the browser-direct transport and their own credentials. The split becomes
meaningful rather than incidental: *this* assistant is same-origin; *other*
assistants are browser-direct. `DirectTransport` is already an interface, so a
same-origin sibling is a drop-in.

### 3.2 The second structural change

**OpenCode is never published to the LAN. Ever. It is not a preset input.**

`127.0.0.1:3810` always — serving the host-side UI (Electron, `openpalm app`)
and debugging. `OP_ASSISTANT_BIND_ADDRESS` is deleted, not defaulted.

This is the whole security story of the redesign: the assistant has no
LAN-reachable unauthenticated surface *by construction*, not by getting four
variables right.

### 3.3 The third structural change

**Kill the cascade.** Every port line takes one flat, always-explicitly-written
variable:

```yaml
"${OP_UI_BIND}:${OP_UI_PORT:-3800}:3000"
"${OP_GUARDIAN_BIND}:${OP_GUARDIAN_PORT:-3830}:3830"
"127.0.0.1:${OP_ASSISTANT_PORT:-3810}:4096"   # literal, not a variable
```

No nesting, no inheritance, no "unset means different things."

### 3.4 Intent vs. derived state

| File | Contains | Who writes it |
|---|---|---|
| `knowledge/env/stack.env` | **intent only** — `OP_ACCESS`, `OP_PROJECT_NAME`, image pins | the user (and the wizard) |
| `state/stack.state.env` | **fully derived**, regenerated every deploy, `# GENERATED — DO NOT EDIT` | the control plane |

The layering already exists (`buildEnvFiles` puts state last, so it wins).
Today derived values are written *back into* the intent file, which is exactly
what makes hand-edits and presets fight, and what forces `detectNetworkPreset`
to reverse-engineer intent from outcomes. Under this split, detection is
`readStackEnv().OP_ACCESS` — a lookup, not an inference.

### 3.5 The presets

One variable: `OP_ACCESS`.

| `OP_ACCESS` | UI label | UI :3800 | Guardian :3830 | Assistant data path | Reach the UI at |
|---|---|---|---|---|---|
| `private` | Only this computer | `127.0.0.1` | not deployed | UI → OpenCode (loopback) | `localhost:3800` |
| `home` **(default)** | My home network | `0.0.0.0` | not deployed | UI → OpenCode (loopback) | `openpalm.local:3800` |
| `screened` | My network, screened | `0.0.0.0` | `127.0.0.1` | UI → **guardian** → OpenCode | `openpalm.local:3800` |
| `gateway` | Locked down | not published | `0.0.0.0` | UI → **guardian** → OpenCode | `openpalm.local:3830` (guardian serves the UI) |

Derived state per preset — the complete generated file:

| | `private` | `home` | `screened` | `gateway` |
|---|---|---|---|---|
| `OP_UI_BIND` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` | `127.0.0.1` |
| `OP_GUARDIAN_BIND` | `127.0.0.1` | `127.0.0.1` | `127.0.0.1` | `0.0.0.0` |
| `OP_ASSISTANT_UPSTREAM` | `http://localhost:4096` | `http://localhost:4096` | `http://guardian:8080/oc` | `http://guardian:8080/oc` |
| `OP_GUARDIAN_SERVES_UI` | `false` | `false` | `false` | `true` |
| `OP_MDNS_PORT` | — (off) | `3800` | `3800` | `3830` |
| guardian compose profile | off | off | on | on |

Six generated values. The user sets one.

### 3.6 What each preset means, in the words the wizard should use

- **Only this computer** — Nothing leaves this machine. Other devices on your
  network cannot see the assistant at all.
- **My home network** — Anyone on your home Wi-Fi can open the assistant in a
  browser and sign in with your password. Good for phones, tablets, and a
  second computer at home.
- **My network, screened** — Same as above, plus every message is checked and
  logged by the guardian before it reaches the assistant. Use this when other
  people share your network.
- **Locked down** — One guarded front door. Everything — the app, apps you
  connect, chat integrations — goes through the guardian, which screens,
  logs, and rate-limits it. Use this on a business network.

No port numbers. No bind addresses. No mention of OpenCode.

### 3.7 Discovery: finding it from a phone

The remaining friction after the above is *knowing the URL*. Three cheap wins:

1. **mDNS advertises the front door** — `openpalm.local` on the UI port (today
   it advertises OpenCode). One name, and it survives DHCP re-IP.
2. **A QR code** on the wizard's final screen and in the admin dashboard,
   encoding `http://openpalm.local:3800`. The phone scans; nothing is typed.
3. *(Optional)* also publish the UI on **port 80** in `home`/`screened`, so
   `http://openpalm.local` works bare. Rootless Docker cannot bind <1024 without
   `net.ipv4.ip_unprivileged_port_start`, so this must be an opt-in toggle that
   fails soft, not a default.

### 3.8 One credential

| Preset | What a person types to use the assistant |
|---|---|
| `private`, `home` | the UI password |
| `screened` | the UI password |
| `gateway` | the UI password (guardian passes the UI's session through) |

Apps and integrations (OpenAI-compatible clients, Discord, Slack, paired
devices) keep using guardian principals and API keys — those are machine
credentials, minted from the dashboard, never typed by a human. The OpenCode
server password is **deleted outright**.

## 4. What this deletes

Operator-facing variables: **10 → 1**.

Deleted: `OP_BIND_ADDRESS`, `OP_ASSISTANT_BIND_ADDRESS`, `OP_UI_BIND_ADDRESS`,
`OP_CHAT_BIND_ADDRESS`, `OP_API_BIND_ADDRESS`, `OP_VOICE_BIND_ADDRESS`,
`OPENCODE_AUTH`, `OP_UI_CORS_ALLOWED_ORIGINS`, `OP_UI_DEFAULT_ASSISTANT_URL`,
`GUARDIAN_DIRECT_INGRESS`. Added: `OP_ACCESS`.

Credentials: **6 → 5** (OpenCode server password deleted).

Modules deleted or gutted:

- `packages/lib/.../ui-cors-origins.ts` — entire module
- `packages/ui/.../server/port-contract.ts` — entire module
- `rewriteLoopbackUrlForBrowserHost` + `adaptRuntimeConfigForBrowser` rewrite path
- the `runtime-config.json` assistant-seeding block in `entrypoint.sh` (~40 lines of `node -e`)
- `assistant-endpoint.ts`'s 4-level override precedence → one upstream value
- `detectNetworkPreset`'s inference → an `OP_ACCESS` lookup
- `collectBindAddressWarnings`' per-variable matrix → one line derived from `OP_ACCESS`
- `validateNetworkPresetEnv`'s host-env conflict checks — no host env var can defeat a preset once binds are generated

## 5. What this costs

Honest accounting — this is not free:

1. **The UI server becomes a streaming hop.** OpenCode's SSE must pass through
   `adapter-node` unbuffered. Node handles this, but it is a real code path
   that needs a load test, and a UI crash now takes chat with it (today it
   already does — the UI *is* the app).
2. **`gateway` requires the guardian to serve the UI.** New capability: static
   assets, SSE pass-through, and session forwarding. This is the largest single
   piece of new work in the proposal. If it is deferred, `gateway` folds into
   `screened` and we ship 3 presets.
3. **Migration.** Existing installs carry the six bind variables. Map the known
   rows to an `OP_ACCESS` value; anything unrecognized maps to `custom`, which
   keeps honoring the raw variables as advanced overrides and shows a one-time
   "your setup predates access presets" notice. Nobody's working install breaks.
4. **Loopback OpenCode is unauthenticated.** Any local process on the desktop
   can reach `127.0.0.1:3810`. This is unchanged from today's `this-pc`
   default and is the same trust boundary as "you are logged into this
   desktop", but it should be stated in the docs rather than left implied.
5. **`OP_ACCESS=custom` must exist** as an escape hatch, or power users with a
   reverse proxy are stranded.

## 6. Build order

Each step is independently shippable and leaves the tree working.

1. **UI `/oc` proxy + same-origin transport.** No preset changes. The local
   connection becomes same-origin; CORS grant becomes dead weight but stays.
   *This alone fixes the reported home-network breakage.*
2. **Pin OpenCode to loopback; delete `OPENCODE_AUTH` and its password.**
   Now nothing on the LAN is unauthenticated by construction.
3. **Introduce `OP_ACCESS` + the generated state file.** Flat binds, cascade
   deleted, migration mapping for existing installs.
4. **Wizard copy + mDNS front door + QR code.**
5. **Guardian serves the UI** → unlocks `gateway`. Optional; defer if needed.

Steps 1–2 remove the reported failure and the majority of the complexity.
Steps 3–4 deliver the user-facing simplification. Step 5 is the only genuinely
new subsystem.
