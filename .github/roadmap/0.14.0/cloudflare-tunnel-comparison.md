# Cloudflare Tunnel — the third front door, compared

Status: research + comparison
Companion to `remote-access-from-anywhere.md` — whose recommendation shipped
as the `remote` addon and named "a `cloudflare/cloudflared` named-tunnel
sidecar" as its never-built secondary — and to `pangolin-remote-access.md`,
the flagship proposal. This document finishes the field: it re-verifies
Cloudflare named tunnels against current primary sources, sketches the
addon they would be, and renders the three-way comparison the earlier
documents each made only pairwise, to answer one question: **is there a
clear advantage to any of the three for OpenPalm integration?**

Sourcing note: `developers.cloudflare.com` and `cloudflare.com` block this
environment's egress proxy, so Cloudflare claims were verified against the
documentation's source repository (`cloudflare/cloudflare-docs`, sparse
clone at its 2026-08-06 head) and the `cloudflare/cloudflared` source tree,
with Docker Hub's registry API queried live for image facts. The one
load-bearing figure that could not be verified first-party — the Zero
Trust free plan's 50-user seat count — is flagged where used.

## 1. What the companion documents already settled

Three verdicts carry over unweakened:

1. **Quick tunnels stay dead.** Re-verified: the docs still say "Quick
   Tunnels do not support Server-Sent Events," `cloudflared#1449` (SSE
   buffered until connection close — fatal for token streaming) is still
   open, the 200 in-flight request cap still returns 429, the hostname is
   still regenerated per process start, and the page still says testing
   and development only. Nothing offerable there.
2. **Named tunnels are genuinely excellent.** The original assessment
   holds and has improved since (§2).
3. **The blocker has not moved.** A named tunnel's public hostname
   requires a zone in the user's Cloudflare account, and on the free plan
   that means **full nameserver delegation** — the docs confirm partial
   (CNAME) setup remains Business-plan-only, and the quick-tunnels page
   itself concedes the product family "historically require[s] you to own
   a domain, set that domain's DNS to Cloudflare's nameservers." There is
   no DuckDNS-style free-name path into Cloudflare (§2.2).

What changed is the frame around them, set by `pangolin-remote-access.md`:
OpenPalm installs are not only CGNAT homes, the `remote` addon has no
install base, and the flagship front door is now proposed to be a server
the stack itself runs. Cloudflare must be judged against that field, not
against the original CGNAT-only cut.

## 2. Cloudflare named tunnels, re-verified

### 2.1 The automation surface is the best in the field

Everything the §3 comparison calls "setup" is drivable by **one API token**
(scopes: Account → Cloudflare Tunnel Edit; Access: Apps and Policies Edit;
Access: Organizations, Identity Providers, and Groups Write; Access:
Service Tokens Write; Zone → DNS Edit):

1. `POST /accounts/{account_id}/cfd_tunnel` with
   `{"name": "...", "config_src": "cloudflare"}` — creates a
   remotely-managed tunnel; the response already carries the connector
   token.
2. `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` —
   ingress rules (`hostname` → `http://assistant:3000`, catch-all 404
   rule last), stored in Cloudflare and **hot-reloaded into a running
   connector with no restart** (the orchestrator swaps the in-process
   proxy atomically).
3. `POST /zones/{zone_id}/dns_records` — the proxied CNAME to
   `<tunnel-id>.cfargotunnel.com`.
4. `POST /accounts/{account_id}/access/identity_providers`
   `{"name": "...", "type": "onetimepin", "config": {}}` — the email-code
   login gate, no external IdP.
5. `POST /accounts/{account_id}/access/apps` — the Access application with
   inline policies; per-path apps allow an SSO-gated UI and a
   differently-gated API path on one hostname.
6. `POST /accounts/{account_id}/access/service_tokens` — machine
   credentials for bots (§2.3).

That is a strictly stronger automation story than Pangolin's — in-stack,
OpenPalm generates the config with the integration API enabled, but the
API *key* is still minted through a dashboard step and local-site creation
is undocumented in the walkthroughs; against an external CE server the
API is off by default besides — and than Tailscale's (whose serve config
is a local file but whose Funnel approval is a browser ceremony). Setup
friction, however, is not automation friction — §2.2.

### 2.2 The setup friction is front-loaded and cannot be automated

The user must: own a domain (bought with money, at a registrar), add it to
a Cloudflare account, and **move the whole domain's nameservers to
Cloudflare** — registrar-side steps the companion document already judged
un-walkthrough-able for a non-technical user, made heavier by the fact
that delegation moves *all* the domain's DNS, not one record. Zero Trust
onboarding additionally requires choosing a plan **with payment details on
file even for the free tier** ("you will not be charged"). Compare the
Pangolin default path: create a free DuckDNS name, paste one token, done —
no purchase, no registrar, no card.

### 2.3 Access is the best free auth gate in the field — including for bots

The one-time PIN IdP gives an email-code login with no external identity
provider; Access applications and policies are API-created; and the
under-appreciated piece for OpenPalm: **service tokens**. A bot or
Guardian API client sends `CF-Access-Client-Id` / `CF-Access-Client-Secret`
headers against a Service Auth policy — authenticated machine access that
is logged and, per the seat-management docs, **consumes no user seat**.
That is cleaner than Pangolin's per-resource access tokens and categorically
better than Funnel's nothing. Per-path Bypass rules exist but are unlogged
and enforce nothing — the same "never use for this stack" verdict as
Pangolin's raw TCP resources. The free plan's seat count (50 users) is the
one figure this research could not confirm first-party; seat *mechanics*
are documented (over-limit users are blocked at login).

### 2.4 The privacy line, and the streaming fine print

The SSL FAQ states it plainly: "Cloudflare must decrypt traffic in order
to cache and filter malicious traffic." Every prompt and every model
response transits Cloudflare's edge in plaintext; Access requires that
visibility to function. This is the axis on which the companion document
scored Tailscale above Cloudflare and ngrok, and it is unchanged — there
is no end-to-end option for HTTP apps behind Tunnel + Access.

Two operational facts matter for a chat app. The proxy read timeout is
**125 seconds** (the commonly cited 100 is stale): an origin that stays
silent longer returns error 524, so token streaming must start — or
heartbeat — inside that budget. And cloudflared **buffers responses unless
the origin sends `Content-Type: text/event-stream`**, which SSE does by
definition; whether every OpenPalm streaming path carries that header is a
day-one verification item, exactly parallel to the streaming checks the
other two documents demand. WebSockets pass natively on all plans; uploads
cap at 100 MB on free.

### 2.5 The sidecar it would be — a perfect connector-class citizen

For completeness, the addon this would map onto — connector-class,
mirroring `tunnel` and `newt`, and notable for satisfying every stack
convention with no *new* exceptions (it reuses tunnel's stated
network-membership exception and nothing else):

```yaml
  cloudflared:
    profiles: ["addon.cloudflare"]
    # Distroless (no shell, no package manager), static Go binary, ~28 MB,
    # nonroot 65532 by default. CalVer releases roughly monthly; upstream
    # supports versions younger than one year — pin tag + digest and bump
    # on that cadence. The metrics/ready listener stays on loopback: its
    # only consumer is the in-container healthcheck below, and exposing it
    # on the shared networks would be an unstated deviation for no caller.
    image: cloudflare/cloudflared:2026.7.0@sha256:REPLACE_AT_IMPLEMENTATION
    restart: unless-stopped
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
    user: "${OP_UID:-1000}:${OP_GID:-1000}"   # nonroot upstream; arbitrary
                                              # uid expected fine (writes
                                              # nothing) — verify once
    command:
      # --no-autoupdate is baked into the image entrypoint. Ingress config
      # lives in Cloudflare and hot-reloads over the tunnel — no local
      # config file, no volumes at all.
      ["tunnel", "--metrics", "127.0.0.1:2000",
       "run", "--token-file", "/run/secrets/cf_tunnel_token"]
    # --token-file (2025.4.0+) reads the connector token from the mounted
    # secret — never TUNNEL_TOKEN env or argv, which land in `docker
    # inspect`; upstream itself ships VULN fixes migrating services off
    # --token for exactly this reason.
    secrets: [cf_tunnel_token]
    networks: [assistant_net, portal_net]   # same stated exception as tunnel
    # NO ports:, NO depends_on:, NO volumes. Outbound only.
    healthcheck:
      # Distroless has no wget; the binary probes its own /ready endpoint,
      # which returns 200 only with ≥1 active edge connection — tunnel-up,
      # not merely process-up.
      test: ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:2000", "ready"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
```

The edge sets `CF-Connecting-IP` / `X-Forwarded-For` / `X-Forwarded-Proto`,
so the containerized UI's existing forwarded-header wiring works, and the
`ADDRESS_HEADER` login-throttle fix — still open, shared by all three
front doors — would serve this path too.

## 3. The three-way comparison

The columns are the real product shapes, not the vendors: Tailscale as
shipped, Pangolin in-stack as proposed, Cloudflare named tunnel as it
would be. Pangolin's connector variant — the same addon pointed at a
Pangolin server elsewhere, which per the flagship proposal can be
**Pangolin Cloud or a server the operator runs on a rented VPS** — is
noted inline where it differs from the in-stack column, because it is the
shape that competes in Cloudflare's cell.

| | Tailscale Serve/Funnel (shipped) | Pangolin in-stack (proposed flagship) | Cloudflare named tunnel (assessed) |
|---|---|---|---|
| Works behind CGNAT | yes | **no** for public exposure (LAN-only mode still works; connector → any reachable Pangolin server, Cloud or own VPS: yes) | **yes** — outbound sidecar |
| Zero-cost, zero-purchase path | yes | yes (free DuckDNS default); connector→Cloud: **no** — own domain + DNS records, the free tier provides none | **no** — a bought domain, NS-delegated; card on file for Zero Trust |
| Custom domain | no (`*.ts.net`) | free DDNS name default; own domain optional | own domain only, whole domain moved to Cloudflare |
| Auth gate on public exposure | **none** | SSO / OTP / PIN / rules (self-hosted) | Access: OTP email codes, policies, per-path apps |
| Bot / machine auth | none (Funnel) | per-resource access tokens, Basic headers | **service tokens** — seatless, logged, header-based |
| Vendor reads traffic | no (SNI relay; TLS ends in-stack) | **no** in-stack (connector: Cloud **yes**, own-VPS server **no**) | **yes** — edge decrypts by design |
| Control plane | Tailscale SaaS (proprietary) | **the stack itself** (AGPL CE) | Cloudflare SaaS (proprietary) |
| Setup automation | local file + one browser ceremony (Funnel) | pangctl + blueprint + API (API key via a dashboard step; local-site API undocumented; external CE: API off by default) | **entire flow, one API token** |
| Config change latency | file watch, no restart | blueprint re-apply; container recreate for env | remote hot-reload, no restart |
| Streaming | verify day one (SNI relay, should pass) | verify day one (Traefik, 30 m read timeout) | SSE streams with `text/event-stream`; 125 s silence budget; verify day one |
| Free-tier shape | non-commercial personal tier | CE free at any scale; DuckDNS free | Tunnel free; Access free tier (50 seats, not first-party-verified); 100 MB uploads |
| Sidecar convention fit | good (needed serve-config machinery) | newt: good; server: 2–3 containers | cleanest — no volumes, no caps, file-based token, self-probing healthcheck; reuses tunnel's network exception |
| Vendor dependency posture | mature vendor, private traffic | young vendor (in-stack: no vendor at runtime beyond images; default DDNS mode leans on DuckDNS + Let's Encrypt) | mature vendor **in the plaintext path** |
| Moving parts added | 1 sidecar | 2–3 containers (server) or 1 (connector) | 1 sidecar |

The field reduces to a 2×2 the table only implies. Axis one: *can the
internet reach the host?* Axis two: *may a vendor read the traffic?*

| | Vendor-in-the-path acceptable | Vendor must not read traffic |
|---|---|---|
| **Host reachable** | (moot — no vendor needed) | **Pangolin in-stack** — no contest |
| **Host behind CGNAT** | **Cloudflare named tunnel** (best auth + automation) or Pangolin connector→Cloud (weaker vendor, same visibility, same own-domain requirement) | private access: **Tailscale Serve**, zero infrastructure. Public authenticated exposure: **Pangolin connector → a server you run** on a reachable machine (a rented VPS) — vendor-free, at the cost of operating a second machine |

The corrected version of what this grid teaches — an earlier draft
claimed the bottom-right's public case was an empty corner, which the
flagship proposal's own connector→own-VPS shape refutes — is a cost
statement, not an impossibility: every *infrastructure-free* route to
public, authenticated exposure from an unreachable host puts a vendor in
the plaintext path. The vendor-free escapes both mean operating a
reachable machine yourself — moving the stack onto one (the top-right
cell), or renting a small VPS for the Pangolin server and connecting to
it (the bottom-right).

## 4. Is there a clear winner?

**No — and the 2×2 is why.** Each option dominates a cell and is
unusable or dominated in the others:

- **Pangolin** wins both vendor-free cells: in-stack wherever the host is
  reachable — the only option matching OpenPalm's premise end to end
  (your hardware terminates TLS, your stack runs the control plane, AGPL,
  free at any scale), with an auth gate Funnel lacks and a free-name
  default Cloudflare lacks — and, via the connector pointed at a server
  the operator runs on a rented VPS, it is also the only *public,
  authenticated, vendor-free* answer from behind CGNAT, at the honest
  cost of a second machine.
- **Tailscale** wins zero-infrastructure private access — the only
  no-vendor-visibility CGNAT option that costs nothing to stand up — by
  not offering authenticated public exposure at all (Funnel is
  public-*unauthenticated*).
- **Cloudflare named tunnel** wins the infrastructure-free version of the
  CGNAT public cell — the field's best automation surface and its best
  free machine auth (service tokens) — at the two costs the stack's
  premise weighs heaviest: the vendor reads every prompt and response,
  and entry requires a bought domain fully delegated to that vendor. In
  that cell it beats the Pangolin connector→Cloud shape on maturity,
  auth quality, and automation, while the two share both the
  vendor-visibility cost and the own-domain requirement (Cloud's free
  tier provides no domain) — delegation depth and the card-on-file are
  Cloudflare's extra weight. Against the connector→own-VPS shape the
  trade inverts: Cloudflare is lighter to operate; the VPS keeps the
  plaintext yours.

"Clear advantage" therefore has a precise answer: **for OpenPalm's stated
premise (self-hosted, private), Pangolin has the clear advantage in every
cell where the premise can be honored at all, and that is why it is the
flagship.** Cloudflare's advantage is real but narrow — it exists only
where the host is unreachable, only for users who accept vendor
visibility that sits awkwardly with the reason they chose OpenPalm, and
only until the operator is willing to rent a VPS.

## 5. Recommendation

**Do not build a third addon now.** The flagship (Pangolin) and fallback
(Tailscale) already cover both privacy-respecting cells, there are no
users yet in any cell (`remote` has no install base), and a third
front-door story would triple the chooser's surface for a corner case
nobody currently occupies.

**Record Cloudflare named tunnel as the designated occupant of its cell.**
§2.5 shows it drops into the connector-class conventions with zero new
invariants — one service block, one delegated secret, one provisioning
route against a stable public API — so building it later costs no design
work, only implementation. The revisit trigger is concrete: real installs
on CGNAT asking for authenticated public sharing (the front-door chooser
can count how often the "internet cannot reach this machine" answer
co-occurs with wanting a shareable address). If that demand materializes,
this document's assessment is the spec's starting point, and the honest
disclosure copy is already written in the Pangolin proposal's register:
*"visitor traffic is decrypted on Cloudflare's servers before it reaches
you."*

One follow-through for the chooser regardless: when a CGNAT-bound
operator asks for public sharing, the UI should state the §3 cost truth
plainly and offer the real menu — a vendor path (Pangolin Cloud connector
today; Cloudflare, when built) with the visitor-traffic disclosure *and*
the own-domain requirement stated, or the vendor-free path (connect to a
Pangolin server you run on a small rented VPS) with its cost stated as
operating a second machine. Neither option hidden, neither trade
euphemized.

## 6. Sources

Primary sources. Cloudflare pages were read from the documentation's
source repository because the rendered site is unreachable from this
environment; paths are under `src/content/` in
`github.com/cloudflare/cloudflare-docs` (2026-08-06 head).

**Cloudflare docs (cloudflare-docs)**
- `docs/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api.mdx`
  — the full API lifecycle §2.1 quotes
- `.../configure-tunnels/remote-tunnel-permissions.mdx` — token fetch,
  rotation, "only requires the tunnel token to run"
- `.../do-more-with-tunnels/trycloudflare.mdx` — quick-tunnel limits: no
  SSE, 200 in-flight cap, random subdomain, dev-only
- `.../deployment-guides/terraform.mdx` — one token driving tunnel +
  ingress + DNS + Access app/policy
- `partials/cloudflare-one/tunnel/run-parameters.mdx` — `--token-file`
  (2025.4.0+), grace period, metrics
- `partials/cloudflare-one/tunnel/common-errors.mdx` — the
  `text/event-stream` buffering rule; websocket setting
- `partials/cloudflare-one/tunnel/deployment-guides/deploy-kubernetes.mdx`
  — `/ready` probe pattern, no added capabilities
- `docs/cloudflare-one/access-controls/service-credentials/service-tokens.mdx`,
  `docs/cloudflare-one/team-and-resources/users/seat-management.mdx` —
  service tokens, seatless machine auth, over-limit blocking
- `docs/cloudflare-one/integrations/identity-providers/one-time-pin.mdx`
- `docs/cloudflare-one/access-controls/policies/index.mdx`,
  `.../app-paths.mdx` — Allow/Block/Bypass/Service Auth; unlogged Bypass
- `docs/dns/zone-setups/full-setup/index.mdx`,
  `docs/dns/zone-setups/partial-setup/index.mdx` — free plan = full NS
  delegation; partial setup Business+
- `docs/ssl/faq.mdx` — "Cloudflare must decrypt traffic"
- `docs/fundamentals/reference/connection-limits.mdx`,
  `docs/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524.mdx`
  — the 125-second proxy read timeout
- `docs/fundamentals/reference/http-headers.mdx` — CF-Connecting-IP,
  X-Forwarded-For/Proto
- `docs/cloudflare-one/account-limits.mdx`, `plans/index.json`,
  `partials/cloudflare-one/choose-team-name.mdx` — Access limits, 100 MB
  upload cap, payment details required at Zero Trust onboarding

**cloudflared source (github.com/cloudflare/cloudflared)**
- `Dockerfile` — distroless nonroot base, `--no-autoupdate` entrypoint
- `cmd/cloudflared/tunnel/subcommands.go` — token/token-file precedence,
  the `ready` healthcheck subcommand
- `metrics/metrics.go`, `metrics/readiness.go` — `/ready` semantics,
  container-default bind, the pprof/cmdline block (token-leak awareness)
- `orchestration/orchestrator.go` — remote ingress hot-reload
- `proxy/proxy.go`, `ingress/config.go` — headers, websocket pipe,
  keepalive defaults, no write deadline on active streams
- `RELEASE_NOTES` — `--token-file` introduction (2025.4.0), VULN
  migrations off `--token`
- https://github.com/cloudflare/cloudflared/issues/1449 — the open
  quick-tunnel SSE bug
- Docker Hub registry API — multi-arch version-tag digests, ~28 MB image

**Unverified first-party in this environment (flagged where used)**
- https://www.cloudflare.com/plans/zero-trust-services/ — the free plan's
  50-user seat count (search-surfaced only; page fetch blocked)

**OpenPalm (working tree, this revision)**
- `.github/roadmap/0.14.0/remote-access-from-anywhere.md` — the original
  Cloudflare assessment and secondary recommendation
- `.github/roadmap/0.14.0/pangolin-remote-access.md` — the flagship
  proposal, DDNS default, the front-door chooser this document's
  recommendation feeds
