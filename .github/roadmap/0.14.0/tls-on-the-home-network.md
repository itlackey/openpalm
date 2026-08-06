# TLS on the home network

Status: assessment
Companion to `access-presets-redesign.md`. Deliberately separate: network
access answers *who may reach the assistant*; TLS answers *whether the
connection is encrypted*. Folding them into one axis is the mistake the
access design exists to remove.

## 1. Why this is not optional polish

Two shipped features are already unavailable from any device except the
desktop, and both are browser-platform consequences of plain HTTP rather than
security preferences:

| Feature | Requires | On `http://openpalm.local:3800` |
|---|---|---|
| Voice — `lib/voice/vad.ts`, `media-recorder.ts` (`getUserMedia`) | secure context | **unavailable** |
| PWA install — `hooks.server.ts` PWA asset allowlist, `service-worker.ts` | secure context | **unavailable** |

Browsers grant secure-context status to `http://localhost` but not to
`http://192.168.1.50` or `http://openpalm.local`. The desktop user gets voice
and "install to home screen"; the phone user — the entire point of network
access — does not.

## 2. The hard constraint

**No public CA will issue a certificate for `openpalm.local`.** `.local` is
reserved for mDNS (RFC 6762) and is on the CA/Browser Forum prohibited list, as
are RFC1918 IP addresses. The zero-config mDNS name and a publicly-trusted
certificate can never coexist.

Requiring free certificates with no root CA pushed to devices rules out a
private CA outright — that requirement *is* the definition of a private CA.
What remains: a genuine certificate for a real name, with that name pointing at
a private IP. A public `A` record → `192.168.1.50` is legal and common.

## 3. Options, by cost

**Tier 0 — Tailscale.** Already documented (`docs/remote-access-tls.md`).
`machine.tailnet.ts.net` with an auto-renewing Let's Encrypt certificate, zero
certificate handling, no inbound ports. **Engineering cost: none.** Cost to the
user: a client install per device — a real barrier for "any device on my
network", but it also solves remote access. Best answer for anyone willing to
install one app.

**Tier 1 — ACME DNS-01 with a free dynamic-DNS provider.** DNS-01 validates by
writing a TXT record through the provider's API — entirely outbound, so it
works behind NAT with no port forwarding. Providers like DuckDNS give a free
subdomain plus an API token; the user pastes one token.

1. Bundle **`lego`** — one static Go binary, ~150 DNS providers built in.
   Deliberately not Caddy's DNS plugins, which need an `xcaddy` rebuild per
   provider — an unending packaging tax.
2. Wizard step: choose provider, paste token → stored as a file secret.
3. Renewal on the existing scheduler co-process, 60-day cadence.
4. Serve TLS by mounting adapter-node's `handler.js` in a custom
   `https.createServer`. No reverse-proxy sidecar.
5. Keep the `A` record on the current LAN IP (DHCP reservation, or an updater).

**Roughly a week**, with a long tail of provider support. The bugs live in
steps 3 and 5, not in issuance.

**Tier 2 — bring your own domain.** Falls out of Tier 1 for free.

*Added with `pangolin-remote-access.md`:* a fourth path now exists as a
sibling proposal rather than a tier built here. The Pangolin addon's proxy
variant, used LAN-only, terminates TLS with the same DNS-01 issuance this
tier describes (Traefik drives lego's providers) and adds an SSO gate in
front — at the cost of two containers against one bundled binary, and a
domain the operator controls rather than a free dynamic-DNS subdomain. It
does not replace Tier 1 for the paste-one-token case; it makes the Tier 2
case something the stack can run instead of something the operator
assembles.

## 4. The shortcut, stated honestly

Services such as `traefik.me` publish a wildcard certificate for a wildcard-DNS
domain **together with its private key**. Point at `192-168-1-50.traefik.me`,
get an instantly-valid certificate, zero signup.

It unlocks voice and PWA. It provides **no confidentiality against anyone on
the LAN** — the private key is public, so traffic is trivially decryptable and
the connection trivially impersonated. It is encryption theatre that happens to
satisfy the browser.

Defensible as a clearly-labelled "unlock voice on my home network" toggle.
Indefensible as anything presented as security. Named here so the trade-off is
a decision rather than a discovery.

## 5. Recommendation

Run **both listeners**: plain HTTP on the `.local` name, and HTTPS on the real
name once configured.

- A failed renewal then degrades to "voice stopped working", not "nobody can
  reach the assistant". Certificate automation's worst failure mode is total
  lockout; a second listener removes it.
- Discovery is unaffected, because the QR code makes the hostname invisible.
  Scanning `https://myhome.duckdns.org:3800` is exactly as easy as scanning the
  `.local` URL, so losing the pretty name costs nothing on the primary flow.

Sequence this **after** network access works over plain HTTP. TLS on a listener
nobody can reach is wasted effort.
