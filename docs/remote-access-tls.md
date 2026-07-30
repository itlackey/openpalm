# Remote Access over TLS

This guide fronts two separate services with operator-managed HTTPS:

- the non-admin `openpalm app` host process on port `3880`
- Guardian direct ingress on port `3830`

Do not expose the host admin UI or Guardian's principal-admin listener.

The two services are asymmetric. `openpalm app` has a trusted-proxy mode that
stays bound to loopback while trusting your proxy's forwarded headers — it
never opens a network-facing listener. Guardian has no equivalent: its direct
ingress can only be turned on together with a non-loopback bind (see
[Guardian](#guardian) below), so it is genuinely reachable in plain HTTP on
your LAN once enabled, independent of whatever HTTPS proxy you put in front of
it. Firewall it accordingly if that matters for your network.

## Why Remote Browsers Need TLS

Remote browser origins need HTTPS for secure-context APIs, service workers, and
credential storage. An HTTPS page also cannot call a plain-HTTP Guardian URL
because browsers block mixed content.

Loopback development at `http://localhost` is exempt. Phones and other remote
clients should use operator-provided HTTPS for both the UI origin and Guardian
connection.

## Prepare OpenPalm

Complete setup locally first.

### The UI (`openpalm app`)

Start the non-admin host app with the trusted-proxy opt-in:

```bash
OP_TRUSTED_PROXY=1 openpalm app
```

This keeps the app bound to loopback (`127.0.0.1:3880`) while trusting the
`Host` and `x-forwarded-proto` headers your TLS proxy forwards — exactly what
Tailscale Serve, Caddy, and nginx need, since all three proxy to loopback on
the same host. Nothing is exposed beyond loopback, so there is no port to
firewall here. `openpalm admin` and Electron ignore this flag and remain
loopback-only regardless.

`OP_ALLOW_REMOTE_SETUP=1` still exists as a separate opt-in for the rare case
of no reverse proxy at all — it binds `0.0.0.0` directly instead of trusting
forwarded headers. Prefer `OP_TRUSTED_PROXY` whenever a proxy is in the
picture, which is every topology in this guide.

### Guardian

Ensure a Guardian-bearing addon is enabled. `gateway` is suitable when you only
need direct Guardian ingress:

```bash
openpalm addon enable gateway
```

Turn on the **"Let other devices reach the guardian"** access toggle
(`access.guardianNetwork`) from the host Admin UI's Assistant settings
("Advanced access options"), or set `access.guardianNetwork: true` in a
headless install spec. This is the only supported way to publish Guardian's
direct listener: the toggle sets `OP_GUARDIAN_BIND_ADDRESS=0.0.0.0` and
`GUARDIAN_DIRECT_INGRESS=true` together, atomically, and applies them
immediately (the affected container is recreated so the port publish actually
takes effect, same as every other access toggle).

Do not hand-edit `GUARDIAN_DIRECT_INGRESS=true` into `state/stack.env` while
trying to keep `OP_GUARDIAN_BIND_ADDRESS=127.0.0.1` — the flat access model
derives both from the single `guardianNetwork` toggle
(`packages/lib/src/control-plane/access-toggles.ts` `resolveAccessEnv`), so
that combination cannot be expressed and the next toggle save (even an
unrelated one, if it round-trips the Access form) silently reverts a hand
edit. There is no loopback-bound "serve but don't publish" mode for Guardian's
direct listener, unlike the UI above.

Because of that, turning this toggle on makes Guardian's plain-HTTP direct
listener reachable directly on your LAN on port `3830`, not only through your
TLS proxy. If you want the TLS proxy to be the only entry point, firewall
`3830` from other hosts on your network — this is not optional cleanup, it is
what keeps Basic-auth credentials from crossing your LAN in cleartext when a
client bypasses the proxy.

Add the exact HTTPS UI origin to Guardian's CORS allowlist:

```dotenv
GUARDIAN_CORS_ALLOWED_ORIGINS=https://ui.example.com
```

Then reapply Guardian so Compose reads the new environment:

```bash
openpalm start guardian
```

Guardian content validation remains on by default for this traffic.

## Tailscale

[Tailscale](https://tailscale.com/) provides private reachability and trusted
certificates without public port forwarding.

After enabling HTTPS for your tailnet, front the UI and Guardian on different
HTTPS ports:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3880
tailscale serve --bg --https=8443 http://127.0.0.1:3830
```

Use these values:

```dotenv
GUARDIAN_CORS_ALLOWED_ORIGINS=https://machine.example.ts.net
```

- OpenPalm UI: `https://machine.example.ts.net`
- Guardian connection: `https://machine.example.ts.net:8443/oc`

Replace the example hostname with the one Tailscale reports. Reapply Guardian
after changing the CORS value.

## Caddy

Run Caddy on the host so it can reach both local listeners:

```caddyfile
ui.example.com {
  reverse_proxy 127.0.0.1:3880
}

guardian.example.com {
  reverse_proxy 127.0.0.1:3830
}
```

Configure DNS and certificates using Caddy's normal HTTPS workflow, then set:

```dotenv
GUARDIAN_CORS_ALLOWED_ORIGINS=https://ui.example.com
```

Open `https://ui.example.com` and use
`https://guardian.example.com/oc` as the Guardian connection URL.

The UI never needs firewalling: with `OP_TRUSTED_PROXY=1` it stays bound to
`127.0.0.1:3880` the whole time, so port `3880` is not reachable from anything
but this host regardless of what Caddy does. Guardian's direct listener is
different — `access.guardianNetwork` on means `3830` is bound `0.0.0.0` (see
[Guardian](#guardian) above), so keep it firewalled from untrusted networks if
Caddy's HTTPS endpoint should be the only way in.

## CORS

`GUARDIAN_CORS_ALLOWED_ORIGINS` contains browser UI origins, not Guardian
origins. Values are exact and comma-separated:

```dotenv
GUARDIAN_CORS_ALLOWED_ORIGINS=https://ui.example.com,https://machine.example.ts.net
```

Guardian rejects `*`. Include scheme and port when the port is non-default.

## Client Connection

In the OpenPalm UI, add a Guardian connection whose base URL ends in `/oc` and
use HTTP Basic authentication:

- username: Guardian principal ID
- password: that principal's token

Create or rotate principals through the host pairing UI or Guardian's separate
loopback admin listener. The latter remains valid at
`http://127.0.0.1:3831/admin/principals` and reads its bearer token from:

```text
~/.openpalm/private/secrets/op_guardian_admin_token
```

Never proxy port `3831`.

## Security Boundaries

- `openpalm app` is non-admin. `/api/host/*` is unavailable without a host-admin capability.
- `/admin/*` is intentionally `404` on the UI server.
- `OP_TRUSTED_PROXY` keeps `openpalm app` on loopback end to end; only Guardian's direct listener genuinely leaves loopback, and only once `access.guardianNetwork` is on.
- Guardian serves plain HTTP internally; TLS terminates at Tailscale, Caddy, or another operator proxy.
- Guardian principal authentication, ownership checks, limits, and content validation still apply behind TLS, and equally to any client that reaches Guardian directly instead of through the proxy.
- The UI session cookie is `HttpOnly` and `SameSite=Lax`; serve one stable HTTPS origin.

This guide does not recommend public-internet exposure. Add firewalling, abuse
controls, and operational monitoring before using a public reverse proxy.
