# Access presets — redesign

Status: proposal
Supersedes: #563 network access presets, and the bind-address model behind them.
Revision 2: guardian is a data-plane front door only (it never serves the UI);
direct assistant access across the network is a preset choice, not a ban.

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
| `OP_UI_CORS_ALLOWED_ORIGINS` | the built-in client makes no cross-origin request |
| `rewriteLoopbackUrlForBrowserHost` | the assistant is at `/oc`, relative |
| `OP_UI_DEFAULT_ASSISTANT_URL` seeding in `entrypoint.sh` | nothing to seed |
| mixed-content policy for the built-in connection | one origin, one TLS decision |
| `port-contract.ts` legacy-port reconciliation | no browser-facing assistant port on the default path |
| a second password on the default path | the UI session is the only credential the proxy needs |

One password. One origin. One port to know — **on the path a home user
actually takes.**

Note what does *not* fall away: OpenCode may still be published on the LAN for
other clients (§3.3), and that path keeps its own auth. The point is that it is
no longer on the route between a phone and the chat window, so its complexity
stops being everybody's problem.

**The Connections feature is unaffected.** Remote/third-party assistants keep
the browser-direct transport and their own credentials. The split becomes
meaningful rather than incidental: *this* assistant is same-origin; *other*
assistants are browser-direct. `DirectTransport` is already an interface, so a
same-origin sibling is a drop-in.

Critically, **the preset changes the proxy's upstream, not the browser's
transport.** "Screened" means the UI's own traffic is routed through the
guardian by the server it was loaded from — invisible to the person using it,
requiring no reconfiguration, and with the guardian principal credential held
container-side where the browser never sees it.

### 3.2 The UI is a client; the endpoint it talks to is a separate question

These are two independent axes, and conflating them is what made the old
presets incoherent:

- **Where can I obtain the chat UI?** The assistant container (`:3800`), the
  desktop app (Electron / `openpalm app`), or a future hosted origin.
- **What may reach the assistant from the network, and through what?** Nothing,
  the assistant directly, or the guardian only.

A client obtained from *any* of those sources can point at a guardian endpoint
(`/oc`) or — when the preset allows it — at the assistant directly across the
network. The guardian is a **data-plane** front door, not a web host: it serves
the API, never the UI's HTML.

### 3.3 Direct assistant access is a preset choice, not a prohibition

A second machine on the LAN running the desktop app, or a third-party
OpenCode-compatible tool, is a legitimate case. So `OP_ASSISTANT_BIND` remains a
derived preset output rather than a hard-coded loopback constant.

Two rules keep this from re-introducing the complexity it caused before:

1. **The built-in client never uses it.** It goes through the same-origin
   proxy regardless of preset, so publishing the assistant port never puts a
   CORS allowlist or a second credential on the default path.
2. **Publishing it always turns on auth**, with an **auto-generated** password
   written to the dashboard — never a field the user is asked to invent, and
   deliberately *not* the UI login password, so capturing one does not yield
   the other.

Plain-HTTP Basic auth on the LAN is sniffable by anything already on the
network. That is the honest posture of the lax preset and belongs in the copy,
not in a footnote. It is also why this is the only preset that publishes it.

### 3.4 Kill the cascade

Every port line takes one flat, always-explicitly-written variable:

```yaml
"${OP_UI_BIND}:${OP_UI_PORT:-3800}:3000"
"${OP_ASSISTANT_BIND}:${OP_ASSISTANT_PORT:-3810}:4096"
"${OP_GUARDIAN_BIND}:${OP_GUARDIAN_PORT:-3830}:3830"
```

No nesting, no inheritance, no "unset means different things." Every value is
generated; none is ever absent.

### 3.5 Intent vs. derived state

| File | Contains | Who writes it |
|---|---|---|
| `knowledge/env/stack.env` | **intent only** — `OP_ACCESS`, `OP_PROJECT_NAME`, image pins | the user (and the wizard) |
| `state/stack.state.env` | **fully derived**, regenerated every deploy, `# GENERATED — DO NOT EDIT` | the control plane |

The layering already exists (`buildEnvFiles` puts state last, so it wins).
Today derived values are written *back into* the intent file, which is exactly
what makes hand-edits and presets fight, and what forces `detectNetworkPreset`
to reverse-engineer intent from outcomes. Under this split, detection is
`readStackEnv().OP_ACCESS` — a lookup, not an inference.

### 3.6 The presets

One variable: `OP_ACCESS`. The axis is **how much sits between the network and
the assistant** — nothing, a password, or the guardian.

| `OP_ACCESS` | UI label | Open the chat UI at | Assistant API from the network | Apps / integrations |
|---|---|---|---|---|
| `private` | Only this computer | `localhost:3800` | closed | — |
| `home` **(default)** | My home network | `openpalm.local:3800` | **direct**, `:3810`, auto-generated password | direct or paired |
| `screened` | My network, screened | `openpalm.local:3800` | **guardian only**, `:3830/oc` | guardian principals |
| `locked` | Locked down | desktop app or hosted client → guardian | **guardian only**, `:3830/oc` | guardian principals |

Derived state per preset — the complete generated file:

| | `private` | `home` | `screened` | `locked` |
|---|---|---|---|---|
| `OP_UI_BIND` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` | `127.0.0.1` |
| `OP_ASSISTANT_BIND` | `127.0.0.1` | `0.0.0.0` | `127.0.0.1` | `127.0.0.1` |
| `OP_GUARDIAN_BIND` | `127.0.0.1` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| `OPENCODE_AUTH` | `false` | `true` | `false` | `false` |
| `OP_ASSISTANT_UPSTREAM` | `localhost:4096` | `localhost:4096` | `guardian:8080/oc` | `guardian:8080/oc` |
| `OP_MDNS_PORT` | — (off) | `3800` | `3800` | `3830` |
| guardian compose profile | off | off | on | on |

Seven generated values. The user sets one.

Note `OPENCODE_AUTH` survives — but only in `home`, only because that is the
one preset that publishes the assistant port, and with a password the system
generates rather than one the user invents. In every other preset the assistant
has no network-reachable surface at all, so there is nothing to authenticate.

### 3.7 What each preset means, in the words the wizard should use

- **Only this computer** — Nothing leaves this machine. Other devices on your
  network cannot reach the assistant at all.
- **My home network** — Anyone on your Wi-Fi can open the assistant in a
  browser and sign in with your password. Other apps can connect directly using
  a connection key from your dashboard. Best for phones, tablets, and a second
  computer at home.
- **My network, screened** — Same browser access, but every message is checked
  and logged by the guardian before it reaches the assistant, and nothing can
  bypass it. Use this when other people share your network.
- **Locked down** — One guarded door. The assistant is invisible to the
  network; everything reaches it through the guardian, which screens, logs and
  rate-limits. Browser access is from this computer or a managed app, not from
  any device on the network.

No port numbers. No bind addresses. No mention of OpenCode.

### 3.8 Where the strict presets leave a browser user

`locked` deliberately has no browse-from-any-device path: the UI is loopback,
so a remote person uses the desktop app or a hosted client pointed at the
guardian. That is the intended posture — on a network where you want one
audited door, you also want a managed client rather than an arbitrary browser.
It should be stated in the preset copy, not discovered.

If that proves too strict in practice, the fix is a `locked` variant that
publishes the UI while keeping the assistant guardian-only — i.e. `screened`.
The two are one bind value apart, which is a sign the axis is factored right.

### 3.9 Discovery: finding it from a phone

The remaining friction after the above is *knowing the URL*. Three cheap wins:

1. **mDNS advertises the front door** — `openpalm.local` on the UI port (today
   it advertises OpenCode). One name, and it survives DHCP re-IP.
2. **A QR code** on the wizard's final screen and in the admin dashboard,
   encoding `http://openpalm.local:3800`. The phone scans; nothing is typed.
3. *(Optional)* also publish the UI on **port 80** in `home`/`screened`, so
   `http://openpalm.local` works bare. Rootless Docker cannot bind <1024 without
   `net.ipv4.ip_unprivileged_port_start`, so this must be an opt-in toggle that
   fails soft, not a default.

### 3.10 One password, typed once

| Preset | What a **person** types | What a **machine** presents |
|---|---|---|
| `private` | the UI password | — |
| `home` | the UI password | generated assistant key, or a guardian principal |
| `screened` | the UI password | guardian principal |
| `locked` | the UI password (in the desktop app) | guardian principal |

The human-facing credential is the UI login password in every preset, without
exception. Everything else — the generated assistant key, guardian principals,
API keys, paired devices — is a machine credential minted from the dashboard
and copy-pasted, never invented or memorised.

That is the friction budget: **one password, one URL, one QR code.**

## 4. What this deletes

Operator-facing variables: **9 → 1**.

Deleted: `OP_BIND_ADDRESS` (the cascade root), `OP_ASSISTANT_BIND_ADDRESS`,
`OP_UI_BIND_ADDRESS`, `OP_CHAT_BIND_ADDRESS`, `OP_API_BIND_ADDRESS`,
`OP_VOICE_BIND_ADDRESS`, `OP_UI_CORS_ALLOWED_ORIGINS`,
`OP_UI_DEFAULT_ASSISTANT_URL`, `GUARDIAN_DIRECT_INGRESS`. Added: `OP_ACCESS`.

The bind variables do not disappear so much as change owner: they become
generated outputs in the state file, never operator inputs.

`OPENCODE_AUTH` and the OpenCode server password **survive**, scoped to the one
preset that publishes the assistant port, with a generated value. Credentials
stay at **6** — but the count a human ever sees drops to **1**.

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
2. **`home` puts Basic auth over plain HTTP on the LAN.** Anything already on
   the network can capture the generated assistant key. It is a distinct
   credential from the UI password so the blast radius is bounded, and it is
   the only preset that publishes that port — but the copy must say so rather
   than imply the network is safe. `screened` exists precisely for people who
   cannot accept this.
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

Each step is independently shippable and leaves the tree working. **No step
requires new capability in the guardian** — it stays a data-plane proxy
throughout.

1. **UI `/oc` proxy + same-origin transport.** No preset changes. The built-in
   connection becomes same-origin; the CORS grant becomes dead weight but
   stays. *This alone fixes the reported home-network breakage*, and it is the
   only step that touches the chat data path.
2. **Make the proxy upstream configurable** (`OP_ASSISTANT_UPSTREAM`: loopback
   OpenCode or `guardian:8080/oc`, with the principal credential held
   container-side). This is what makes `screened` possible, and it is a
   one-variable change once step 1 lands.
3. **Introduce `OP_ACCESS` + the generated state file.** Flat binds, cascade
   deleted, `OPENCODE_AUTH` narrowed to `home` with a generated key, migration
   mapping for existing installs.
4. **Wizard copy + mDNS front door + QR code.**

Step 1 removes the reported failure. Steps 1–2 remove the majority of the
complexity. Steps 3–4 deliver the user-facing simplification.

Dropping guardian-serves-UI removed the only genuinely new subsystem from the
plan: what remains is a proxy route, a variable, and deletions.
