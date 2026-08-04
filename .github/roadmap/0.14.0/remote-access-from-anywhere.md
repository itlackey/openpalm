# Remote access — reach it from anywhere

Status: research + proposal
Companion to `access-presets-redesign.md` (who may reach the assistant) and
`tls-on-the-home-network.md` (whether the connection is encrypted). This
document answers a third question those two deliberately leave open: **can the
assistant be reached from outside the home network at all**, and can that be a
single toggle a non-technical person flips.

Every external claim below was checked against a primary source. Where the
first-pass research was wrong, the correction is kept inline rather than
silently dropped — the wrong version is what most blog posts say.

## 1. The constraint that eliminates most of the field

A home install sits behind NAT with no static IP, and increasingly behind
**CGNAT**, where inbound port forwarding is not merely inconvenient but
structurally impossible. Anything requiring the user to configure a router, own
a domain, or operate a machine with a public IP is out. That removes frp,
Nebula, Headscale, self-hosted Pangolin, and the classic DDNS + port-forward
approach in one cut.

The DDNS path deserves its own epitaph because it is what most tutorials still
recommend: the Node libraries for it are abandoned (`nat-upnp@1.1.1`, 2017;
`nat-pmp@1.0.0`, 2016), and CGNAT makes it fail *invisibly* — the toggle would
report success and simply not work. Notably, **none** of the six appliance
precedents studied — Home Assistant/Nabu Casa, Synology QuickConnect, Umbrel,
CasaOS, Runtipi, Coolify — ships router configuration as its default path.
Every one of them uses an outbound tunnel or a vendor relay.

What survives is one shape: **a sidecar that dials outbound to a relay**, so
inbound traffic arrives over a connection the home network originated.

## 2. The candidates

### Cloudflare Tunnel (`cloudflared`)

Two modes that are barely the same product.

A **quick tunnel** (`cloudflared tunnel --url http://svc:3000`) needs no
account, no domain, no token — Cloudflare mints a random `*.trycloudflare.com`
hostname. It is the only genuinely zero-setup option in the entire field, and
it is **disqualified for OpenPalm by one documented line**: Quick Tunnels *do
not support Server-Sent Events*, alongside a hard 200 concurrent in-flight
request cap that returns 429. OpenPalm streams tokens. `cloudflared#1449`
reproduces this and names LLM token streaming as the broken case.

It fails three more ways even setting SSE aside. The hostname is regenerated on
**every process start** (`RunQuickTunnel` issues a fresh `POST
{quick-service}/tunnel` each time), so a `restart: unless-stopped` recovery
silently changes the user's URL. Cloudflare Access cannot be applied to it,
because Access requires an application in a zone on your own account — so
there is *no* possible auth gate. And Cloudflare's own docs and the binary's
own startup banner both say testing-and-development-only, no SLA.

A **named tunnel** (`cloudflared tunnel run --token <TOKEN>`) is genuinely
excellent and fully automatable from Bun: create the tunnel, fetch its token,
write ingress config, and create the proxied CNAME all over the REST API under
`/accounts/{id}/cfd_tunnel` plus the DNS records API. Cloudflare Access can
then gate the hostname, and — the single best non-technical finding in the
Cloudflare track — Access supports a **one-time PIN identity provider needing
no external IdP at all** (`POST /accounts/{id}/access/identity_providers` with
`{"type":"onetimepin"}`). The user types their email and pastes a 6-digit code.
Free for up to 50 users.

The blocker is structural: a named tunnel requires a domain whose nameservers
are delegated to Cloudflare. That violates "without buying a domain," and
registrar nameserver delegation is exactly the step a non-technical user
cannot be walked through reliably.

The obvious escape — OpenPalm buys a domain and hands each user a subdomain —
is a business decision, not an engineering one, and the naive version of it
does not work anyway: Cloudflare Universal SSL covers only the apex and
**first-level** subdomains, so a `<user>.link.openpalm.app` scheme gets no
valid certificate without an Advanced Certificate.

### Tailscale Serve and Funnel

`tailscale serve` publishes a service privately to the user's own tailnet at
`https://<node>.<tailnet>.ts.net`, with a real Let's Encrypt certificate and no
inbound ports. `tailscale funnel` publishes the same service to the **public
internet**. Funnel is restricted to a small set of ports — 443, 8443, and
10000 by default; see the correction in §7.3, the list is control-plane
delivered rather than hardcoded.

Three properties make this the best fit here.

**Serve and Funnel are one config differing by one boolean.** The whole thing
is a single `ipn.ServeConfig` JSON document, and public-vs-private is literally
`AllowFunnel: true|false`. That is the exact shape of the existing
`AccessToggles` model: intent boolean → derived artifact → container converges.
Nothing else in the field expresses "only my devices" and "anyone with the
link" as the same artifact with one bit flipped.

**Tailscale does not decrypt the traffic.** Funnel relays proxy still-encrypted
TCP by SNI; the certificate is issued to the user's own node and TLS terminates
*inside the sidecar*. Cloudflare and ngrok both terminate at their edge and see
every prompt and every model response in plaintext. For a product whose premise
is a self-hosted private assistant, this is the difference between "your
assistant is yours" and "your assistant is yours except the vendor reads it."

**The repo already documents this exact topology.** `docs/remote-access-tls.md`
ships literal `tailscale serve --bg --https=443` commands and a
`GUARDIAN_CORS_ALLOWED_ORIGINS=https://machine.example.ts.net` example, and
`tls-on-the-home-network.md` already grades Tailscale "Tier 0 — engineering
cost: none." It even already uses 443 and 8443, two of the three Funnel-legal
ports, so no renumbering is needed. This is productizing a documented,
supported path.

Mechanically it is cheaper than the existing toggles, too: containerboot
watches the config **directory** with fsnotify and re-applies via LocalAPI
**with no container restart**, so flipping private↔public is a file write
rather than the container recreate `applyAccessToggles` performs today.

Costs, stated honestly: Funnel is still labelled beta roughly four years after
launch. The free Personal plan is documented as non-commercial use only (6
users, unlimited user-owned devices). The coordination server, `*.ts.net` DNS,
certificate issuance, and the Funnel relay are all Tailscale-operated — if
Tailscale is down, both the public and private paths fail.

### ngrok

The only free option with a real identity gate that needs no application code
(Traffic Policy `oauth` with ngrok-managed Google/GitHub/Microsoft/GitLab/
LinkedIn/Twitch apps). Its `@ngrok/ngrok` npm package is a first-party
Rust-backed NAPI module and does work under Bun — the Bun NAPI issues commonly
cited against it (#21432, #23136, #26045) are all **closed**.

It loses on economics, not engineering. The free plan is 20,000 HTTP requests
**and 1 GB egress per month**, with OAuth capped at **3 traffic identities per
month** — three distinct authenticated humans, after which the identity gate
stops admitting people. A SvelteKit cold load plus streaming chat consumes that
in days, and the endpoint stops rather than degrades. Free accounts also get a
browser interstitial every 7 days per domain, which a non-technical user reads
as "something is broken." One correction worth recording: the widely-repeated
claim that free ngrok includes "a static domain you control" is misleading —
free gets an *assigned* dev domain; reserved and custom domains are paid.

### The rest

**zrok** has the best licence in the field (Apache-2.0, self-hostable) and is
the only candidate that could remove the vendor entirely. But v2.0 renamed the
binary to `zrok2`, moved state to `~/.zrok2`, re-prefixed env vars to
`ZROK2_*`, and **removed reserved sharing** — so essentially every tutorial and
most model memory is now wrong. Its Node SDK `@openziti/zrok@1.1.10` is v1-era
and resolves `@openziti/ziti-sdk-nodejs@^0.20.0`, a node-pre-gyp addon keyed on
`node_abi` — the worst possible native shape for Bun. Revisit in a year.

**Pangolin Cloud + Newt** is the cleanest sidecar in the whole field
(`fosrl/newt:latest`, three env vars, no capabilities, no volumes, no host
networking) with an identity-aware proxy offering PIN/OTP/SSO — better auth
than Funnel. It loses on maturity and verifiability: free-tier terms could not
be confirmed from a primary source, and it is a young single-vendor
dependency. Most likely future addition; not v1.

**NetBird** deserves a correction against the common claim that it needs
`NET_ADMIN`/`/dev/net/tun`/host networking: that applies to the default image
only, and `netbirdio/netbird:rootless-latest` is documented as working without
any privileges. Its documented limitation — "only useful for inbound access" —
is exactly our case. But its Reverse Proxy is explicitly beta, and self-hosting
hard-requires Traefik for TLS passthrough. Two stacked betas is one too many.

**localtunnel, bore, serveo, Pinggy free, telebit** — ephemeral URLs, no auth,
unmaintained (`localtunnel@2.0.2`, published 2021). Pointing any of these at an
assistant with tool execution and filesystem mounts is an unauthenticated RCE
endpoint. Not offerable.

## 3. Recommendation

**Primary: a `tailscale/tailscale` sidecar driven by a generated
`TS_SERVE_CONFIG` JSON file, shipping both modes behind one control — Serve
(private, the default) and Funnel (public, a second deliberate step).**

**Secondary: a `cloudflare/cloudflared` named-tunnel sidecar** for the user who
already owns a domain on Cloudflare and wants Cloudflare Access in front. It
slots into the same overlay shape with a different image.

Do not ship one boolean. Ship **one toggle plus a mode**, because they are
different products with different risk:

| | Serve (default) | Funnel (opt-in) |
|---|---|---|
| Who can reach it | devices signed into the user's own tailnet | anyone on the internet with the URL |
| Auth in front | the tailnet itself, plus verified `Tailscale-User-Login` identity headers | **nothing** — Tailscale strips identity for funneled requests and sets `Tailscale-Funnel-Request: ?1` instead |
| Friction | account + node registration | + one-time browser approval provisioning HTTPS and the `funnel` nodeAttr |
| Correct default | yes | requires a second confirmation |

Serve is what a non-technical user actually means by "use it from anywhere" —
their phone, their laptop, on mobile data. Funnel is what they mean when they
want to send a link to someone who will never install anything. The first
should be near-frictionless; the second needs a speed bump, because Guardian is
not in that path and the UI login password becomes the only door.

## 4. How it maps onto the existing model

It is a **5th boolean in `AccessToggles`**, but it is *not* a 5th bind address,
and the current model cannot express three things it needs.

### What fits cleanly

```ts
export type AccessToggles = {
  networkAccess: boolean;
  assistantDirect: boolean;
  guardianNetwork: boolean;
  guardianOpenaiApi: boolean;
  /** Reach the assistant from outside this network, over an outbound tunnel. */
  remoteAccess: boolean;
};
```

plus entries in `ACCESS_TOGGLE_KEYS`, `ACCESS_TOGGLE_DEFAULTS`
(`remoteAccess: false`), `ACCESS_TOGGLE_LABELS`, `ACCESS_TOGGLE_DESCRIPTIONS`,
`describeAccessExposure`, and `ACCESS_INTENT_KEYS`
(`remoteAccess: "OP_ACCESS_REMOTE"`). `resolveAccessIntentEnv`,
`readAccessToggles`, `hasStoredAccessIntent` and `coerceAccessToggles` all
iterate `ACCESS_TOGGLE_KEYS`, so they pick it up for free.

**`readAccessToggles`'s inference fallback must not be extended.** The block
comment on `ACCESS_INTENT_KEYS` explains why intent-stored-as-consequence was
the root cause of the churn history. There is no bind address to infer this
from and there should never be one: `readIntent(env, "remoteAccess") ?? false`.

### What the model cannot express

**(i) It produces no bind address.** All four existing toggles resolve to
binds. A tunnel changes no bind at all — the sidecar reaches `assistant:3000`
over `assistant_net`, so the host publish stays `127.0.0.1`. LAN exposure and
internet exposure are genuinely orthogonal, and inventing a fake `OP_REMOTE_*`
bind key to make it fit would be dishonest. `resolveAccessEnv` instead gains
one non-bind key, `OP_REMOTE_ACCESS`, whose only consumer is
`discoverStackOverlays` gating a new compose overlay — the same double-gate
precedent `voice.compose.lan.yml` already uses. `KEY_OWNER` in
`access-apply.ts` widens from `"assistant" | "guardian"` to include
`"tunnel"`, as does `ACCESS_STATUS_SERVICES` in `access-status.ts`.

**(ii) It needs a secret, and the toggle path structurally forbids one.**
`patchSecretsEnvFile` — which `applyAccessToggles` calls — is guarded by
`assertNoSecretLikeStackEnvKeys`, whose `SECRET_LIKE_KEY_RE` throws on any key
matching `TOKEN`, `SECRET`, `API_KEY`, and friends. A tunnel auth key therefore
**cannot travel through the toggle-apply path**. It must be a delegated secret:
a file under `private/secrets/`, registered in `DELEGATED_SECRET_NAMES`,
mounted as a Compose secret — a separate write path and a separate API route
from the toggle, mirroring how the Discord bot token works today.

**(iii) It produces a URL, which is derived state, not intent.** The existing
toggles produce nothing readable. This one produces
`https://<node>.<tailnet>.ts.net`, which the UI must show with a copy button.
Do not persist it. Read it live, the way `access-status.ts` already reads
container health.

**(iv) It has a live status a boolean cannot carry.** `AccessApplyResult`
already models this honestly with `ok: false` when the env is written but the
recreate failed. Extend the same idea: `remoteAccess: true` is *intent*;
whether the tunnel is up, whether the node is registered, and whether Funnel is
approved are three separately observed facts.

## 5. The config file

Follow the repo's existing split exactly: intent in `state/stack.env`, secrets
in `private/secrets/`, generated compose in `system/stack/`, observed state read
live and never persisted. The mode and hostname are richer than a boolean, so
they get one small JSON file in the user-owned `config/` tree.

```
~/.openpalm/
├─ state/stack.env                       # INTENT (existing file, new keys)
│    OP_ACCESS_REMOTE=true               #   the 5th toggle's stored intent
│    OP_REMOTE_ACCESS=true               #   derived; gates the overlay
│    OP_REMOTE_HOSTNAME=openpalm         #   derived from remote-access.json
│
├─ config/remote-access.json             # NEW — user-owned, mode + target
│    {
│      "provider": "tailscale",
│      "public": false,                  // ← Serve vs Funnel. THE bit.
│      "target": "assistant",            // "assistant" | "guardian"
│      "hostname": "openpalm"
│    }
│
├─ private/secrets/op_tailscale_authkey  # 0600, DELEGATED. Never in stack.env.
│
└─ system/stack/
   ├─ remote.compose.yml                 # NEW managed overlay (release-shipped)
   └─ remote/serve.json                  # GENERATED ipn.ServeConfig
```

Three non-negotiables about `system/stack/remote/serve.json`, all from
verified containerboot behaviour:

1. **Mount the directory `system/stack/remote/`, never the single file.**
   containerboot registers its fsnotify watcher on
   `filepath.Dir(cfg.ServeConfigPath)`, and a single-file bind mount pins an
   inode that an atomic rename would orphan — the container would read stale
   JSON forever. `fs-atomic.ts` already documents this exact hazard on
   `writeFileInPlace`. Directory mount + `writeFileAtomic` is the correct
   combination.
2. **The directory must exist before the sidecar starts** — containerboot
   `log.Fatalf`s if `w.Add(dir)` fails. Add it to `ensureHomeDirs`.
3. **Turning Funnel off means writing `false`, never deleting the file.**
   `readServeConfig` returns `(nil, nil)` for a missing or empty file and the
   watch loop `continue`s, so a delete-to-disable implementation would leave
   the service publicly exposed indefinitely. Since being able to *close* the
   door is the entire point of the toggle, this is the most important single
   line in the implementation.

The generated document leaves `${TS_CERT_DOMAIN}` as a literal — containerboot
substitutes the real FQDN at read time, so the control plane never has to learn
the hostname in order to write the config:

```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": "http://assistant:3000" } }
    }
  },
  "AllowFunnel": { "${TS_CERT_DOMAIN}:443": false }
}
```

## 6. The compose wiring

New managed overlay `packages/skeleton/system/stack/remote.compose.yml`,
included by `discoverStackOverlays` under the same double-gate as
`voice.compose.lan.yml` (flag on **and** file present):

```yaml
# Outbound-only remote access. Publishes NOTHING: it dials out to Tailscale
# and reaches the assistant over assistant_net by service DNS. The host port
# publish in core.compose.yml stays 127.0.0.1 regardless — LAN exposure and
# internet exposure are genuinely orthogonal.
services:
  tunnel:
    image: tailscale/tailscale:v1.98.10
    restart: unless-stopped
    hostname: ${OP_REMOTE_HOSTNAME:-openpalm}   # → <hostname>.<tailnet>.ts.net
    environment:
      # `file:` is resolved by `tailscale up`, so the key never appears in
      # stack.env, `docker inspect`, or argv beyond a path.
      TS_AUTHKEY: file:/run/secrets/op_tailscale_authkey
      TS_SERVE_CONFIG: /config/serve.json
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "true"          # default; no /dev/net/tun, no NET_ADMIN
      TS_ENABLE_HEALTH_CHECK: "true"
    volumes:
      # DIRECTORY mounts, not single files — see §5.
      - ${OP_HOME}/system/stack/remote:/config
      - ${OP_HOME}/data/tunnel:/var/lib/tailscale
    secrets: [op_tailscale_authkey]
    networks: [ assistant_net ]
    # NO ports:. Nothing is published. Nothing needs to be.
    # NO depends_on onto a PROFILED service — that is a project-PARSE error
    # that would break `ps` and `down` too.

secrets:
  op_tailscale_authkey:
    file: ${OP_HOME}/private/secrets/op_tailscale_authkey

networks:
  assistant_net:
```

### The LAN bind stays closed

This is the load-bearing claim and it checks out three ways.

1. Docker's own docs: all ports of containers on a bridge network are already
   reachable from other containers on that network; `--publish` exists for the
   *host* boundary only.
2. `core.compose.yml:163` is
   `- "${OP_UI_BIND_ADDRESS:-127.0.0.1}:${OP_UI_PORT:-3800}:3000"`, with the
   comment above it noting `OP_UI_PORT` is host-facing only and the UI always
   serves on **3000** in-container. So the sidecar target is
   `http://assistant:3000` — not 3800, not 3880. The assistant declares
   `networks: [ assistant_net ]` at line 202.
3. Tailscale accepts a non-localhost proxy target:
   `ipn.ExpandProxyTargetValue` validates any hostname and only requires an
   explicit scheme for non-localhost targets. `http://assistant:3000` is valid.

Third-party guides universally use `network_mode: service:<app>` to force
`127.0.0.1` to work. **Do not do that here** — it would strip the assistant of
its own `ports:` block and break all four existing toggles. It is also
unnecessary.

None of `portal_net`, `assistant_net`, `addon_net` is declared
`internal: true`, so the sidecar has the outbound egress it needs.

### What is already wired, and the one thing that is not

Three integration hazards were expected here. Two are already solved:

- **Host header.** `checkHostHeader` short-circuits on
  `isPublishedContainerUi()`, which is true whenever
  `OP_UI_SERVED_IN_CONTAINER=1` — set unconditionally by
  `containers/assistant/entrypoint.sh`. The `ts.net` Host is accepted with no
  change.
- **CSRF origin and the Secure cookie.** Tailscale's proxy sets
  `X-Forwarded-Proto: https`, `X-Forwarded-Host`, and `X-Forwarded-For`
  (`addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go`), and the entrypoint
  **already** launches the UI with `PROTOCOL_HEADER=x-forwarded-proto
  HOST_HEADER=host`. So `effectiveRequestOrigin` computes `https://…` and
  `checkOriginHeader` passes. `isSecureRequest` in `session-cookie.ts` reads
  `x-forwarded-proto` directly and already appends `Secure`.

The one genuine gap:

- **`ADDRESS_HEADER` is absent, and the login throttle becomes a self-DoS.**
  `login-throttle.ts` keys on `event.getClientAddress()` and its own comment
  warns: *"Behind a reverse proxy every request may share one address, which
  makes the throttle global rather than per-client."* Behind the tunnel every
  request arrives from the sidecar's container IP, so five failed attempts by
  anyone locks out the owner. Set `ADDRESS_HEADER=x-forwarded-for` and
  `XFF_DEPTH=1`, gated on `OP_REMOTE_ACCESS`. adapter-node's spoofing warning
  is well-scoped here: the only client that can reach container port 3000 is
  the sidecar on `assistant_net`.

## 7. Placement, multi-stack, and routing

Three questions that change the design, answered against the code.

### 7.1 Why not host the tunnel inside guardian or portal?

**Portal is disqualified outright.** The discord and slack services declare
`networks: [portal_net]` — they have no `assistant_net` membership, so a
portal-hosted tunnel physically cannot reach `assistant:3000`. Portals are also
multi-instance (discord and slack are separate containers from the same image),
so "which portal hosts the tunnel" has no principled answer.

**Guardian is technically possible but wrong.** It is on
`networks: [portal_net, assistant_net]`, so it *can* reach either target, and
privileges are not the obstacle — userspace mode needs no `NET_ADMIN` and no
`/dev/net/tun`, and both images are `oven/bun:1.3-slim` running non-root, which
tailscaled tolerates. Four objections decide it anyway:

1. **Guardian does not exist in a default install.** It is profile-gated:
   `profiles: ["addon.chat", "addon.api", "addon.discord", "addon.slack",
   "addon.gateway"]`. Hosting the tunnel there means "reach it from anywhere"
   silently depends on a portal addon being enabled.
   `reconcileGuardianIngressAddons` sets a precedent for auto-enabling `chat`,
   but forcing a chat portal on someone who only wants phone access is a
   surprising side effect of an unrelated toggle.
2. **Release coupling.** Guardian ships as a versioned image
   (`OP_GUARDIAN_VERSION`). Baking `tailscaled` into it means a Tailscale
   security fix requires a Guardian release. A pinned sidecar image updates on
   its own cadence.
3. **Blast radius.** Guardian *is* the security boundary — principal auth,
   ownership checks, rate limits, content validation. Adding a networking
   daemon holding a long-lived tunnel credential widens exactly the container
   you least want widened, and the auth key joins Guardian's secret set.
4. **Restart granularity.** Toggling remote access would recreate Guardian and
   drop in-flight portal traffic. The sidecar is recreated in isolation, which
   is the whole point of `KEY_OWNER` scoping ("a guardian-only change must not
   recreate the assistant and drop an in-flight chat turn").

The sidecar costs one ~40 MB image that is **not deployed at all** when the
toggle is off, because the overlay is gated. That is cheaper than any of the
four objections above.

### 7.2 Multiple stacks on one host

This is the strongest argument for the design, not a complication.

Today two stacks on one host collide on **host ports** — `3800`, `3810`,
`3880`, `3830`, `3831`, `3821`, `8880` — and the only remedy is renumbering
every one by hand. The tunnel publishes **no host ports at all**: it dials
outbound and reaches services over the project-scoped compose network. A second
stack therefore needs nothing renumbered in order to be reachable from
anywhere.

Each stack becomes one tailnet node with its own FQDN. `AllowFunnel` is keyed
per `HostPort` **on that node**, and the funnel-port allowance is a node
attribute, so two stacks can both use 443 with no host-level contention.

What must be per-stack for this to hold:

- **`hostname:` must derive from `OP_PROJECT_NAME`.** Two nodes claiming
  `openpalm` means the second becomes `openpalm-1` **permanently** — the suffix
  survives even after the conflict is resolved — and the UI would advertise a
  URL that does not exist. `OP_PROJECT_NAME` is already unique per host (Docker
  enforces it) and already derives the mDNS names `<base>.local` and
  `<base>-guardian.local` in `mdns-responder.ts`, so the same derivation
  extends naturally and stays consistent with the LAN naming.
- **`TS_STATE_DIR` must be per-stack**, which falls out of distinct `OP_HOME`
  (`${OP_HOME}/data/tunnel`). If it is shared or lost, the node re-registers,
  picks up a suffix, and the public URL changes underneath every bookmark.
- **A reusable auth key**, or interactive login once per stack.
- Each stack counts as one device against the plan. The free Personal plan's
  unlimited user-owned devices covers this; the 6-user limit is unaffected.

Two consequences to design for. First, this makes the **stack rename path
load-bearing**: `recordProjectRename` exists, and a rename would otherwise
change the tailnet hostname and therefore the public URL. The hostname should
be derived once at first registration and then **stored in
`remote-access.json`**, not re-derived on every apply. Second, the mDNS
responder binds UDP 5353 on the host and remains a host-level singleton — it is
unrelated to the tunnel, but it stays the one genuinely contended resource
across stacks.

### 7.3 Routing to guardian or assistant — configurable, and not either/or

`ServeConfig` provides two independent axes, which together give more than a
binary choice:

- `Handlers map[string]*HTTPHandler` is mount-point → handler with
  **longest-prefix matching**, and the matched prefix is **stripped**
  (`http.StripPrefix` at `ipn/ipnlocal/serve.go:1209`) before proxying. The
  proxy target may carry its own path, which Go's `SetURL` re-joins — so a
  `/oc` mount pointed at `http://guardian:8080/oc` resolves correctly.
- `AllowFunnel map[HostPort]bool` is keyed **per port**, so Serve and Funnel
  coexist on one node.

Three shapes therefore fall out of the same generator, selected by `target` in
`remote-access.json`:

1. `"assistant"` — `/` → `http://assistant:3000`. The default.
2. `"guardian"` — `/` → `http://guardian:8080`. For API clients.
3. `"both"` — either `/` → assistant and `/oc` → guardian on one port, **or**
   assistant on 443 and guardian on 8443 with *different funnel bits* — the UI
   private to the user's own devices, Guardian's screened API publicly funneled
   for a bot. That is exactly the 443/8443 pair `docs/remote-access-tls.md`
   already documents, so the manual guide and the toggle produce the same
   topology.

`target` therefore widens from `"assistant" | "guardian"` to
`"assistant" | "guardian" | "both"`. When it includes guardian, two things
follow: the sidecar must join `portal_net` as well as `assistant_net`, and a
guardian-bearing addon must be enabled — the same check
`reconcileGuardianIngressAddons` already performs for `guardianNetwork`.

**Correction to §2:** Funnel's port restriction is not a hardcoded 443/8443/
10000. `CheckFunnelPort` reads the allowed list from the node's
`CapabilityFunnelPorts` attribute delivered by the control plane; those three
are the defaults currently granted. Treat the list as dynamic and read it from
`tailscale status --json` rather than hardcoding it.

## 8. The Bun control-plane surface

**Shell out to `docker compose`. No library, no Docker socket.** `docker.ts`
already commits to `node:child_process` with argv arrays specifically so one
code path serves Bun, Node, and Electron; `Bun.spawn` would fork that for zero
gain, and dockerode is both root-equivalent-adjacent and unverified on Bun
(apocas/dockerode#747 still open). There is no first-party Tailscale Node SDK —
`@tailscale/connect` is a browser WASM client, not a control library — so the
options were shell-out or the file, and this design wants both.

New module `packages/lib/src/control-plane/remote-access.ts`, browser-safe like
`access-toggles.ts`:

```ts
export type RemoteAccessConfig = {
  provider: "tailscale";
  public: boolean;            // Serve (false) vs Funnel (true)
  target: "assistant" | "guardian";
  hostname: string;
};
export function coerceRemoteAccessConfig(value: unknown): RemoteAccessConfig;
/** Pure: config → the ipn.ServeConfig document. The whole derivation. */
export function resolveServeConfig(cfg: RemoteAccessConfig): ServeConfigDoc;
export function describeRemoteExposure(
  toggles: AccessToggles, cfg: RemoteAccessConfig,
): string[];                  // mirrors describeAccessExposure
```

Node-side, mirroring `access-apply.ts` / `access-status.ts`:

```ts
/** Write serve.json atomically INTO the mounted directory. Never delete it. */
export function writeServeConfig(homeDir: string, cfg: RemoteAccessConfig): void;

/** Observed state — injected deps, never throws. */
export type RemoteAccessActual = {
  container: ContainerActualStatus | null;
  registered: boolean;        // node has joined a tailnet
  url: string | null;         // https://<dns-name>
  publicOk: boolean;          // funnel capability actually granted
  authUrl: string | null;     // interactive login URL, if pending
  error?: string;
};
export function fetchRemoteAccessActual(
  state: ControlPlaneState, deps?: Partial<RemoteAccessDeps>,
): Promise<RemoteAccessActual>;

/** One-time enable that surfaces the approval URL instead of failing silently. */
export function requestFunnelApproval(
  state: ControlPlaneState,
): Promise<{ approvalUrl: string | null; error?: string }>;
```

`fetchRemoteAccessActual` runs `composeExec` (already exported from
`docker.ts`) → `docker compose exec -T tunnel tailscale status --json`, reading
`.Self.DNSName` for the URL, `.Self.CapMap` for the funnel capability, and
`.AuthURL` when registration is pending.

**`requestFunnelApproval` is not optional.** `setServeConfigLocked` performs
**no funnel-capability check** on the write path — its only guards are
shields-up and locked-config-file. Writing `AllowFunnel: true` therefore
*succeeds locally* on a tailnet with no HTTPS and no `funnel` nodeAttr, and the
UI would show green while the public URL is dead. The diagnostic errors
(`"Funnel not available; HTTPS must be enabled."`, `"… \"funnel\" node
attribute not set."`) exist **only on the CLI path**. Pre-flight, or drive the
first enable through the CLI. Do not write the boolean blind.

Wiring into `applyAccessToggles`:

- `remoteAccess` participates in `diffAccessEnv` through `OP_REMOTE_ACCESS`, so
  `resolveRecreateScope` maps it to `"tunnel"` via the widened `KEY_OWNER` and
  recreates only that service. The existing scoping rationale — "a guardian-only
  change must not recreate the assistant and drop an in-flight chat turn" —
  applies verbatim.
- `writeServeConfig` runs **before** the recreate, so a fresh container reads
  the right file on first boot.
- Add `reconcileRemoteAccessPrereqs` beside `reconcileGuardianIngressAddons`.
  Here it does the harder job: refuse the apply when `remoteAccess && public`
  and the UI login password is unset or weak.

**The off path must name the service, never rely on omission.** Dropping the
overlay leaves an orphan, and `--remove-orphans` is unreliable across versions:

```
docker compose … stop tunnel && docker compose … rm -sf tunnel
```

Derive displayed state from `composePs`, never from stored intent. Helpfully,
`docker compose ps` is not profile-aware, so a stale tunnel container stays
visible even after the overlay is dropped.

## 9. What the user sees and does

### Copy, in the existing voice

```ts
remoteAccess: "Use the assistant when I'm away from home",

remoteAccess:
  "Open it from anywhere — a coffee shop, a phone on mobile data, a hotel. "
  + "Nothing changes on your router. Everyone still signs in with your password.",
```

Deliberately says nothing about "internet," "tunnel," "TLS," "Funnel," or
"Tailscale" — matching how `networkAccess` avoids "bind address."

Placement: **not** a fifth checkbox under "Show advanced." Its own card below
"Network access," at the same weight as the always-visible `networkAccess` row,
because it is categorically different from the other four — they choose a bind
address, this one starts an outbound tunnel.

The mode appears only once the toggle is on, as a two-option radio:

- **"Only my devices"** *(recommended, preselected)* — "Sign in once on each
  phone or laptop you want to use. Nobody else can reach it, even with the
  address."
- **"Anyone with the link"** — "Anyone who has the address can open your
  sign-in page. Use this to share with someone who can't install anything."

### The one-time setup step

One click, not a token paste. Start the sidecar with **no** `TS_AUTHKEY`;
containerboot logs that login will be interactive and tailscaled emits a
`https://login.tailscale.com/a/<code>` URL. Surface it as a **"Connect your
account"** button (read `.AuthURL` from `tailscale status --json`, or scrape
`composeLogs`, already exported). The user signs in with Google/GitHub/Apple
SSO — no password to invent, no admin console, no secret to copy. Persist a key
to `private/secrets/op_tailscale_authkey` afterwards for unattended
re-registration.

The second one-time step applies **only** to "Anyone with the link": a browser
approval that provisions HTTPS certificates and writes the `funnel` nodeAttr.
Do not deep-link the user into ACL editing — run `tailscale funnel 443 on`,
capture the approval URL, render it as **"Allow public access (one time)"**.
Tailscale writes the policy itself on approval.

### States the toggle must show

Intent and reality stay separate UI elements, exactly as `AssistantTab.svelte`
already does for the "Open on your phone" card (a badge beside, not inside, the
toggle). Model it as a discriminated union:

`off` · `starting` · `awaiting-sign-in{authUrl}` · `awaiting-approval{approvalUrl}`
*(public only)* · `up{url, mode}` · `reconnecting{reason}` ·
`blocked{weak-password | shields-up | docker-down}` · `error{reason, remediation}`

Two hard rules. **Never show the URL before the tunnel reports up**, mirroring
the "advertise LAST" invariant already encoded in `applyAccessToggles` ("a name
is never published ahead of a reachable port"). And while public mode is on,
show a **persistent badge in the app chrome**, not only on the settings page —
an exposure state discoverable only by navigating back to a settings tab is a
state users forget they are in.

Certificate provisioning can take tens of seconds; show named staged progress,
not a spinner.

### Warning copy, public mode only

Second-step confirmation, shown once per enable — and **not** reused for the
four LAN toggles, or it stops meaning anything:

> **Anyone with this address can reach your sign-in page.**
> Your password is the only thing between them and your assistant. Automated
> scanners find new addresses within minutes of the certificate being issued,
> so an address you haven't shared is not the same as an address nobody has.
>
> Your assistant can run commands and read files on this computer.
>
> ☐ I understand. Make it public.

That is not alarmism. Unit 42's 320-node honeypot study saw 80% compromised
within 24 hours; `ts.net` hostnames land in public Certificate Transparency
logs, which Tailscale's own security documentation confirms; and 175,000+
unauthenticated Ollama servers have been catalogued and resold. Publishing an
assistant with tool execution is the same threat class.

**Hard gate, not a warning:** refuse to enable public mode while the UI login
password is unset or weak. `setup-validation.ts` currently accepts any
operator-typed replacement of 8+ characters; OWASP's bar without MFA is 15.
Raise it for this path specifically. The login throttle is good — 5 free
attempts, doubling backoff to a 15-minute ceiling, comfortably inside NIST SP
800-63B — but a throttle is not a substitute for entropy.

## 10. Open risks and what stays manual

**Irreducibly manual:** creating a Tailscale account (SSO, ~3 clicks) and
clicking Connect; the one-time browser approval for public mode; choosing a
strong password; and adding the `ts.net` origin to
`GUARDIAN_CORS_ALLOWED_ORIGINS` *if* the user also uses a Guardian connection
from that origin (already documented in `docs/remote-access-tls.md`; Guardian
rejects `*`). The toggle could write that automatically once the hostname is
known — fast-follow, not v1.

**Risks, ranked:**

1. **Funnel is still beta**, ~4 years after launch. Building a headline feature
   on a permanently-beta capability is a judgement call to make explicitly.
   Mitigation: Serve is GA and is the default; only "Anyone with the link"
   touches beta.
2. **Silent success on the file path** — covered in §7; the pre-flight is
   mandatory. There is a second, broader instance: containerboot's
   `updateServeConfig` calls `isValidHTTPSConfig` first, and when the cert
   domain resolves to `no-https` it logs a warning and applies **nothing at
   all** — so a tailnet without HTTPS breaks the *private* path too.
3. **A malformed or partially-written `serve.json` crashes the sidecar.** Every
   error path in containerboot's watch loop is `log.Fatalf`. With
   `restart: unless-stopped` that is a crash loop, so `writeFileAtomic` is
   load-bearing for correctness, not tidiness.
4. **Free Personal plan is non-commercial only** (6 users). Fine for homelab;
   a business user needs a paid seat. Worth one line in the UI.
5. **Third-party control-plane dependency.** Coordination server, `*.ts.net`
   DNS, cert issuance, and the Funnel relay are all Tailscale-operated. Disclose
   it — it sits awkwardly with the self-hosted premise even though traffic
   itself stays end-to-end encrypted.
6. **Auth-key and node-key expiry.** Auth keys max at 90 days, node keys default
   to 180. Silent expiry drops the sidecar off the tailnet and both URLs die
   with no in-app signal. Tagged nodes are exempt from node-key expiry via
   `--advertise-tags`, but that costs the identity headers on the Serve path.
   Recommendation: keep identity headers, monitor expiry via
   `TS_ENABLE_HEALTH_CHECK`.
7. **`TS_STATE_DIR` must persist** or the node re-registers on every restart:
   new device row, hostname suffixes (`openpalm-1`), and a **changed public
   URL** that breaks every bookmark. Hence the `${OP_HOME}/data/tunnel` volume.
8. **Shields-up conflict.** `setServeConfigLocked` refuses Funnel while
   shields-up is enabled, and because the file path `log.Fatalf`s on apply
   errors, this surfaces as the whole sidecar crash-looping — taking the
   *private* URL down too. Detect shields-up in the pre-flight.
9. **Unverified, and worth testing on day one:** that OpenPalm's token
   streaming works end to end through Funnel. Cloudflare's SSE limitation is
   documented for quick tunnels only, and Tailscale is a different mechanism
   (it proxies TCP, not HTTP semantics, so SSE *should* be fine) — but "should
   be fine" is not "tested." Run the real stack behind `tailscale serve` and
   watch whether tokens stream or arrive in one lump before building anything
   else.
10. **Docker Desktop on macOS/Windows** is fine here *only because* this design
    stays on `TS_USERSPACE=true` (the default). The official Tailscale compose
    example sets `TS_USERSPACE=false` with `/dev/net/tun` and `NET_ADMIN`;
    copying it verbatim would import a Docker Desktop problem for no benefit.

**One decision to make before implementation:** whether the tunnel targets
`assistant:3000` (the UI — what a non-technical user actually wants, gated by
the UI login password and throttle) or `guardian:3830` (better defence in
depth, but it speaks Basic auth with a principal ID and is not usable from a
phone browser). Recommendation: **`assistant:3000`**, with the hard password
gate and the `ADDRESS_HEADER` fix as the price of admission, keeping
`target: "guardian"` in `remote-access.json` as an advanced option for API
clients. Shipping a "reach it from anywhere" toggle that lands on a page a
non-technical user cannot log into would be worse than not shipping it.

## 11. Sources

Primary sources, grouped. All checked against vendor documentation, official
repositories, or package registries rather than secondary write-ups.

**Cloudflare**
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/quick_tunnel.go
- https://github.com/cloudflare/cloudflared/blob/master/Dockerfile
- https://github.com/cloudflare/cloudflared/issues/1449
- https://developers.cloudflare.com/cloudflare-one/policies/access/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/
- https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/

**Tailscale**
- https://tailscale.com/docs/features/tailscale-serve
- https://tailscale.com/docs/features/tailscale-funnel
- https://tailscale.com/docs/features/containers/docker/docker-params
- https://github.com/tailscale/tailscale/blob/main/ipn/serve.go
- https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go
- https://github.com/tailscale/tailscale/blob/main/cmd/containerboot/serve.go
- https://tailscale.com/blog/tls-certs
- https://tailscale.com/pricing

**ngrok**
- https://ngrok.com/docs/agent-sdks/javascript/
- https://github.com/ngrok/ngrok-docs/blob/main/snippets/shared/limits/free-resources.mdx
- https://ngrok.com/docs/traffic-policy/actions/oauth/

**Alternatives**
- https://github.com/openziti/zrok/blob/main/CHANGELOG.md
- https://docs.netfoundry.io/zrok/ (free-tier limits)
- https://github.com/fosrl/newt/blob/main/docker-compose.yml
- https://docs.netbird.io/how-to/netbird-on-faas (rootless image)

**Docker / Compose / SvelteKit**
- https://docs.docker.com/engine/network/
- https://docs.docker.com/compose/how-tos/profiles/
- https://svelte.dev/docs/kit/adapter-node (PROTOCOL_HEADER, ADDRESS_HEADER, XFF_DEPTH)

**Security**
- https://unit42.paloaltonetworks.com/exposed-services-public-clouds/
- https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
- https://pages.nist.gov/800-63-3/sp800-63b.html
