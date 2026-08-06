# Pangolin — a front door the stack itself owns

Status: research + proposal
Companion to `remote-access-from-anywhere.md`, whose recommendation shipped as
the `remote` addon (a `tailscale/tailscale` sidecar named `tunnel`). That
document evaluated Pangolin and deferred it in one paragraph: *"Pangolin Cloud
+ Newt is the cleanest sidecar in the whole field (`fosrl/newt:latest`, three
env vars, no capabilities, no volumes, no host networking) with an
identity-aware proxy offering PIN/OTP/SSO — better auth than Funnel. It loses
on maturity and verifiability: free-tier terms could not be confirmed from a
primary source, and it is a young single-vendor dependency. Most likely future
addition; not v1."* This document is that revisit — and it widens the frame.
The deferral evaluated only the sidecar-to-someone-else's-server shape. The
design below makes the **Pangolin server itself part of the OpenPalm stack**:
the control plane and ingress run as a profile-gated addon inside the same
Compose project, with a connector-only variant kept for operators whose
Pangolin lives elsewhere (their own VPS, or Pangolin Cloud).

An earlier draft of this document rejected in-stack hosting outright,
inheriting the companion document's framing. That was wrong, and the
correction is kept visible in §4.4 rather than silently dropped — the same
policy the companion document applies to its own first-pass errors.

Sourcing note: `docs.pangolin.net` blocks this environment's egress proxy, so
Pangolin claims were verified against the documentation site's source
repository (`fosrl/docs-v2`, the MDX behind docs.pangolin.net, at its
2026-08-04 head) and the `fosrl/pangolin` / `fosrl/newt` source trees. Claims
about the OpenPalm side were verified against this working tree. Where a
claim could not be verified either way, it is hedged and listed as a
verification item in §10.

## 1. What the shipped `remote` addon cannot do

Four limits of the Tailscale design — the first disclosed in the companion
document's §3 comparison table, the third and fourth in its §2 costs
paragraph and §10 risks, the second implicit throughout (the URL is always
`<node>.<tailnet>.ts.net`):

1. **Public mode has no auth gate.** Funnel strips tailnet identity and sets
   `Tailscale-Funnel-Request: ?1`; anyone with the URL reaches the sign-in
   page, and the UI login password is the only door. The companion document's
   answer was a hard password gate plus warning copy — a mitigation, not a
   feature.
2. **The hostname is not yours.** `https://<node>.<tailnet>.ts.net`, on
   Funnel-legal ports only. No custom domain, ever.
3. **The coordination plane is proprietary SaaS.** Traffic stays end-to-end
   encrypted, but registration, `*.ts.net` DNS, cert issuance, and the Funnel
   relay are all Tailscale-operated — already listed as risk 5 ("it sits
   awkwardly with the self-hosted premise").
4. **The free Personal plan is non-commercial only.** (The companion document
   records a six-user limit; Tailscale's published figure has shifted over
   time and could not be re-verified from this environment. The point stands
   at any count: it is a personal tier.)

Pangolin answers all four: an identity-aware proxy (SSO, OIDC, email OTP,
PIN, header auth, path/IP/geo rules) in front of every public HTTP resource;
any subdomain of a domain you own, with Let's Encrypt certificates; an
AGPL-3.0 control plane; and no per-user pricing on the self-hosted Community
Edition. And because the control plane is self-hostable, OpenPalm can go one
step further than "supports Pangolin": it can **be** the Pangolin host, so
the whole path — TLS termination, auth gate, routing — runs on the
operator's own hardware, inside the stack's own Compose project, managed by
the same control plane that manages everything else.

## 2. The deferral, re-verified

The two blockers named in the deferral, checked again:

**Maturity.** `fosrl/pangolin` was created September 2024. It is at release
1.21.x (confirmed from the repository's tags) with roughly 22k GitHub stars,
active companion repositories for every component (`newt`, `gerbil`,
`badger`, `olm`, desktop and mobile clients), Helm charts, and a DigitalOcean
Marketplace image (per the docs' VPS guide). The cadence is fast — 1.7 to
1.21 inside a year — which cuts both ways: alive and improving, but
interfaces move (§10 risk 1 shows a concrete instance this document itself
tripped over). "Young" is now a risk to manage, not a disqualifier.

**Free-tier verifiability.** Now confirmable from primary sources. The
Community Edition is free and AGPL-3.0 (per-file licensing; files headed
"Fossorial Commercial License" are the Enterprise Edition, a separate
`fosrl/pangolin:ee-*` image gated on a license key, free for personal use and
organizations under $100k gross annual revenue). For the in-stack shape this
matters directly: CE self-hosted is the edition the addon ships, and it costs
nothing at any user count.

One blocker the deferral did not name, because the sidecar shape never hits
it: **Pangolin Cloud's free tier provides no domain.** Pangolin-provided
domain endings (`.hostlocal.app`, `.tunneled.to`) are documented as paid-plan
features, and attaching a custom domain to Cloud requires NS-delegation or
CNAME records. The Cloud path is therefore *not* the zero-DNS non-technical
path the deferral implied. Hosting the server in-stack does not remove the
domain requirement — but it removes the vendor from it, and OpenPalm can
automate everything except the DNS record itself.

## 3. Replace Tailscale, or offer Pangolin alongside it?

**Alongside. Pangolin is a second front door, not a successor.** Three
reasons, in decreasing order of weight:

1. **Pangolin requires things Tailscale does not.** Every publicly useful
   Pangolin shape needs a domain the operator controls, a DNS record, and a
   host the internet can reach (a public IP, or a router that can forward
   80/443). Tailscale Serve needs an SSO sign-in and nothing else. For "use
   it from my phone" — the majority case, including every CGNAT home — Serve
   remains the right default.
2. **Private access is not Pangolin's strong suit yet.** Serve covers
   only-my-devices access with GA tooling on every platform. Pangolin's
   equivalent (private resources reached through Olm-based clients) is the
   youngest part of the product. Pangolin's strength is precisely the mode
   Tailscale is weakest in: *public* exposure with real auth in front.
3. **The two compose.** The `remote` tunnel dials out and publishes nothing;
   Pangolin's ingress listens on 80/443. They share no ports, no config, no
   failure modes. Private tailnet access for the operator plus a public
   SSO-gated domain for everyone else is a legitimate, useful topology — a
   replace-or-choose model would forbid it for no reason.

The honest comparison, on the criteria the companion document used:

| | Tailscale Serve/Funnel (shipped) | Pangolin in-stack (proposed) | Pangolin connector → external server |
|---|---|---|---|
| Works behind CGNAT | yes (outbound sidecar) | **no** for public exposure (host must be reachable); LAN-only mode still works | yes (outbound sidecar) |
| Infrastructure required | none | a domain + one DNS record; reachable 80/443 | a Pangolin server somewhere (own VPS or Cloud) |
| Custom domain | no (`*.ts.net`) | yes, any subdomain, LE certs | yes (Cloud free tier: bring your own domain + DNS records) |
| Auth in front of public mode | **none** (password is the only door) | SSO / OIDC / email OTP / PIN / header auth / access tokens / path+IP+geo rules | same |
| Vendor can read traffic | no — relays proxy still-encrypted TCP by SNI | **no — TLS terminates inside the stack, on the operator's hardware** | Cloud: yes (TLS terminates on Fossorial's node). Own VPS: no |
| Control plane operated by | Tailscale (proprietary SaaS) | **the stack itself** (AGPL CE) | whoever runs that server |
| Free-plan terms | non-commercial personal tier | CE: free, AGPL, unlimited | Cloud free tier: no provided domain; terms not contractual |
| Bot/API exposure | Funnel only, unauthenticated | per-resource access tokens, Basic header auth, per-path rules | same |
| Moving parts added to the stack | 1 sidecar | 2 containers (3 with tunneling) | 1 sidecar |

The "vendor can read traffic" row is why the in-stack shape is the headline
and Cloud is the fallback: the companion document weighted exactly this
against Cloudflare and ngrok, and with Pangolin Cloud (no self-hosted node)
TLS for public resources terminates on Fossorial's Traefik. In-stack, the
entire path is the operator's.

## 4. The shape: the Pangolin server as a stack addon

Pangolin's server side is **three containers plus one Traefik plugin**:
`pangolin` (Node.js control plane: dashboard, REST API, SQLite state, and a
dynamic-config endpoint Traefik polls), `traefik` (ingress: TLS termination,
Let's Encrypt, routing), `gerbil` (WireGuard tunnel manager — needed only
when remote networks tunnel *into* this server), and `badger`, a forward-auth
middleware that runs *inside* Traefik as a plugin, enforcing Pangolin's auth
on public resources. The site side is one container: `newt`, userspace
WireGuard, outbound-only.

### 4.1 One addon, three variants

A single builtin addon `pangolin`, using the same mutually-exclusive
profile-variant machinery voice and ollama already use
(`openpalm.profile.label` / `openpalm.profile.requires` /
`openpalm.profile.default` labels, selection stored as `OP_PANGOLIN_PROFILE`
via `profileEnvKey`, rendered by the existing profile selector in
`AddonsTab.svelte`):

| Variant | Compose profile | Services deployed | For |
|---|---|---|---|
| **Proxy** (default) | `addon.pangolin.proxy` | `pangolin`, `pangolin-traefik` | The full server, no tunneling — Pangolin's documented "without tunneling" mode. Resources reach the assistant over the Docker network as a **local site**. No added capabilities anywhere. |
| **Tunnel** | `addon.pangolin.tunnel` | `pangolin`, `pangolin-traefik`, `gerbil` | The full server *plus* WireGuard ingress, for operators who also want other machines' services tunneled into this stack's Pangolin, or Pangolin clients. Costs `NET_ADMIN` + `SYS_MODULE` on gerbil and two UDP host ports. |
| **Connector** | `addon.pangolin.connector` | `newt` | No server in-stack — a Newt sidecar pointed at a Pangolin elsewhere (operator's VPS, or Pangolin Cloud). The deferral's original shape. |

The variant machinery fits because the three shapes are genuinely mutually
exclusive per stack (a server and a connector to *another* server would
fight over which control plane defines this stack's resources), while
`remote` stays a separate addon because running Tailscale *and* Pangolin
simultaneously is legitimate (§3). This is also why Pangolin is not folded
into the `remote` addon behind a provider field: variants model exclusive
alternatives, sibling addons model co-runnable features, and the two addons
share no configuration at all.

`docker compose config` treats multiple services per profile exactly as it
does guardian's multi-profile block, so `pangolin` and `pangolin-traefik`
listing both server profiles is ordinary Compose.

### 4.2 What in-stack hosting requires from the host — stated honestly

The companion document's §1 constraint has not moved: **a CGNAT home cannot
be reached from the internet**, and no in-stack server changes that. What
has changed is the recognition that OpenPalm installs are not only CGNAT
homes. The proxy and tunnel variants are for hosts the internet can reach —
a VPS running the whole OpenPalm stack, a homelab behind a router that can
forward 80/443, a machine with a static IP. For those hosts the requirements
are:

- a domain the operator controls, with a wildcard (or per-name) A record
  pointing at the host — the one step OpenPalm cannot automate;
- TCP 80 and 443 reachable from the internet (80 is droppable with wildcard
  DNS-01 certificates, which Pangolin supports via Traefik's DNS providers);
- UDP 51820 and 21820 additionally, for the tunnel variant only.

A CGNAT home still has two working options: the **connector** variant
(outbound to a server that is reachable), or the proxy variant used
**LAN-only** — Pangolin's docs explicitly support running it as "a local
reverse proxy and authentication manager". LAN-only, it puts SSO and real
TLS (via DNS-01, which needs no inbound reachability) in front of the
assistant on the home network — which is precisely the Tier-1 shape
`tls-on-the-home-network.md` costs at "about a week" to build from parts.
One addon, both roadmap documents.

### 4.3 Host ports 80/443, stated against the loopback-first convention

Every existing addon publishes loopback-only, as a literal. The Pangolin
server addon is the first whose *purpose* is a public listener, and
pretending otherwise would produce the exact failure the companion document
condemns in its DDNS epitaph: a toggle that reports success and simply does
not work. So the proxy/tunnel variants publish

```yaml
- "${OP_PANGOLIN_HTTP_BIND:-0.0.0.0}:${OP_PANGOLIN_HTTP_PORT:-80}:80"
- "${OP_PANGOLIN_HTTPS_BIND:-0.0.0.0}:${OP_PANGOLIN_HTTPS_PORT:-443}:443"
```

with the deliberate act being the addon enable itself: the UI treats
enabling a server variant as an exposure change with the same weight as
`OP_REMOTE_PUBLIC` — explicit confirmation, warning copy, no silent default
(§8.5). The bind and port variables exist for the operator who fronts
Pangolin with something else or needs 80/443 for another service; the
defaults are the ones that work. This deviation is confined to the two
server variants; the connector variant publishes nothing, exactly like
`tunnel`. `core-principles.md` § Service port assignments gains rows for
80/443 (deliberately non-loopback, purpose-stated) and for the
integration API's loopback publication (§6.1).

### 4.4 The correction: why the earlier rejection was wrong

The first draft rejected in-stack hosting on three grounds. Each fails:

- *"Four always-on containers."* Miscounted (badger is a plugin, not a
  container) and mis-scoped: the services are profile-gated like every
  addon, so a default install deploys none of them.
- *"NET_ADMIN + SYS_MODULE violate the rootless convention."* Those
  capabilities belong to gerbil alone, and gerbil exists only in the opt-in
  tunnel variant. The proxy variant adds no capabilities to anything.
- *"Pointless without a public IP."* False twice: port-forwarding homes and
  VPS installs have reachable 80/443 without a "public IP" on the host
  itself, and the LAN-only reverse-proxy mode (§4.2) is useful with no
  reachability at all.

What survives of the original instinct is §4.2's honesty: the server
variants are not for CGNAT homes, and the UI must ask the one question that
distinguishes the cases instead of guessing (§10, the decision).

## 5. How it maps onto the shipped model

Following `docs/technical/adding-an-addon.md`'s checklist, with `remote` as
the nearest shipped precedent:

| Convention | `remote` (shipped) | `pangolin` (proposed) |
|---|---|---|
| Addon id in `BUILTIN_ADDON_IDS` (`addon-ids.ts`) | `remote` | `pangolin` |
| Compose services, profile-gated | `tunnel` under `addon.remote` | `pangolin` + `pangolin-traefik` under `addon.pangolin.proxy` and `.tunnel`; `gerbil` under `.tunnel` only; `newt` under `.connector` |
| Profile variants | none | voice/ollama machinery: `openpalm.profile.*` labels, `OP_PANGOLIN_PROFILE` selection |
| Images | `tailscale/tailscale:v1.98.10@sha256:…` | `fosrl/pangolin`, `traefik`, `fosrl/gerbil`, `fosrl/newt` — each pinned to a release *and* digest at implementation time; upstream's compose floats `latest`, ours must not |
| Config keys in `state/stack.env` | `OP_REMOTE_TARGET/PUBLIC/HOSTNAME` | `OP_PANGOLIN_PROFILE/BASE_DOMAIN/DASHBOARD_DOMAIN/ACME_EMAIL/HTTP_PORT/HTTPS_PORT/TARGET`; connector adds `OP_PANGOLIN_ENDPOINT/NEWT_ID` |
| Delegated secrets (`DELEGATED_SECRET_NAMES`) | `ts_authkey` | `newt_secret` (connector; operator-pasteable, same class as `ts_authkey`), `pangolin_server_secret` (server variants; generated once), `pangolin_api_key` (optional, §8) |
| Generated artifacts | `state/remote/serve.json` | `private/pangolin/config.yml` (embeds the server secret, hence `private/`), `state/pangolin/traefik/*.yml`, `private/secrets/newt_config` (connector), `state/pangolin/blueprint.yml` (§8.1) — all written with `writeFileAtomic`, none in `DELEGATED_SECRET_NAMES` (that set is for operator-suppliable credentials; generated files are seeded by explicit `ensureSecret`/`ensureHomeDirs` calls, the way `ts_authkey` and `serve.json` are handled today) |
| Apply hook | `if (name === 'remote') applyRemoteAccess(...)` in `addons.ts` and the credentials route | `applyPangolinConfig(...)` — and this being the **second** special case, both migrate to the declaration table the addon guide prescribes ("two is a signal to generalize"): `ADDON_APPLY_HOOKS: Record<string, (homeDir: string) => AddonApplyResult>` |
| Recreate scope (`ADDON_ENV_RECREATE_SCOPE`) | `OP_REMOTE_*` → `["tunnel"]` | `OP_PANGOLIN_*` → the variant's services |
| Guardian ingress | `remoteRequiresGuardianIngress(enabled, target)` through `resolveAccessEnv(toggles, { guardianIngressRequired })` | the same hook — see below |
| Network membership | `assistant_net` + `portal_net`, stated exception in the `services.compose.yml` header | data path only (§6): `pangolin-traefik` (proxy) or `gerbil` (tunnel) or `newt` (connector) joins `assistant_net` + `portal_net`; the `pangolin` control plane joins only a new `pangolin_net` |
| Host ports | none, deliberately | server variants: 80/443 (+UDP pair for tunnel), §4.3; integration API loopback-only; connector: none |
| Contract test | `remote-compose.test.ts` (pins image digest, both networks, no ports, rootless, no literal secret) | `pangolin-compose.test.ts`, same assertions per variant — network posture is pinned *here*, not in `addon-network-boundary.test.ts`'s `ADDON_SERVICES` sweep, which asserts addon_net-only segmentation and deliberately excludes ingress-path services (it excludes `tunnel` today for the same reason) |

**Guardian ingress keeps one writer.** `resolveAccessEnv`'s
`guardianIngressRequired` option is documented as "the ONE place another
feature may add a reason for `GUARDIAN_DIRECT_INGRESS` to be `true` without
also opening the LAN bind." With two front-door addons, two apply hooks
recomputing that flag from different inputs would drift. The predicate
generalizes to one shared function reading both addons' state:

```ts
/** True when ANY enabled front-door addon targets the guardian. The only
 *  input resolveAccessEnv's guardianIngressRequired option may be fed. */
export function computeGuardianIngressRequired(env: Record<string, string>): boolean;
```

Both `applyRemoteAccess` and `applyPangolinConfig` call it; neither owns it.
The existing warning behavior carries over: when the target includes
guardian but no `GUARDIAN_INGRESS_ADDON_IDS` addon is enabled, warn, do not
auto-fix.

### 5.1 Files touched

Create: the four service blocks and `pangolin_net` declaration
(`packages/skeleton/system/stack/services.compose.yml`,
`core.compose.yml` networks block); `packages/lib/src/control-plane/`
`pangolin-access.ts` (browser-safe model + config/traefik/blueprint
derivation) and `pangolin-apply.ts` (file writes, `pangctl`/API calls);
`pangolin-compose.test.ts`; the provisioning route
(`packages/ui/src/routes/api/host/addons/pangolin/provision/+server.ts`);
`docs/pangolin-setup.md` (user guide).

Modify: `addon-ids.ts`; `addon-env-schemas.ts` (schema + recreate scope);
`addons.ts` (the `ADDON_APPLY_HOOKS` generalization); `secrets.ts`
(seeding); `secrets-files.ts` (three delegated names); `access-toggles.ts`
(`computeGuardianIngressRequired`); `home.ts` (`ensureHomeDirs` entries for
`state/pangolin/`, `data/pangolin/`); `AddonsTab.svelte` (variant selector
reuse + provision panel); `docs/technical/core-principles.md` (port table,
the §4.3 deviation); `docs/technical/environment-and-mounts.md`;
`docs/technical/network-partitioning-d5a.md`;
`packages/skeleton/system/stack/README.md`;
`docs/operations/manual-headless-install.md` — which today documents neither
the `remote` addon nor this one; add both sections in this change.

## 6. The compose wiring

### 6.1 The server (proxy and tunnel variants)

Network layout first, because it is the design's security core. A new
`pangolin_net` joins the three existing networks in `core.compose.yml`'s
declarations. The `pangolin` control plane lives **only** there. The data
path — whichever container holds the ingress network namespace — joins
`assistant_net` + `portal_net` under the same stated-exception bar as
`tunnel`. Traefik must reach both the control plane (config polling,
dashboard/API routing) and the proxy targets, so:

- **Proxy variant:** `pangolin-traefik` joins `pangolin_net` +
  `assistant_net` + `portal_net`, and publishes 80/443.
- **Tunnel variant:** `gerbil` owns the netns (`pangolin-traefik` runs with
  `network_mode: service:gerbil`, upstream's documented layout), so
  *gerbil* joins the three networks and publishes 80/443/51820/21820.

The control plane never being on `assistant_net` means a compromised
Pangolin dashboard cannot reach OpenCode (:4096) directly — only route
traffic through Traefik to targets, which is its job description anyway.

```yaml
  pangolin:
    profiles: ["addon.pangolin.proxy", "addon.pangolin.tunnel"]
    # Release + digest pinned at implementation time, same convention as
    # tunnel above; upstream's own compose floats `latest`, ours must not.
    image: fosrl/pangolin:REPLACE_VERSION@sha256:REPLACE_DIGEST
    labels:
      openpalm.profile.label: "Server (reverse proxy only)"   # on .proxy
      openpalm.profile.default: "true"
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    volumes:
      # config.yml embeds server.secret, so the whole generated config dir
      # lives under private/ (0700), not state/. db/ and letsencrypt/ are
      # service-owned runtime data and stay under data/ — nested binds below
      # put them where Pangolin expects inside /app/config.
      - ${OP_HOME}/private/pangolin:/app/config
      - ${OP_HOME}/data/pangolin/db:/app/config/db
      - ${OP_HOME}/data/pangolin/letsencrypt:/app/config/letsencrypt
    ports:
      # Integration API, loopback ONLY as a literal — the host control plane
      # is its only intended caller (§8.1). Never routed through Traefik.
      - "127.0.0.1:${OP_PANGOLIN_API_PORT:-3841}:3003"
    networks: [pangolin_net]
    healthcheck:
      # Upstream's own check: internal API answers when the server is up.
      test: ["CMD", "curl", "-f", "http://localhost:3001/api/v1/"]
      interval: 10s
      timeout: 10s
      retries: 15

  pangolin-traefik:
    profiles: ["addon.pangolin.proxy", "addon.pangolin.tunnel"]
    image: traefik:REPLACE_VERSION@sha256:REPLACE_DIGEST   # v3.6.x line
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    depends_on:
      pangolin:
        condition: service_healthy   # same-profile services; the parse-error
                                     # hazard tunnel documents applies only to
                                     # depends_on ACROSS profile sets
    command: ["--configFile=/etc/traefik/traefik_config.yml"]
    volumes:
      - ${OP_HOME}/state/pangolin/traefik:/etc/traefik:ro   # GENERATED, §7
      - ${OP_HOME}/data/pangolin/letsencrypt:/letsencrypt
    # Proxy variant only (the tunnel variant replaces networks/ports with
    # network_mode: service:gerbil):
    ports:
      - "${OP_PANGOLIN_HTTP_BIND:-0.0.0.0}:${OP_PANGOLIN_HTTP_PORT:-80}:80"
      - "${OP_PANGOLIN_HTTPS_BIND:-0.0.0.0}:${OP_PANGOLIN_HTTPS_PORT:-443}:443"
    # The data-path exception, same bar as tunnel: assistant_net to reach
    # http://assistant:3000, portal_net to reach http://guardian:3830.
    networks: [pangolin_net, assistant_net, portal_net]
```

The `gerbil` block (tunnel variant only) follows upstream's: `cap_add:
[NET_ADMIN, SYS_MODULE]`, the UDP pair plus 80/443, `--remoteConfig`
pointing at `http://pangolin:3001/api/v1/`, key material under
`data/pangolin/gerbil/`. Its capabilities are the variant's stated price,
carried in its `openpalm.profile.requires` label.

Two upstream deltas to note in the compose comments: OpenPalm's rootless
`user:` convention must be **verified per image** here (Pangolin's own
compose runs all three as root; whether each tolerates an arbitrary uid —
including Traefik binding :80/:443 in-container, which Docker's default
`ip_unprivileged_port_start=0` permits — is a day-one item, §10), and
`badger` arrives through Traefik's plugin mechanism, which **downloads the
plugin at container start**. That collides with the no-runtime-downloads
principle; the mitigation is Traefik's local-plugins mode with the plugin
source vendored into the mounted config tree, evaluated at implementation
(§10 risk 4).

### 6.2 The connector variant

Carried from the earlier draft with one correction. The `newt` service:
digest-pinned `fosrl/newt`, rootless (verify, §10), no ports, no
`depends_on`, `networks: [assistant_net, portal_net]` with the tunnel-style
stated exception, log caps, `DISABLE_CLIENTS: "true"`, and healthcheck
`test: ["CMD", "test", "-f", "/tmp/healthy"]` with `HEALTH_FILE=/tmp/healthy`
(Newt touches the file only once its tunnel is up, so "healthy" means
tunnel-up, not process-up).

Credentials reach it as one mounted JSON document — `CONFIG_FILE:
/run/secrets/newt_config`, generated by `applyPangolinConfig` from
`OP_PANGOLIN_ENDPOINT`, `OP_PANGOLIN_NEWT_ID`, and the `newt_secret` file —
because Newt has no `*_FILE` variant of `NEWT_SECRET` and a literal
`environment:` value would land in `docker inspect`. The correction:
`CONFIG_FILE` is Newt's general **read-and-write** config file, not a
secrets mechanism — Newt persists credentials back into it in some paths
(`saveConfig()` in `websocket/config.go` does a read-modify-write), and a
Compose secret mount is read-only, where Newt logs the failed write and
continues. That combination must be confirmed harmless on day one (§10).

Disable semantics, stated honestly: stopping the container drops the
outbound tunnel and the public URL goes dark — but unlike `remote`, whose
empty serve document is on disk before any stop is attempted, a *failed*
`compose stop` here leaves the tunnel up until it succeeds. When an API key
is on file (§8), the disable path should also disable the resource
server-side, restoring belt-and-braces; without one, the narrower guarantee
is a documented cost. In-stack server variants do not share this gap: their
ingress dies with the containers.

Like `ts_authkey`, `newt_secret` and `newt_config` are seeded at install by
explicit `ensureSecret` calls — `newt_config` because Compose fails
container creation outright when a declared secret's source file is missing
(it is the one declared Compose secret), `newt_secret` so the drawer and the
generator always have a stable 0600 file to read and overwrite. A blank
`newt_config` just means "not configured yet": Newt exits, the container
restarts, the UI shows unhealthy until credentials arrive.

## 7. What the control plane writes

Following the intent-in-`stack.env` / secrets-in-`private/` /
runtime-data-in-`data/` split:

```
~/.openpalm/
├─ state/stack.env                       # INTENT (existing file, new keys)
│    OP_ENABLED_ADDONS=...,pangolin
│    OP_PANGOLIN_PROFILE=proxy           # proxy | tunnel | connector
│    OP_PANGOLIN_BASE_DOMAIN=example.com
│    OP_PANGOLIN_DASHBOARD_DOMAIN=       # empty → pangolin.<base_domain>
│    OP_PANGOLIN_ACME_EMAIL=
│    OP_PANGOLIN_TARGET=assistant        # assistant | guardian | both
│    OP_PANGOLIN_ENDPOINT=               # connector only
│    OP_PANGOLIN_NEWT_ID=                # connector only
│
├─ state/pangolin/                       # GENERATED, non-secret
│    traefik/traefik_config.yml          #   static config: providers, ACME
│    traefik/dynamic_config.yml          #   dashboard/API routers
│    blueprint.yml                       #   desired resources — §8.1
│
├─ private/pangolin/config.yml           # GENERATED, 0600 — embeds
│                                        #   server.secret, so private/
├─ private/secrets/
│    pangolin_server_secret              # generated once at first enable
│    pangolin_api_key                    # optional, pasted (§8.1)
│    newt_secret                         # connector: pasted or API-minted
│    newt_config                         # connector: GENERATED (§6.2)
│
└─ data/pangolin/                        # service-owned runtime data
     db/db.sqlite                        #   accounts, sites, resources
     letsencrypt/acme.json               #   certificates (regenerable)
     gerbil/                             #   tunnel variant key material
```

All generated files are derived by pure functions in `pangolin-access.ts`
(config model → config.yml / traefik configs / blueprint document — the
`resolveServeConfig` pattern) and written by `pangolin-apply.ts` with
`writeFileAtomic`. Like `serve.json`, the generated tree lives outside
`system/` because `overwriteSystemTree` replaces `system/` wholesale on
update. Data directories are bind mounts pre-created by the existing
`ensureComposeVolumeTargets` machinery; `data/pangolin/` inherits the
Paperclip precedent — service-owned data, excluded from lifecycle safety
backups, and the blueprint file is what makes that acceptable: losing
`db.sqlite` loses accounts and API keys, but the stack's *resources* are
re-appliable from the blueprint OpenPalm itself generates.

The env schema, in the established annotation DSL — one schema covering all
variants, the way voice's covers its variants; connector-only fields say so
in their descriptions rather than pretending `@required` is enforced (the
credentials-route parser reads only `@sensitive`/`@boolean` today and
ignores the rest, as `remote-addon-registry.test.ts` records):

```
# OpenPalm Pangolin configuration
# ---
# Puts a real web address, with a sign-in page, in front of this assistant.
# The "Server" profiles run Pangolin inside this stack on your own domain;
# the "Connector" profile links this stack to a Pangolin server you run
# elsewhere (or Pangolin Cloud) instead.

# The domain resources are attached to, e.g. "example.com". Server profiles
# only. You must own this domain and point a DNS record at this machine —
# the setup guide walks through the one record to create.
OP_PANGOLIN_BASE_DOMAIN=

# Where the Pangolin dashboard lives. Leave blank to use
# pangolin.<your base domain>.
OP_PANGOLIN_DASHBOARD_DOMAIN=

# Email address Let's Encrypt sends certificate-expiry notices to. Server
# profiles only.
OP_PANGOLIN_ACME_EMAIL=

# What Pangolin's resources may point at: assistant, guardian, or both.
# Most people only ever need "assistant" — the guardian target is for
# advanced setups that also expose bot/API portals remotely.
OP_PANGOLIN_TARGET=assistant

# Connector profile only: the Pangolin server this stack connects to, e.g.
# https://app.pangolin.net for Pangolin Cloud, or your own server's
# dashboard address. Note the privacy trade: through Pangolin Cloud,
# visitor traffic is decrypted on Pangolin's servers before it reaches
# you; through your own server (or the in-stack profiles), it is
# decrypted only on hardware you control.
OP_PANGOLIN_ENDPOINT=

# Connector profile only: the site ID your Pangolin server generated
# (shown as "Newt ID"). Pangolin's docs treat only the secret below as
# sensitive.
OP_PANGOLIN_NEWT_ID=

# Connector profile only, and required there: the site secret generated
# beside the Newt ID. Treat it like a password — anything that has it can
# impersonate this site to your Pangolin server.
# @sensitive
NEWT_SECRET=
```

## 8. Making it configurable by a non-technical person

This is where in-stack hosting earns its keep. Every previous shape left a
gauntlet of third-party dashboard steps between a non-technical operator
and a working front door. With the server inside the stack, OpenPalm's
control plane can run almost the entire gauntlet itself, because every
piece of it is reachable from the host: generated config files, `pangctl`
over `composeExec` (the pattern `remote`'s status read-back already
planned), and the integration API on loopback.

### 8.1 The server path, automated end to end

The operator answers three questions — the domain, the email for
certificates, and "can the internet reach this machine?" — and creates one
DNS record with a copy-paste value the UI displays. Everything else is
OpenPalm's:

1. **Generate** `config.yml` (server secret minted into
   `pangolin_server_secret`; `flags.enable_integration_api: true`;
   `flags.disable_signup_without_invite: true`; dashboard URL and CORS
   origins derived from the domain keys) and the two Traefik files, then
   bring up the variant's services.
2. **Bootstrap the admin account headlessly**: `docker compose exec
   pangolin pangctl set-admin-credentials --email <owner> --password
   <generated>` — no setup-token dance, no dashboard visit. The generated
   password is surfaced once with a copy button (the pairing-code
   precedent) as the operator's Pangolin dashboard login.
3. **Mint an API key.** The one step the documented surfaces keep manual:
   API keys are created in the dashboard (Server Admin → API Keys for CE
   root keys). The UI deep-links straight to that page with three-step
   copy, and the pasted key lands in `pangolin_api_key`. If a `pangctl` or
   seed path for key creation exists or appears upstream, this step
   disappears; verify at implementation (§10).
4. **Apply the blueprint.** `pangolin-access.ts` renders
   `state/pangolin/blueprint.yml` — sites, resources, targets, and auth as
   declarative YAML, which is both Pangolin's documented automation format
   and exactly the kind of hand-editable plain file the control plane
   already trades in. Applied via the integration API on loopback
   (`PUT /org/{orgId}/blueprint`, base64 payload) or Pangolin's CLI. The
   rendered default:

   ```yaml
   public-resources:
     assistant:
       name: Assistant
       mode: http
       full-domain: assistant.example.com     # derived from stack.env
       auth:
         sso-enabled: true                    # Pangolin's default gate
       targets:
         - site: openpalm-local               # the local site, this host
           hostname: assistant                # Docker service DNS
           port: 3000                         # in-container port — not 3800
           method: http
   ```

   One hedge, stated plainly: the API guide documents creating **Newt**
   sites only; creating a *local* site programmatically is visible in the
   Swagger surface but not in the walkthrough docs. If it turns out to be
   dashboard-only, the flow degrades to one guided dashboard step
   ("Add Site → Local", deep-linked) before the blueprint apply. Verify at
   implementation (§10). Direct API calls are the fallback for anything the
   blueprint format cannot express — using the **current** route names
   (`PUT /org/{orgId}/public-resource` with `mode: "http"`,
   `PUT /public-resource/{id}/target`); the `/org/{orgId}/resource` +
   `http: true` + `method` forms this document's first draft specced are
   marked deprecated legacy aliases in the Pangolin source.
5. **Read back and advertise last.** Resource URLs are shown with a copy
   button only after Traefik holds a certificate and the resource answers —
   staged progress, not a spinner, because ACME issuance takes tens of
   seconds and DNS propagation can take longer (both get named states,
   §8.4).

When `OP_PANGOLIN_TARGET` includes guardian, the blueprint adds a second
resource (`<name>-api` → `guardian:3830`) with access-token or Basic
header auth — Pangolin passes both; Guardian still authenticates principals
itself, so the gate is defense in depth, not a replacement. Never port 3831
(§9).

### 8.2 The connector path

For the operator whose Pangolin lives elsewhere. The floor is the paste
path: three schema fields plus the secret, with `docs/pangolin-setup.md`
walking the remote dashboard's "Add Site → Newt" flow and supplying the
exact values a human would otherwise mistype:

| Pangolin asks | Enter | Why |
|---|---|---|
| Site type | Newt | the only type this variant runs |
| Resource type | HTTP | raw TCP/UDP resources have **no auth layer** — never use them for this stack |
| Target address | `assistant` | Docker service DNS, resolved from inside the newt container |
| Target port | `3000` | the UI's in-container port — not 3800 (host publishes are host-facing only) |
| Guardian target (advanced) | `guardian`, port `3830` | only with `OP_PANGOLIN_TARGET` including guardian |

The headline remains one click where the remote server's integration API is
reachable and a key is pasted: mint the site (`PUT /org/{orgId}/site`,
`type: "newt"` — returns `newtId` and the secret), write the credentials,
enable, then resource + target + auth via blueprint or the current-surface
calls above. Two honest caveats carry over from the first draft: on
self-hosted CE the integration API is off by default (the guide's
enable-the-API section covers it, and the drawer falls back to the paste
path — presented as fully supported, not degraded), and on Pangolin Cloud's
free tier the org may have **no domain at all** (§2), so the flow must
handle an empty `GET /org/{orgId}/domains` by walking the operator through
attaching one rather than assuming an entry exists.

### 8.3 Setup-spec / headless

`addons: {pangolin: true}` works today through the generic spec path, and
the config keys are ordinary `state/stack.env` keys plus delegated secret
files — so the headless recipe is: write the keys, write the secrets, run
`openpalm start`. It belongs in `docs/operations/manual-headless-install.md`,
which today documents neither this addon nor `remote`'s `TS_AUTHKEY`
pre-authorization path (that guidance lives only in the remote env schema);
add both sections in this change. A first-class `pangolin:` spec object
would extend the spec's one existing per-addon surface — `portalCredentials`,
the addon-id-keyed credential map for discord/slack — rather than invent the
pattern; that is a fast-follow decision, not v1.

### 8.4 States the UI must show

Intent and observed state stay separate, as the LAN access card renders
them. The addon's status is a discriminated union; the server variants add
states the connector never needed, because certificate issuance and DNS are
now the stack's to narrate:

`off · awaiting-config · starting · dns-pending{expected, observed} ·
issuing-certificate · up{urls} · degraded{service} ·
error{reason, remediation}`

Sourced from facts with different owners, mirroring `access-status.ts`:
enablement and config from `state/stack.env`; container health from
`compose ps` (three containers in server variants — `degraded` names which
one); DNS by resolving the dashboard domain and comparing against the
host's addresses (the `dns-pending` state shows the record the operator
still needs to create, with a copy button); certificate and resource state
from the integration API on loopback when a key is on file. The connector
variant keeps the earlier draft's states (`connecting{endpoint}`,
tunnel-up-vs-container-up from the health file) and its discipline: without
an API key, show the endpoint and a "check your Pangolin dashboard" link
rather than fabricating a URL the stack cannot verify — the same rule as
`describeRemoteExposure` reporting a port, never a URL.

### 8.5 Copy, in the existing voice

Proposed wording — noting honestly that the addons list renders no
descriptions today (name and status only), so the first of these lands
wherever descriptions land when they exist, or in the wizard card if the
addon is ever offered at install time:

```ts
pangolin: "Put your assistant on a web address you own, with a sign-in
page in front",
```

Drawer intro, distinguishing the two front doors in the operator's terms:

> **Remote** (Tailscale) is for your own devices — nothing to configure,
> nobody else can get in. **Pangolin** is for a real web address you can
> share — it shows a sign-in page to anyone who visits. You can use both at
> once.

The variant question, asked as capability rather than topology:

> **Can the internet reach this machine?**
> If this stack runs on a server with its own address, or your router can
> forward web traffic to it, Pangolin can run entirely inside your stack —
> nothing leaves your hardware. If not (most home networks), connect to a
> Pangolin server elsewhere instead.

And the enable-time confirmation for server variants, in the
`OP_REMOTE_PUBLIC` register — shown once, not reused for anything milder:

> **This opens your assistant's front door to the internet.**
> Anyone can reach the sign-in pages at the addresses you create. Pangolin
> asks visitors to sign in before anything of yours loads, and your
> assistant still requires its own password behind that.

### 8.6 What the drawer needs that it lacks

The credentials drawer renders text, checkbox, and secret fields from the
schema DSL, and descriptions are plain text — no links, no enums, no
actions. The variant selector reuses the existing profile-selector block
(`AddonsTab.svelte` already special-cases voice with one). The provision
panel (steps 2–5 of §8.1, the API-key paste, the DNS-record display) is a
bespoke drawer section like voice's, plus one new route. Guide links render
as plain-text URLs in descriptions, as Discord's schema does today —
link-capable descriptions are their own small improvement, not assumed
here.

## 9. Security posture, stated honestly

**In-stack hosting shrinks the trust story; the connector keeps the wide
one.** The earlier draft's headline risk was Pangolin's remote-controlled
target list: whoever administers the control plane can point the data path
at anything reachable on its networks. With the server in-stack, that
administrator *is the operator* — the dashboard admin account and the
`pangolin_api_key` join the stack's own security boundary, protected like
the UI login password. The connector variant pointed at Pangolin Cloud (or
any server the operator does not control) retains the original caveat, and
its one sentence of documentation: *the Pangolin server you connect to can
steer this sidecar at anything on its networks — treat that server as part
of your stack's security boundary.* Network design bounds the blast radius
in every variant: the data path reaches `assistant_net`/`portal_net`; the
control plane reaches neither (§6.1); `DISABLE_CLIENTS` stays on for newt.

**The ingress path runs third-party code, twice.** Traefik and badger sit
in front of the stack's front door. The same blast-radius reasoning the
`services.compose.yml` header applies to `tunnel` applies here — digest
pins, no unnecessary capabilities, minimal network membership — plus the
badger plugin-download problem (§6.1, §10 risk 4).

**Docker-socket discovery stays off.** Newt and Pangolin both offer
container discovery via a mounted Docker socket. The assistant itself is
denied a socket by design; no addon gets one either. Resource definitions
come from the rendered blueprint, never from socket scanning — the
convenience is not worth handing an ingress container the host.

**Pangolin's gate is defense in depth, not a replacement.** Guardian
remains the authorization layer for portal/API traffic, and the UI login
password remains the door on the assistant target. The hard-password gate
the companion document specifies for Funnel's public mode is specified, not
yet implemented; building it once — shared by `OP_REMOTE_PUBLIC` and by any
Pangolin resource created without SSO (the PIN-only option) — is part of
this work, not machinery that exists to reuse.

**Never proxy 3831.** Guardian's principal-admin listener stays
loopback-only and must never appear as a target; the blueprint generator
and the setup guide both refuse it.

**Forwarded headers already work; the throttle gap carries over.** Traefik
sets `X-Forwarded-*`, the containerized UI already launches with
`PROTOCOL_HEADER`/`HOST_HEADER` and accepts proxied Host headers when
served in-container. The known `ADDRESS_HEADER` login-throttle issue (all
requests arriving from one proxy IP make five failed logins a global
lockout) is still open from the companion document and serves both addons
with one fix.

**CORS for the guardian target.** A Guardian reached at a real domain needs
that exact origin in `GUARDIAN_CORS_ALLOWED_ORIGINS` (Guardian rejects
`*`). Unlike the Tailscale path, this flow *knows* its hostnames — they are
derived from `stack.env` — so `applyPangolinConfig` writes the origin
automatically instead of documenting a manual step.

## 10. Open risks and what stays manual

Ranked:

1. **Young, fast-moving upstream.** Fourteen minor releases in a year;
   the API surface moves — this document's own first draft specced routes
   (`PUT /org/{orgId}/resource`, `http: true`) that the current source
   marks as deprecated legacy aliases. Mitigations: digest pins on all
   four images, contract tests, the blueprint format (declarative, more
   stable than route shapes) as the primary automation surface, and API
   fallbacks specced against the current routes with the aliases noted.
2. **The stack becomes internet-facing.** Server variants put Traefik +
   badger + Pangolin on reachable 80/443 — a materially larger attack
   surface than anything the stack has exposed before, in exchange for the
   auth gate. Mitigations: profile-gated (zero default footprint), the §8.5
   confirmation ceremony, `disable_signup_without_invite` in the generated
   config, and Pangolin's own MFA/passkey support for the dashboard
   account.
3. **Rootless verification.** Upstream runs all server containers as root;
   whether `fosrl/pangolin`, `traefik`, `fosrl/gerbil`, and `fosrl/newt`
   tolerate the stack's `user:` convention (including Traefik's in-container
   :80/:443 binds and Newt's `HEALTH_FILE` write) is unverified. Day one,
   before any UI work.
4. **Badger arrives by runtime download.** Traefik's plugin mechanism
   fetches it at container start — against the no-runtime-downloads
   principle and unpinnable by digest. Evaluate Traefik's local-plugins
   mode with vendored source at implementation; if unworkable, the version
   pin in the generated config plus the risk being named here is the
   fallback, stated in `core-principles.md` as a carve-out.
5. **DNS and ACME failure modes are now ours to narrate.** Wrong records,
   propagation delay, rate-limited issuance, port 80 blocked by an ISP —
   each needs a named state and remediation copy (§8.4), or the addon
   reads as broken when the network is. This is the cost of owning the
   front door.
6. **`db.sqlite` is real state.** Accounts, API keys, and any
   dashboard-made config live in `data/pangolin/db/`, excluded from
   lifecycle backups by the Paperclip precedent. The generated blueprint
   makes resources re-appliable; accounts and keys are not, and the
   backup-restore guide must say so.
7. **Local-site creation via API is undocumented** (walkthrough docs cover
   `type: "newt"` only); the §8.1 flow degrades to one guided dashboard
   step if Swagger's surface doesn't cover it. Verify at implementation,
   alongside whether API-key creation can be automated (step 3).
8. **CONFIG_FILE is read-write to Newt** and the design mounts it
   read-only; Newt logs and continues on failed writes per its source, but
   "logs and continues" is an observation to confirm, not a guarantee.
9. **Token streaming through Traefik.** The shipped entrypoint config sets
   a 30-minute read timeout and proxies WebSockets, so SSE should pass —
   but "should" earned a verification step in the companion document and
   earns one here: run the real stack behind a real resource and watch
   tokens stream before building anything else.
10. **EE gating and terms.** Site-credential rotation, org-level IdPs, and
    clustering are Enterprise; CE credential leak response is
    delete-and-recreate (automatable via the API). Cloud free-tier terms
    are observed, not contractual, and provide no domain (§2) — UI copy
    must not promise "free" on the connector-to-Cloud path.
11. **Host port conflicts.** 80/443 may be taken by another reverse proxy
    on the host. The port/bind variables exist for exactly that operator;
    the failure needs a friendly pre-flight check, not a Compose error.

**Irreducibly manual:** buying a domain and creating one DNS record (server
variants — the UI displays the exact record with a copy button); router
port-forwarding where applicable; the API-key paste (three guided clicks,
until upstream offers a headless path); the remote dashboard's site/resource
steps on the connector paste path; choosing a strong UI login password.

**One decision to make before implementation:** v1 scope. Recommendation:
**the proxy variant plus the connector paste path first.** The proxy
variant is the intent-defining shape (the server in the stack, per-file
config generation, `pangctl` bootstrap, blueprint apply) and the connector
paste path is a strict subset of machinery the provisioning route builds
on. The tunnel variant (gerbil) and the one-click connector provisioning
follow in the next release — they are additive service blocks and one
route, not new invariants. Second decision, smaller: whether the addon
appears in the setup wizard at all in v1. Recommendation: no — post-install
only, from the Addons tab, where the §8.5 capability question has room to
breathe.

## 11. Sources

Primary sources. Pangolin documentation was read from the docs site's
source repository (`fosrl/docs-v2` at its 2026-08-04 head) because the
rendered site is unreachable from this environment; paths below name the
MDX files, which map one-to-one onto docs.pangolin.net URLs.

**Pangolin docs (fosrl/docs-v2)**
- `self-host/manual/docker-compose.mdx` — the manual install this design's
  generated files mirror, incl. "Verify the Setup" and "Without Tunneling"
- `self-host/advanced/without-tunneling.mdx` — local reverse-proxy mode
- `manage/sites/understanding-sites.mdx` — Newt / Local / Basic WireGuard
  site types and their limits
- `manage/sites/install-site.mdx`, `manage/sites/configure-site.mdx` —
  Newt env vars, CONFIG_FILE read/write behavior, HEALTH_FILE
- `manage/common-api-routes.mdx` — site/resource/target flows
- `manage/blueprints.mdx` — the declarative YAML format and apply paths
- `manage/integration-api/using-the-integration-api.mdx`,
  `self-host/advanced/integration-api.mdx` — key types, enable flag, port
- `self-host/advanced/container-cli-tool.mdx` — `pangctl`
  set-admin-credentials / rotate-server-secret
- `self-host/advanced/config-file.mdx` — flags, ports, SERVER_SECRET
- `self-host/dns-and-networking.mdx` — records, ports, wildcard guidance
- `self-host/choosing-a-vps.mdx` — sizing, DigitalOcean image
- `self-host/enterprise-edition.mdx` — CE/EE licensing and thresholds
- `manage/domains.mdx` — provided domains are paid-plan; Cloud custom
  domains need NS/CNAME records

**Pangolin source**
- https://github.com/fosrl/pangolin — release tags (1.21.x);
  `server/routers/resource/createResource.ts` and
  `server/routers/target/createTarget.ts` (legacy `http`/`method` fields,
  current `mode` enum, `public-resource` route aliases); LICENSE (AGPL-3.0
  + per-file Fossorial Commercial License)
- https://github.com/fosrl/newt — `websocket/config.go` (CONFIG_FILE
  read-modify-write), userspace netstack design
- https://github.com/fosrl/gerbil, https://github.com/fosrl/badger

**Rendered-site entry points**
- https://docs.pangolin.net/self-host/manual/docker-compose
- https://api.pangolin.net/v1/docs (Swagger reference)
- https://app.pangolin.net (Pangolin Cloud)

**OpenPalm (working tree, this revision)**
- `.github/roadmap/0.14.0/remote-access-from-anywhere.md` — the deferral,
  candidate criteria, Funnel auth findings, the CGNAT constraint
- `.github/roadmap/0.14.0/tls-on-the-home-network.md` — the LAN TLS tiers
  the proxy variant's LAN-only mode answers
- `packages/skeleton/system/stack/services.compose.yml` — the `tunnel`
  block, the addon trust-boundary header, the voice/ollama variant labels
- `packages/lib/src/control-plane/remote-access.ts`, `remote-apply.ts`,
  `remote-compose.test.ts`, `remote-addon-registry.test.ts`
- `packages/lib/src/control-plane/addon-ids.ts`, `addon-env-schemas.ts`,
  `addons.ts` (apply hook, profile machinery), `secrets.ts`,
  `secrets-files.ts`, `access-toggles.ts`,
  `addon-network-boundary.test.ts` (the sweep `tunnel` is deliberately
  not in)
- `packages/ui/src/lib/components/addons/AddonsTab.svelte`,
  `packages/ui/src/routes/api/host/addons/[name]/credentials/+server.ts`,
  `packages/ui/src/routes/api/host/access-status/+server.ts`
- `docs/technical/adding-an-addon.md`, `docs/technical/core-principles.md`,
  `docs/technical/network-partitioning-d5a.md`, `docs/remote-access-tls.md`,
  `docs/operations/manual-headless-install.md`,
  `docs/reviews/onboarding-setup-review.md`
