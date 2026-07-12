# Remote access over TLS

This guide covers exposing the guardian's **direct listener** to a phone or
any client that isn't on the same machine, over a real HTTPS connection.

## Why TLS is unavoidable for phones/remote clients

Browsers apply two platform rules that make plain HTTP a non-starter for
remote access:

- **Secure contexts.** A growing set of browser APIs (service workers,
  clipboard, some storage) only work on `https:` (or loopback) origins.
- **Mixed content.** A page served over `https:` cannot `fetch()` a plain
  `http://` URL — the browser blocks the request before it ever leaves,
  regardless of what the server would have answered.

Because the hosted/PWA-installed OpenPalm client runs on an https origin,
any remote (non-loopback) connection it talks to must also be https, or the
request never leaves the browser. The desktop/localhost path needs none of
this: a `127.0.0.1` origin talking to a `127.0.0.1` target is a secure
context with no mixed-content restriction, so it stays zero-TLS by default.

## What you are exposing

The thing you are fronting with TLS is the guardian's **direct listener**
(port 3830 internally, published on `${OP_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}`
by default — loopback-only). That listener 404s every request until you set

```
GUARDIAN_DIRECT_INGRESS=true
```

in `knowledge/env/stack.env`. Turning on TLS fronting does **not** change
this default: both routes below tunnel to `127.0.0.1:3830` rather than
binding the guardian itself to a LAN/WAN address, so the loopback-default
posture is unchanged.

## Tailscale (recommended)

[Tailscale](https://tailscale.com/) gives you a private network (a
"tailnet") with automatic Let's Encrypt certificates and zero port
forwarding. This is the recommended default because it needs no cert
management on your part and nothing is reachable outside your tailnet.

1. Enable the direct listener:

   ```
   # knowledge/env/stack.env
   GUARDIAN_DIRECT_INGRESS=true
   ```

2. Install Tailscale on the host and make sure HTTPS is enabled on your
   tailnet (`tailscale cert` / the Tailscale admin console — required once
   per tailnet).

3. Serve the guardian's direct listener over HTTPS:

   ```
   tailscale serve --bg 127.0.0.1:3830
   ```

   This publishes `https://<machine>.<tailnet>.ts.net` with an automatic,
   auto-renewing Let's Encrypt certificate. No certificate files to manage,
   no port forwarding, and the address is reachable only from inside your
   tailnet.

4. Add the browser app's origin to the guardian's CORS allowlist (see
   [CORS origin note](#cors-origin-note) below) and apply it:

   ```
   # knowledge/env/stack.env
   GUARDIAN_CORS_ALLOWED_ORIGINS=https://app.openpalm.dev
   ```

   ```
   docker compose up -d guardian
   ```

   (or use the admin UI's apply flow — either restarts the guardian with the
   new allowlist.)

Point the OpenPalm client's connection URL at
`https://<machine>.<tailnet>.ts.net`.

### Container-only hosts (advanced)

If the host itself doesn't run Tailscale directly (e.g. a container-only
deployment), a `tailscale` sidecar can front the guardian instead. Add it to
the user-owned `config/stack/custom.compose.yml` overlay, with `TS_AUTHKEY`
granted as a file secret (per the secret-name authorization rules in
`docs/technical/core-principles.md`):

```yaml
# config/stack/custom.compose.yml
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: openpalm-guardian
    environment:
      TS_AUTHKEY_FILE: /run/secrets/tailscale_authkey
      TS_EXTRA_ARGS: --advertise-tags=tag:openpalm
      TS_SERVE_CONFIG: /config/serve.json
    volumes:
      - ./tailscale-state:/var/lib/tailscale
    secrets:
      - tailscale_authkey
    network_mode: service:guardian

secrets:
  tailscale_authkey:
    file: ./knowledge/secrets/tailscale_authkey
```

This is marked advanced because it needs a tailnet auth key and its own
state volume; `tailscale serve` on the host (above) is simpler whenever the
host itself can run Tailscale.

## Caddy with your own domain

If you'd rather not use Tailscale, [Caddy](https://caddyserver.com/) can
front the guardian with a certificate for a domain you own, using
DNS-challenge Let's Encrypt (works without opening port 80/443 to the
internet, as long as your DNS provider is supported and the record can stay
LAN-only).

Add a Caddy service to the user-owned `config/stack/custom.compose.yml`
overlay:

```yaml
# config/stack/custom.compose.yml
services:
  caddy:
    image: caddy:2
    ports:
      - "443:443"
    volumes:
      - ./config/stack/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    environment:
      CF_API_TOKEN_FILE: /run/secrets/caddy_dns_token
    secrets:
      - caddy_dns_token
    network_mode: service:guardian

secrets:
  caddy_dns_token:
    file: ./knowledge/secrets/caddy_dns_token

volumes:
  caddy-data:
```

And drop a `Caddyfile` beside it:

```
# config/stack/Caddyfile
gw.example.com {
  reverse_proxy 127.0.0.1:3830
  tls {
    dns cloudflare {env.CF_API_TOKEN_FILE}
  }
}
```

**Note:** the stock `caddy` image ships no DNS-provider modules — a
DNS-challenge certificate needs a build with your provider's plugin (see the
[`caddy-dns`](https://github.com/caddy-dns) org for the list, and
[`caddy-docker-proxy`/xcaddy](https://caddyserver.com/docs/build#xcaddy) docs
for building a custom image). This extra step is exactly why Tailscale is
the recommended default and Caddy is the alternative for users who already
own a domain and DNS provider account.

## CORS origin note

Whatever you put in `GUARDIAN_CORS_ALLOWED_ORIGINS` must be the **browser
app's origin** — where the OpenPalm client itself is served from (e.g. the
hosted client origin, or the `https://….ts.net`/domain origin if you serve
the client build through the same TLS front) — **not** the guardian's own
address. Origins must be exact (comma-separated for more than one); the
guardian rejects a literal `*`. The exact-origin matcher normalizes via
`URL.origin` and supports https origins fine — the guardian's own CORS test
suite's allowed origin is literally `https://app.openpalm.dev`.

## Client behavior

The OpenPalm client refuses to submit or use a plain-HTTP connection URL for
a non-loopback host whenever the client itself is running on an `https:`
origin — the mixed-content rule above means the request could never succeed,
so the client refuses up front with an actionable message instead of a
confusing connection failure. The add/edit connection form shows this as a
validation error linking back to this guide; an existing connection that
becomes insecure (e.g. its URL changes) shows a **`needs HTTPS`** badge with
the same link, instead of a plain "unreachable".

Loopback targets (`127.0.0.1`/`localhost`/`::1`) are always allowed — the
mixed-content rule exempts them. Plain-HTTP LAN connections from a
loopback-origin client (the zero-TLS desktop default) and from a
LAN-served, non-https client are also unaffected; TLS is never required on
those default paths.

## Coordination notes

- **mDNS (`.local` names, #488).** The host's mDNS responder advertises
  plain-HTTP `.local` names for same-LAN discovery. That's a LAN-local
  affordance only — once you TLS-front the guardian, share the
  `ts.net`/domain HTTPS URL with remote clients, not the `.local` name.
- **mTLS on the direct listener (#435).** The direct listener (3830) can
  optionally terminate **mTLS** as an adapter transport identity (see
  [`docs/technical/guardian-direct-mtls.md`](technical/guardian-direct-mtls.md)).
  A browser TLS front (Tailscale `serve` or Caddy, above) and guardian-side
  mTLS are **mutually exclusive on the same listener** — the proxy holds no
  client certificate, so it can't complete an mTLS handshake with the
  guardian. If you need both a browser-facing TLS front and mTLS-authenticated
  adapters, see the client-cert discussion in the mTLS design note.

## Non-goals

- **No private CA installs on phones, ever.** Neither route above asks a
  user to trust a self-signed or private CA on iOS/Android (the mkcert-style
  pattern) — both Tailscale and the Caddy/DNS-challenge path issue real,
  publicly-trusted Let's Encrypt certificates.
- **No public-internet exposure guidance beyond these two paths.** This
  guide does not cover opening port 80/443 to the public internet, WAF/rate
  limiting for a public deployment, or anything beyond fronting the direct
  listener for your own remote clients.
