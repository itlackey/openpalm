# Pangolin — a public front door you own

Status: research + proposal
Companion to `remote-access-from-anywhere.md`, whose recommendation shipped as
the `remote` addon (a `tailscale/tailscale` sidecar named `tunnel`). That
document evaluated Pangolin and deferred it in one paragraph: *"Pangolin Cloud
+ Newt is the cleanest sidecar in the whole field (`fosrl/newt:latest`, three
env vars, no capabilities, no volumes, no host networking) with an
identity-aware proxy offering PIN/OTP/SSO — better auth than Funnel. It loses
on maturity and verifiability: free-tier terms could not be confirmed from a
primary source, and it is a young single-vendor dependency. Most likely future
addition; not v1."* This document is that revisit. It re-verifies the two
named blockers against primary sources, answers whether Pangolin should
**replace** Tailscale or ship **alongside** it, and designs the integration —
including the non-technical setup path — against the conventions the `remote`
addon established.

Sourcing note: `docs.pangolin.net` blocks this environment's egress proxy, so
Pangolin claims below were verified against the documentation site's source
repository (`fosrl/docs-v2`, the MDX behind docs.pangolin.net) and the
`fosrl/*` source repositories, current as of 2026-08-06. URLs in §11 name the
rendered pages where they are known to exist.

## 1. What the shipped `remote` addon cannot do

Four limits of the Tailscale design, all disclosed as costs in
`remote-access-from-anywhere.md` §2 and §10, none fixable from our side:

1. **Public mode has no auth gate.** Funnel strips tailnet identity and sets
   `Tailscale-Funnel-Request: ?1`; anyone with the URL reaches the sign-in
   page, and the UI login password is the only door. The roadmap doc's answer
   was a hard password gate plus warning copy — a mitigation, not a feature.
2. **The hostname is not yours.** `https://<node>.<tailnet>.ts.net`, on
   Funnel-legal ports only. No custom domain, ever.
3. **The coordination plane is proprietary SaaS.** Traffic stays end-to-end
   encrypted, but registration, `*.ts.net` DNS, cert issuance, and the Funnel
   relay are all Tailscale-operated — already listed as risk 5 ("it sits
   awkwardly with the self-hosted premise").
4. **The free Personal plan is non-commercial only** (6 users).

Pangolin answers all four: an identity-aware proxy (SSO, OIDC, email OTP,
PIN, header auth, path/IP/geo rules) in front of every public HTTP resource;
any subdomain of a domain you own, with Let's Encrypt certs; an AGPL-3.0
control plane you can run yourself; and no per-user pricing on the
self-hosted Community Edition. The price is the shape of the product: a
Pangolin **server** must exist somewhere with a public IP — either Pangolin
Cloud (managed, free tier) or a small VPS you operate.

## 2. The deferral, re-verified

The two blockers named in the deferral, checked again:

**Maturity.** `fosrl/pangolin` was created September 2024. It is now at
release 1.21.x with roughly 22k GitHub stars, 700+ forks, a DigitalOcean
Marketplace image, Helm charts, a Kubernetes controller, and active companion
repositories for every component (`newt`, `gerbil`, `badger`, `olm`, desktop
and mobile clients). The cadence is fast — 1.7 to 1.21 inside a year — which
cuts both ways: alive and improving, but interfaces move. "Young" is now a
risk to manage (§10), not a disqualifier.

**Free-tier verifiability.** Now confirmable from primary sources. The
Community Edition is free and AGPL-3.0 (per-file licensing; files headed
"Fossorial Commercial License" are the Enterprise Edition, a separate
`fosrl/pangolin:ee-*` image gated on a license key, free for personal use and
organizations under $100k gross annual revenue). Pangolin Cloud has a
documented free tier with no card required. What remains unverifiable is
whether Cloud's free-tier *terms* hold over time — a risk shared with every
vendor tier in the field, ranked in §10.

Both blockers are cleared enough to design against. Not cleared enough to
make Pangolin the default — see §3.

## 3. Replace Tailscale, or offer Pangolin alongside it?

**Alongside. Pangolin is a second remote-access addon, not a successor.**
Three reasons, in decreasing order of weight:

1. **Pangolin requires infrastructure Tailscale does not.** Every Pangolin
   shape needs a control plane with a public IP: Pangolin Cloud (a vendor
   dependency with plaintext visibility — see the table) or a VPS the user
   operates (cost, updates, backups, and a public attack surface). Tailscale
   Serve needs an SSO sign-in and nothing else. For "use it from my phone" —
   the majority case — Serve remains the right default, and replacing it
   would trade the majority's zero-infrastructure path for the minority's
   public-domain path.
2. **Private access is not Pangolin's strong suit yet.** Serve covers
   only-my-devices access with GA tooling on every platform. Pangolin's
   equivalent (private resources reached through Olm-based clients) shipped
   in late 2025 and is the youngest part of the product. Pangolin's strength
   is precisely the mode Tailscale is weakest in: *public* exposure with
   real auth in front.
3. **The two compose.** Neither sidecar publishes a host port; both dial out
   and reach `assistant:3000` / `guardian:3830` as network clients. Running
   `remote` (private tailnet access) and `pangolin` (public domain with SSO)
   simultaneously is a legitimate, useful topology, not a conflict. A
   replace-or-choose model would forbid it for no reason.

The honest comparison, on the criteria `remote-access-from-anywhere.md`
used:

| | Tailscale Serve/Funnel (shipped) | Pangolin + Newt (proposed) |
|---|---|---|
| Works behind CGNAT | yes (outbound sidecar) | yes (outbound sidecar) |
| Infrastructure required | none | Pangolin Cloud account, or a VPS + domain + DNS |
| Custom domain | no (`*.ts.net`) | yes, any subdomain, LE certs |
| Auth in front of public mode | **none** (password is the only door) | SSO / OIDC / email OTP / PIN / header auth / access tokens / path+IP+geo rules |
| Vendor can read traffic | no — relays proxy still-encrypted TCP by SNI; TLS terminates in the sidecar | Cloud: **yes** — TLS terminates on Fossorial's node. Self-hosted: n/a (your VPS terminates) |
| Self-hostable control plane | no (Headscale is third-party, no Funnel) | yes — AGPL-3.0 Community Edition |
| Free-plan terms | non-commercial, 6 users | CE: free, AGPL. Cloud: free tier. EE: free under $100k revenue |
| Bot/API exposure | Funnel only, unauthenticated | per-resource access tokens, Basic header auth, per-path auth-bypass rules |
| Maturity | Funnel beta ~4 years, company ~5 years older | project born Sep 2024, moving fast |
| Moving parts on our side | 1 sidecar | 1 sidecar (Newt) |
| Moving parts on the user's side | 0 | 0 (Cloud) or 4 server containers (self-hosted VPS) |

The "vendor can read traffic" row deserves emphasis because the original
document weighted it heavily against Cloudflare and ngrok: with Pangolin
Cloud and no self-hosted node, TLS for public resources terminates on
Fossorial's Traefik, so the vendor is *in* the plaintext path — the same
class as Cloudflare, and unlike Funnel. Self-hosting the Pangolin server (or
attaching a self-hosted node to Cloud) keeps termination inside the user's
boundary. The UI copy in §8 must not blur this.

## 4. The deployment shapes — and the one not to ship

Pangolin's server side is four containers: `pangolin` (control plane +
dashboard), `gerbil` (WireGuard tunnel manager, `NET_ADMIN` + `SYS_MODULE`,
owns host ports 80, 443, 51820/udp, 21820/udp), `traefik` (ingress, runs in
Gerbil's network namespace), and the `badger` forward-auth plugin. The site
side is one container: `newt`, userspace WireGuard, outbound-only, three
configuration values.

**OpenPalm ships only the site side.** The `pangolin` addon is a Newt sidecar
pointed at whichever control plane the operator chooses:

### 4.1 Pangolin Cloud

The non-technical path. Create a free account at `app.pangolin.net`, add a
site, get three values (endpoint, Newt ID, Newt secret). No VPS, no domain
purchase (Cloud provides a subdomain; custom domains attachable), no DNS.
Cost: the vendor dependency and the plaintext-visibility row above, disclosed
in the UI copy.

### 4.2 Self-hosted Pangolin on a VPS

The self-hosted-premise-complete path. A ~$5/mo VPS (1 vCPU / 2 GB is the
documented floor), a domain with a wildcard A record, ports 80/443/51820/
21820 open, and Pangolin's own installer
(`curl -fsSL https://static.pangolin.net/get-installer.sh | bash`) or manual
compose install. The addon consumes it identically — only the endpoint value
differs. OpenPalm documents this path (a setup guide, §5's files-touched
list) but does not automate VPS provisioning; the installer is interactive
and documents no unattended flags, and operating rented infrastructure is
outside the harness's job description.

### 4.3 Not shipped: the Pangolin server inside the OpenPalm stack

Rejected outright. It would add four always-on containers, two added
capabilities (`NET_ADMIN`, `SYS_MODULE` on gerbil), and host ports 80 and 443
— violating the loopback-first convention, the rootless convention, and the
one-always-on-container principle in a single service block. And it would be
pointless: a Pangolin server is only useful *with a public IP*, which a home
install behind CGNAT does not have — the constraint that opened
`remote-access-from-anywhere.md` §1. (Pangolin does run VPS-less as a plain
LAN reverse proxy with "local" sites, but that solves none of the problems
this addon exists for.)

## 5. How it maps onto the shipped model

**A sibling builtin addon `pangolin` with one compose service `newt`,
mirroring `remote` / `tunnel` symbol for symbol.**

One alternative was considered and rejected: folding Pangolin into the
`remote` addon behind a provider field. The original roadmap document
sketched `provider: "tailscale"` in a `remote-access.json`, but the shipped
implementation dropped both the JSON file and the provider field — config
lives in `state/stack.env` as `OP_REMOTE_*` keys, and the addon machinery is
per-id: one id, one compose profile, one env schema, one credentials drawer.
A provider enum inside `remote` would need conditional service selection
within a single profile (which Compose cannot express), would interleave two
disjoint config sets in one drawer, and would forbid the both-at-once
topology §3 calls legitimate. Sibling ids cost nothing: `discord`, `slack`,
`ollama`, and `paperclip` establish that addons are named for the product
they wrap, and every piece of plumbing below already iterates tables rather
than special-casing names.

The mapping, following `docs/technical/adding-an-addon.md`'s checklist:

| Convention | `remote` (shipped) | `pangolin` (proposed) |
|---|---|---|
| Addon id in `BUILTIN_ADDON_IDS` (`addon-ids.ts`) | `remote` | `pangolin` |
| Compose service, profile-gated | `tunnel`, `profiles: ["addon.remote"]` | `newt`, `profiles: ["addon.pangolin"]` |
| Image | `tailscale/tailscale:v1.98.10@sha256:…` | `fosrl/newt:<release>@sha256:…` — digest resolved from the registry at implementation time, never `:latest` (upstream's own compose example floats; ours must not) |
| Config keys in `state/stack.env` | `OP_REMOTE_TARGET/PUBLIC/HOSTNAME` | `OP_PANGOLIN_ENDPOINT/NEWT_ID/TARGET` |
| Delegated secret(s) (`DELEGATED_SECRET_NAMES`) | `ts_authkey` | `newt_secret` (pasted or API-minted), `newt_config` (generated, §7), `pangolin_api_key` (optional, §8.2) |
| Generated artifact | `state/remote/serve.json` (ipn.ServeConfig) | `private/secrets/newt_config` (Newt JSON config) |
| Apply hook | `if (name === 'remote') applyRemoteAccess(...)` in `addons.ts` + the credentials route | `applyPangolinConfig(...)` — and this being the **second** special case, both migrate to the declaration table the addon guide already prescribes ("two is a signal to generalize"): `ADDON_APPLY_HOOKS: Record<string, (homeDir: string) => AddonApplyResult>` |
| Recreate scope (`ADDON_ENV_RECREATE_SCOPE`) | `OP_REMOTE_*` → `["tunnel"]` | `OP_PANGOLIN_*` → `["newt"]` |
| Guardian ingress | `remoteRequiresGuardianIngress(enabled, target)` through `resolveAccessEnv(toggles, { guardianIngressRequired })` | the same hook — see below |
| Network membership | `assistant_net` + `portal_net`, stated exception | same, same stated reason |
| Host port | none, deliberately | none, deliberately — no row in the `core-principles.md` port table, matching `tunnel` |
| Network-boundary sweep | listed in `ADDON_SERVICES` (`addon-network-boundary.test.ts`) | `newt` added to the same sweep |
| Compose contract test | `remote-compose.test.ts` | `pangolin-compose.test.ts`: digest-pinned image, no `ports:`, no `depends_on:`, rootless `user:`, no literal secret value in `environment:` |

**Guardian ingress has one writer, and it must stay that way.**
`resolveAccessEnv`'s `guardianIngressRequired` option is documented as "the
ONE place another feature may add a reason for `GUARDIAN_DIRECT_INGRESS` to
be `true` without also opening the LAN bind." With two tunnel addons, two
apply hooks would each recompute that flag — and two writers computing from
different inputs will drift. The predicate therefore generalizes to a single
shared function reading *both* addons' state:

```ts
/** True when ANY enabled tunnel addon targets the guardian. The only
 *  input resolveAccessEnv's guardianIngressRequired option may be fed. */
export function computeGuardianIngressRequired(env: Record<string, string>): boolean;
```

Both `applyRemoteAccess` and `applyPangolinConfig` call it; neither owns it.
The existing warning behavior carries over verbatim: when the target includes
guardian but no `GUARDIAN_INGRESS_ADDON_IDS` addon is enabled, warn and do
not auto-fix.

**What Pangolin does *not* need that Tailscale did.** There is no serve.json
analog. The resource → target routing table lives on the Pangolin server, not
in a locally generated file — Newt receives it over its control channel. That
deletes the hardest parts of the `remote` implementation (the fsnotify
directory-mount rules, the never-delete-the-file invariant, the
`${TS_CERT_DOMAIN}` substitution dance) and replaces them with one small
generated secret file (§7). It also *narrows* one guarantee, stated honestly:
`remote`'s disable path is fail-closed even when `compose stop` fails,
because the empty serve document is already on disk and a running tunnel
re-reads it within seconds. `pangolin`'s disable is the container stop
itself — if the stop fails, the tunnel stays up until it succeeds. When an
API key is on file (§8.2), the disable path should also disable the resource
server-side, restoring belt-and-braces. Without a key, disable is
stop-the-container, and the gap is a documented cost.

## 6. The compose wiring

New service in `packages/skeleton/system/stack/services.compose.yml`, beside
`tunnel`, written in the same voice and to the same contract:

```yaml
  newt:
    profiles: ["addon.pangolin"]
    # Pinned to a specific release PLUS its multi-arch manifest-list digest,
    # same convention as tunnel above. Upstream's own compose example uses
    # the floating `fosrl/newt` tag; a floating tag on an INGRESS path means
    # a plain `docker compose pull` silently re-points it at whatever
    # Fossorial shipped that week. Resolve the digest from Docker Hub's
    # registry API at implementation time.
    image: fosrl/newt:REPLACE_VERSION@sha256:REPLACE_DIGEST
    restart: unless-stopped
    # IMG-7: cap json-file logs (30 MB/service ceiling).
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    # Rootless, like every other service. Newt is userspace WireGuard
    # (netstack): no NET_ADMIN, no /dev/net/tun, no host networking, no
    # volumes. Whether the upstream image tolerates an arbitrary uid:gid is
    # a day-one verification item (§10 risk 7).
    user: "${OP_UID:-1000}:${OP_GID:-1000}"
    environment:
      # ALL THREE connection values (endpoint, Newt ID, Newt secret) arrive
      # through this one mounted JSON secret, generated by
      # applyPangolinConfig (pangolin-apply.ts). Newt has no *_FILE variants
      # of NEWT_SECRET, so a literal `environment:` value would land in
      # `docker inspect`'s environment dump — the exact leak the tunnel's
      # `file:` indirection exists to prevent. CONFIG_FILE is Newt's
      # supported secrets mechanism and covers all three values at once.
      CONFIG_FILE: /run/secrets/newt_config
      # Newt touches this file once its control channel and tunnel are up;
      # the healthcheck below tests for it. Container-up is NOT tunnel-up.
      HEALTH_FILE: /tmp/healthy
      # This sidecar exists to publish resources OUT of these networks,
      # never to admit Pangolin clients INTO them. Site-to-client
      # connectivity stays off.
      DISABLE_CLIENTS: "true"
    secrets: [newt_config]
    # Reaches BOTH possible targets — the same per-service trust-boundary
    # exception tunnel states above: assistant_net to dial
    # http://assistant:3000, portal_net because guardian (the OTHER possible
    # target, http://guardian:3830) lives on portal_net. Which targets are
    # actually proxied is decided by the resource list on the Pangolin
    # server; this line only grants the reachability either choice needs.
    # That remote-controlled target list is the addon's widest trust grant —
    # see the proposal's §9.
    networks: [assistant_net, portal_net]
    # NO ports: block, deliberately — this sidecar publishes NOTHING on the
    # host; LAN exposure and internet exposure stay orthogonal, exactly as
    # tunnel's comment explains.
    # NO depends_on: — guardian is profile-gated and routinely excluded; a
    # depends_on naming an excluded service is a project-level Compose PARSE
    # error. Newt retries its targets on its own.
    healthcheck:
      test: ["CMD", "test", "-f", "/tmp/healthy"]
      interval: 10s
      timeout: 5s
      retries: 3
      # Cover credential exchange + WG handshake on slow links before
      # counting failures.
      start_period: 60s
```

And beside `ts_authkey` in the top-level `secrets:` block:

```yaml
  # Generated by applyPangolinConfig from OP_PANGOLIN_ENDPOINT,
  # OP_PANGOLIN_NEWT_ID, and the newt_secret delegated secret. DELEGATED,
  # like ts_authkey, and for the same class of reason: the Newt secret is a
  # site JOIN credential — anything that can read it can impersonate this
  # site to the Pangolin control plane and receive its tunnel traffic. It
  # must stay out of the assistant-visible knowledge/secrets/ stash.
  newt_config:
    file: ${OP_HOME}/private/secrets/newt_config
```

Like `ts_authkey`, both `newt_secret` and `newt_config` are seeded as empty
files by `ensureSecrets` at install time regardless of addon state, because
Compose fails container creation outright when a declared secret's source
file is missing — the manual `OP_ENABLED_ADDONS` hand-edit path must not
brick the stack. Unlike a blank `TS_AUTHKEY` (which meaningfully selects
interactive login), a blank `newt_config` just means "not configured yet":
Newt exits, the container restarts, and the UI shows the unhealthy state
until credentials arrive. That is acceptable — the addon is enabled either
by the drawer (which collects credentials first) or by an operator who
hand-edits files and can read a health status.

## 7. What the control plane writes

Following the intent-in-`stack.env` / secrets-in-`private/` split exactly:

```
~/.openpalm/
├─ state/stack.env                      # INTENT (existing file, new keys)
│    OP_ENABLED_ADDONS=...,pangolin
│    OP_PANGOLIN_ENDPOINT=https://app.pangolin.net
│    OP_PANGOLIN_NEWT_ID=2ix2t8xk22ubpfy      # public-safe site identifier
│    OP_PANGOLIN_TARGET=assistant             # assistant | guardian | both
│
└─ private/secrets/
   ├─ newt_secret                       # 0600, pasted or API-minted
   ├─ newt_config                       # 0600, GENERATED — see below
   └─ pangolin_api_key                  # 0600, optional (§8.2), org-scoped
```

`applyPangolinConfig(homeDir)` (new module `pangolin-apply.ts`, beside a
browser-safe `pangolin-access.ts` holding the config model, labels, and
`describePangolinExposure` — the same pure-model / node-apply split as
`remote-access.ts` / `remote-apply.ts`) regenerates `newt_config` whenever
the endpoint, Newt ID, or secret changes:

```json
{
  "id": "<OP_PANGOLIN_NEWT_ID>",
  "secret": "<contents of private/secrets/newt_secret>",
  "endpoint": "<OP_PANGOLIN_ENDPOINT>"
}
```

Written with `writeFileAtomic`, mode 0600. Newt's config precedence is CLI
flag > env var > config file; the compose service sets only `CONFIG_FILE`,
so the generated file is authoritative and cannot fight a stray env var.

The env schema, in the established annotation DSL
(`BUILTIN_ADDON_ENV_SCHEMAS.pangolin`):

```
# OpenPalm Pangolin (Newt tunnel) configuration
# ---
# Publishes this assistant through a Pangolin server — Pangolin Cloud or one
# you host — on a real domain name, with a sign-in page in front. Create a
# site in your Pangolin dashboard (Sites > Add Site > Newt) and copy the
# three values it shows you into the fields below.

# The Pangolin server this stack connects to: https://app.pangolin.net for
# Pangolin Cloud, or your own server's dashboard address. Note the privacy
# trade: with Pangolin Cloud, the connection from visitors to Pangolin is
# decrypted on Pangolin's servers before it reaches you; with your own
# server, it is decrypted only on hardware you control.
OP_PANGOLIN_ENDPOINT=

# The site ID Pangolin generated for this stack (shown as "Newt ID"). Safe
# to share — it names the site but grants nothing by itself.
OP_PANGOLIN_NEWT_ID=

# What Pangolin's resources may point at: assistant, guardian, or both. Most
# people only ever need "assistant" — the guardian target is for advanced
# setups that also expose bot/API portals remotely.
OP_PANGOLIN_TARGET=assistant

# The site secret Pangolin generated beside the Newt ID. Required — the
# tunnel cannot start without it. Treat it like a password: anything that
# has it can impersonate this site to your Pangolin server.
# @sensitive
NEWT_SECRET=
```

`NEWT_SECRET` routes through the `@sensitive` path to the `newt_secret`
delegated secret file, exactly as `TS_AUTHKEY` routes to `ts_authkey`; the
non-sensitive keys land in `state/stack.env`. The known `@required`-is-
unenforced gap (`onboarding-setup-review.md` W5) applies here as it does to
every portal token; the health state, not validation, is what tells the
operator a blank secret didn't work.

## 8. Making it configurable by a non-technical person

This is the section the Tailscale addon never needed — Tailscale's setup
*is* signing in — and the reason Pangolin was deferred rather than rejected:
its raw setup asks the user to create a site, then create a resource, then
type a target of `assistant` port `3000` into a third-party dashboard. Done
naively that is three chances to mistype. The design below gives that flow a
floor (a paste path with exact values) and a headline (one click, because
Pangolin's integration API can do every step programmatically).

### 8.1 The floor: paste three values

The generic addon drawer already renders the §7 schema: two text fields, a
target field, one secret field. The companion setup guide
(`docs/pangolin-setup.md`, files-touched list below) walks the dashboard
steps with exact values, in the same shape as the Discord/Slack token
guides:

| Pangolin asks | Enter | Why |
|---|---|---|
| Site type | Newt | the only type this addon runs |
| Resource type | HTTP | raw TCP/UDP resources have **no auth layer** — never use them for this stack |
| Target address | `assistant` | Docker service DNS, resolved from inside the newt container |
| Target port | `3000` | the UI's in-container port — not 3800, not 3880 (host publishes are host-facing only) |
| Target method | `http` | TLS terminates at Pangolin's ingress; the Docker network hop is plain HTTP, like every other in-stack hop |
| Guardian target (advanced) | `guardian`, port `3830`, `http` | only with `OP_PANGOLIN_TARGET` including guardian; never port 3831 (§9) |

The drawer's field descriptions carry the deep link to the guide, mirroring
"How to create a Discord bot and get your token →".

### 8.2 The headline: one-click provisioning over the integration API

Pangolin exposes a REST integration API (Bearer-token auth, org-scoped and
root API keys, fine-grained permissions, Swagger reference at
`api.pangolin.net/v1/docs`) that covers every object the paste path creates
by hand. That turns setup into: **paste one API key, pick a name, click
Connect.** A new host route (`POST /api/host/addons/pangolin/provision`,
capability `host:addons`, admin-locked like every addon route) drives:

1. `PUT /org/{orgId}/site` `{name: <project name>, type: "newt"}` — returns
   `siteId`, `newtId`, and the Newt `secret`. Write `OP_PANGOLIN_NEWT_ID`,
   the `newt_secret` file, regenerate `newt_config`, enable the addon. The
   sidecar connects; the site reports Online.
2. `GET /org/{orgId}/domains` — offer the org's domains in a select,
   defaulting to the only entry (Cloud accounts start with one).
3. `PUT /org/{orgId}/resource` `{name, http: true, subdomain, domainId}` —
   subdomain defaults to the project name; returns `resourceId` and
   `fullDomain`.
4. `PUT /resource/{resourceId}/target`
   `{siteId, ip: "assistant", port: 3000, method: "http"}` — the values a
   human would have typed, now impossible to mistype.
5. Leave the resource's default protection (Pangolin platform SSO via the
   badger forward-auth middleware) in place. Offer "require a PIN instead"
   as a one-checkbox alternative for sharing with someone who has no
   Pangolin account. Never offer "no auth" — a user who wants that has
   Funnel, and it at least says so honestly.
6. When `OP_PANGOLIN_TARGET` includes guardian: repeat 3–4 with subdomain
   `<name>-api`, target `guardian:3830`, and access-token or Basic header
   auth (Pangolin passes both; Guardian still authenticates principals
   itself — the token is defense in depth, not a replacement).
7. Read back `fullDomain` and show `https://<fullDomain>` with a copy
   button — only after the site reports Online and the resource exists,
   honoring the "advertise LAST" invariant (`a name is never published
   ahead of a reachable port`).

The API key is pasted once into a `@sensitive` field, stored as the
`pangolin_api_key` delegated secret, and used server-side only (host
process; never the browser). Keeping it enables ongoing status read-back
(site online/offline via the API) and the belt-and-braces disable from §5;
offering "forget the key after setup" is a reasonable privacy option since
everything degrades gracefully to the paste path.

Two honest caveats. On self-hosted Community Edition the integration API is
**off by default** (`flags.enable_integration_api`, served on its own port
behind extra Traefik routers) — the setup guide documents enabling it, and
the drawer falls back to the paste path when the endpoint has no API. And
the drawer today renders only text/checkbox/secret fields, so the
provision-vs-paste choice and the domain select need a bespoke drawer
section — precedent exists: `AddonsTab.svelte` already special-cases
`aid === 'voice'` with a profile selector block above the schema fields.

### 8.3 Setup-spec / headless

`addons: {pangolin: true}` works today through the generic spec path. The
config keys are ordinary `state/stack.env` keys and the secret is an
ordinary delegated secret file, so the headless recipe is documented in
`docs/operations/manual-headless-install.md` alongside the existing
`TS_AUTHKEY` pre-authorization note: write the three keys, write
`newt_secret`, run `openpalm start`. A first-class
`pangolin: {endpoint, newtId, ...}` spec object — and the same for the
`remote` addon — is a fast-follow decision, not v1; the spec has no
addon-config map today and inventing one for one addon would be the kind of
single-purpose special case the codebase keeps declining.

### 8.4 States the UI must show

Intent and observed state stay separate, as `AssistantTab.svelte` renders
them for LAN access. Model the addon's status as a discriminated union:

`off · awaiting-credentials · starting · connecting{endpoint} ·
up{fullDomain?} · degraded{container-up-tunnel-down} ·
error{reason, remediation}`

Sourced from facts with different owners, mirroring `access-status.ts`:
enablement and config from `state/stack.env` (intent), container health from
`compose ps` (the `HEALTH_FILE` check makes "up" mean tunnel-up, not merely
process-up), and — only when an API key is on file — site online status and
resource list from the integration API. `fullDomain` is shown from the
provisioning read-back; without an API key the UI shows the endpoint and a
"check your Pangolin dashboard" link rather than fabricating a URL it cannot
verify — the same discipline as `describeRemoteExposure` reporting a port,
never a URL.

### 8.5 Copy, in the existing voice

Addon list description, deliberately naming neither WireGuard nor tunnels:

```ts
pangolin: "Put your assistant on a web address you own, with a sign-in
page in front",
```

Drawer intro, distinguishing it from `remote` in the operator's terms:

> **Remote** (Tailscale) is for your own devices — nothing to configure,
> nobody else can get in. **Pangolin** is for a real web address you can
> share — it shows a sign-in page to anyone who visits. You can use both at
> once.

And the §3 privacy trade, surfaced at the moment the endpoint is chosen (not
buried in docs): the two-card choice "Pangolin Cloud — easiest, free;
visitor traffic is decrypted on Pangolin's servers before it reaches you" vs
"My own Pangolin server — your hardware end to end; you run a small server
to do it", with no silent default.

## 9. Security posture, stated honestly

**The remote-controlled target list is the widest trust grant in this
design.** The tunnel addon's routing is a locally generated file; a
compromised Tailscale coordination plane can admit hostile *peers*, but they
reach only what `serve.json` exposes. Pangolin inverts that: the resource →
target table lives on the Pangolin server and is pushed to Newt over its
control channel. Whoever administers the Pangolin org — Fossorial's Cloud,
or the operator's VPS admin account — can point the sidecar at *anything
reachable on its networks*, which includes the assistant's OpenCode listener
(`assistant:4096`) and guardian's portal gateway (`guardian:8080`), not just
the two blessed targets. The design accepts this with mitigations rather
than pretending to prevent it: `DISABLE_CLIENTS: "true"` (no
client-to-site raw connectivity), network membership already minimal, and
one sentence of documentation that must exist: *the Pangolin account (or
server) is part of this stack's security boundary — protect it like the
stack itself.* Self-hosting the control plane keeps that boundary in the
operator's hands, which is one more reason §3 refuses to make Cloud a silent
default.

**Pangolin's auth gate is defense in depth, not a replacement.** Guardian
remains the authorization layer for portal/API traffic, and the UI login
password remains the door on the assistant target. The hard-password gate
`remote-access-from-anywhere.md` §9 specifies for Funnel's public mode
applies with equal force the day a Pangolin resource is created without SSO
(the PIN-only option): same gate, same copy, shared implementation.

**Never proxy 3831.** Guardian's principal-admin listener stays
loopback-only on the host and must never appear as a Pangolin target; the
setup guide and the provisioning route both refuse it.

**Forwarded headers already work; the throttle gap carries over.** Traefik
sets `X-Forwarded-Proto`/`-Host`/`-For`, and the containerized UI already
launches with `PROTOCOL_HEADER`/`HOST_HEADER` and short-circuits host-header
checks when `OP_UI_SERVED_IN_CONTAINER=1` — the same wiring the Tailscale
path relies on. The known `ADDRESS_HEADER` login-throttle issue (all
requests arriving from the sidecar's IP make five failed logins a global
lockout) is still open from the original roadmap and serves both addons with
one fix.

**CORS for the guardian target.** A Guardian reached at
`https://<fullDomain>` needs that exact origin in
`GUARDIAN_CORS_ALLOWED_ORIGINS` (Guardian rejects `*`). The provisioning
flow knows `fullDomain` and can write it automatically — the fast-follow the
Tailscale path couldn't have, because it never knows its own URL.

## 10. Open risks and what stays manual

Ranked:

1. **Young, fast-moving upstream.** Born September 2024; 14 minor releases
   in a year; docs and API surface move. Mitigation: digest-pinned Newt
   image, a compose contract test, and the §8.2 route treating API errors
   as "fall back to the paste path," never as setup failure.
2. **The control-plane trust grant** (§9). Accepted and documented, not
   solved. The one design lever — self-hosting — is preserved as a
   first-class, equally supported choice.
3. **Site credential rotation is Enterprise-gated.** On CE, a leaked
   `newt_secret` means delete-and-recreate the site. With an API key on
   file that is one automated round (the same §8.2 calls); without one it
   is a documented manual step in the setup guide.
4. **Integration API off by default on self-hosted CE.** The headline flow
   silently narrows to Cloud users and self-hosters who followed the
   guide's enable-the-API section. The drawer must present the paste path
   as fully supported, not as a degraded mode.
5. **Cloud free-tier terms are observed, not contractual.** The original
   deferral reason, now verifiable but not guaranteed. The addon's design
   survives a pricing change (self-host remains), but UI copy should avoid
   promising "free."
6. **All public traffic hairpins through the Pangolin node.** Latency and
   the node's bandwidth bound the experience; a $5 VPS is the bottleneck
   for heavy use. Tailscale Serve's near-always-P2P private path remains
   the better daily driver, which §3's copy already tells the user.
7. **Rootless verification.** The `user:` downgrade and `HEALTH_FILE`
   writability under an arbitrary uid:gid are asserted from Newt's
   userspace design, not yet from a running container. Verify on day one,
   before any UI work.
8. **Token streaming through Traefik.** Pangolin's shipped Traefik config
   sets a 30-minute read timeout on the TLS entrypoint and proxies
   WebSockets, so SSE should pass — but "should" earned a verification
   step last time (`remote-access-from-anywhere.md` risk 9) and earns one
   here: run the real stack behind a real resource and watch tokens stream
   before building anything else.
9. **VPS operational burden** for the self-hosted shape: updates, backups
   (`config/db/db.sqlite`), monitoring, and a server secret rotatable only
   via `pangctl`. OpenPalm documents; it does not manage.

**Irreducibly manual:** creating the Pangolin account (Cloud) or the VPS +
domain + DNS records (self-hosted); creating the API key for the one-click
path (a few dashboard clicks, with a guide); choosing a strong UI login
password; and, on CE self-host, flipping `flags.enable_integration_api` if
the one-click path is wanted.

**One decision to make before implementation:** whether v1 ships the §8.2
provisioning route, or ships the paste path first and the provisioning
route as the fast-follow. Recommendation: **paste path first** — it is a
strict subset (schema, compose service, apply hook, docs), it exercises
every invariant the provisioning route depends on, and it keeps the first
release reviewable. The provisioning route is where the non-technical
promise is kept, so it follows in the next release, not "eventually."

## 11. Sources

Primary sources. Pangolin documentation was read from the docs site's
source repository (`fosrl/docs-v2`) because the rendered site is
unreachable from this environment; rendered URLs are given where known.

**Pangolin**
- https://docs.pangolin.net/self-host/manual/docker-compose
- https://docs.pangolin.net (source: https://github.com/fosrl/docs-v2)
- https://github.com/fosrl/pangolin (license files: AGPL-3.0 +
  per-file Fossorial Commercial License)
- https://github.com/fosrl/newt (CONFIG_FILE, HEALTH_FILE,
  DISABLE_CLIENTS, userspace netstack)
- https://github.com/fosrl/gerbil
- https://github.com/fosrl/badger
- https://api.pangolin.net/v1/docs (integration API reference)
- https://app.pangolin.net (Pangolin Cloud)
- https://static.pangolin.net/get-installer.sh

**OpenPalm (working tree, this revision)**
- `.github/roadmap/0.14.0/remote-access-from-anywhere.md` — the deferral,
  the candidate criteria, the Funnel auth/identity findings
- `packages/skeleton/system/stack/services.compose.yml` — the `tunnel`
  service block and `ts_authkey` secret this design mirrors
- `packages/lib/src/control-plane/remote-access.ts`, `remote-apply.ts`,
  `remote-compose.test.ts`, `remote-addon-registry.test.ts`
- `packages/lib/src/control-plane/addon-ids.ts`, `addon-env-schemas.ts`,
  `addons.ts`, `secrets.ts`, `secrets-files.ts`, `access-toggles.ts`,
  `addon-network-boundary.test.ts`
- `packages/ui/src/lib/components/addons/AddonsTab.svelte`,
  `packages/ui/src/routes/api/host/addons/[name]/credentials/+server.ts`,
  `packages/ui/src/routes/api/host/access-status/+server.ts`
- `docs/technical/adding-an-addon.md`, `docs/technical/core-principles.md`,
  `docs/technical/network-partitioning-d5a.md`, `docs/remote-access-tls.md`,
  `docs/reviews/onboarding-setup-review.md`
