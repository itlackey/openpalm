# Remote access over TLS

This guide covers two separate operator-managed HTTPS fronts: the non-admin UI
host process on port 3880 and Guardian's direct listener on port 3830. Guardian
does not serve the UI.

## Why TLS is unavoidable for phones/remote clients

Browsers apply two platform rules that make plain HTTP a non-starter for
remote access:

- **Secure contexts.** A growing set of browser APIs (service workers,
  clipboard, some storage) only work on `https:` (or loopback) origins.
- **Mixed content.** A page served over `https:` cannot `fetch()` a plain
  `http://` URL — the browser blocks the request before it ever leaves,
  regardless of what the server would have answered.

An OpenPalm PWA on a phone must be served from an operator-provided HTTPS
origin. Any remote (non-loopback) connection it talks to must also be HTTPS, or
the request never leaves the browser. There is no official OpenPalm-hosted PWA
origin in 0.13.0. The local path needs none of this: `openpalm app` serves
`http://localhost:${OP_HOST_UI_PORT:-3880}`, which is a secure loopback context.
The process may still bind and probe `127.0.0.1` internally.

## Two separate HTTPS fronts

### UI host process (port 3880)

Complete initial setup from the canonical localhost origin first. The optional
remote PWA origin then proxies a non-admin `openpalm app` process. The current
supported external-origin path requires the explicit remote-access opt-in:

```bash
env -u OP_ENABLE_ADMIN -u OP_INSIDE_ELECTRON \
  OP_ALLOW_REMOTE_SETUP=1 openpalm app
```

Do not proxy `openpalm admin` or Electron. The command above keeps admin
capability disabled, but `OP_ALLOW_REMOTE_SETUP=1` also binds port 3880 to
`0.0.0.0` and accepts same-origin requests through the HTTPS proxy. First-run
setup stays restricted to a loopback browser origin even with this flag. Block
direct LAN/WAN access to port 3880 with the host firewall and expose it only
through the chosen HTTPS proxy. There is currently no supported switch that
both keeps 3880 loopback-only and accepts a non-loopback browser origin; if that
firewall boundary is not available, keep using the canonical localhost PWA
instead.

### Guardian direct listener (port 3830)

The thing you are fronting with TLS is the guardian's **direct listener**
(port 3830 internally, published on `${OP_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}`
by default — loopback-only). That listener 404s every request until you set

```
GUARDIAN_DIRECT_INGRESS=true
```

in `state/stack.env`. Turning on TLS fronting does **not** change this
default: the Guardian examples below tunnel to `127.0.0.1:3830` rather than
binding Guardian itself to a LAN/WAN address, so its loopback-default posture
is unchanged.

## Tailscale (recommended)

[Tailscale](https://tailscale.com/) gives you a private network (a
"tailnet") with automatic Let's Encrypt certificates and zero port
forwarding. This is the recommended default because it needs no cert
management on your part and nothing is reachable outside your tailnet.

1. Enable the direct listener:

   ```
   # state/stack.env
   GUARDIAN_DIRECT_INGRESS=true
   ```

2. Install Tailscale on the host and make sure HTTPS is enabled on your
   tailnet (`tailscale cert` / the Tailscale admin console — required once
   per tailnet).

3. Serve the guardian's direct listener over HTTPS on the default HTTPS port:

   ```
   tailscale serve --bg --https=443 http://127.0.0.1:3830
   ```

   This publishes `https://<machine>.<tailnet>.ts.net` with an automatic,
   auto-renewing Let's Encrypt certificate. No certificate files to manage,
   no port forwarding, and the address is reachable only from inside your
   tailnet.

4. To host the PWA on the same Tailscale machine, first start the non-admin UI
   process as described in [UI host process](#ui-host-process-port-3880), then
   give it a distinct HTTPS port:

   ```
   tailscale serve --bg --https=8443 http://127.0.0.1:3880
   ```

   The browser UI origin is now
   `https://<machine>.<tailnet>.ts.net:8443`. This is separate from the Guardian
   origin on port 443.

5. Add that exact browser origin to Guardian's CORS allowlist (see
   [CORS origin note](#cors-origin-note) below) and apply it:

   ```
   # state/stack.env
   GUARDIAN_CORS_ALLOWED_ORIGINS=https://<machine>.<tailnet>.ts.net:8443
   ```

   ```
   docker compose up -d guardian
   ```

   If the browser remains on the canonical local app instead, use
   `http://localhost:3880`. The admin UI's apply flow is equivalent.

Open the PWA at `https://<machine>.<tailnet>.ts.net:8443` and set its Guardian
connection URL to `https://<machine>.<tailnet>.ts.net/oc`.

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

This is marked advanced because it needs a tailnet auth key and its own state
volume. It fronts Guardian only: because it shares Guardian's network namespace,
its `127.0.0.1` is not the host UI process. Use host-level `tailscale serve`
above when the same machine must also host the PWA.

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

### Host-level Caddy for both origins

The sidecar above fronts Guardian only. To proxy both loopback services on the
same machine, run Caddy on the host instead, start the non-admin UI process as
described in [UI host process](#ui-host-process-port-3880), and use distinct
hostnames:

```caddyfile
ui.example.com {
  reverse_proxy 127.0.0.1:3880
}

gw.example.com {
  reverse_proxy 127.0.0.1:3830
}
```

Apply the same certificate strategy described above to both hostnames. Keep
direct ports 3880 and 3830 blocked by the host firewall. Then configure:

```env
GUARDIAN_CORS_ALLOWED_ORIGINS=https://ui.example.com
```

Open `https://ui.example.com` and use `https://gw.example.com/oc` as the
Guardian connection URL. Caddy forwards UI traffic to port 3880 and Guardian
traffic to port 3830; neither service impersonates the other.

## CORS origin note

Whatever you put in `GUARDIAN_CORS_ALLOWED_ORIGINS` must be the **browser
app's origin** — where the OpenPalm client itself is served from (e.g. the
canonical `http://localhost:3880`, or your operator-provided
`https://ui.example.com`) — **not** the guardian's own address. Origins must be
exact (comma-separated for more than one); the guardian rejects a literal `*`.
The exact-origin matcher normalizes via `URL.origin` and supports HTTPS origins.

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
- **TLS/mTLS termination is an infrastructure concern.** The guardian serves
  plain HTTP on its direct listener (3830); it does not terminate TLS itself.
  If you want transport encryption or client-certificate (mTLS) authentication,
  terminate it at the reverse proxy you front the guardian with (Tailscale
  `serve`, Caddy `tls { client_auth }`, nginx `ssl_verify_client`, etc.) and
  forward plain HTTP to the guardian on the trusted network.

## Non-goals

- **No official hosted PWA or default hosted-origin CORS grant.** Operators may
  serve the UI from their own HTTPS origin and allow that exact origin.
- **No private CA installs on phones, ever.** Neither route above asks a
  user to trust a self-signed or private CA on iOS/Android (the mkcert-style
  pattern) — both Tailscale and the Caddy/DNS-challenge path issue real,
  publicly-trusted Let's Encrypt certificates.
- **No public-internet exposure guidance beyond these two paths.** This
  guide does not cover opening port 80/443 to the public internet, WAF/rate
  limiting for a public deployment, or anything beyond fronting the direct
  listener for your own remote clients.
