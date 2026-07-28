# Remote Access over TLS

This guide fronts two separate services with operator-managed HTTPS:

- the non-admin `openpalm app` host process on port `3880`
- Guardian direct ingress on port `3830`

Do not expose the host admin UI or Guardian's principal-admin listener.

## Why Remote Browsers Need TLS

Remote browser origins need HTTPS for secure-context APIs, service workers, and
credential storage. An HTTPS page also cannot call a plain-HTTP Guardian URL
because browsers block mixed content.

Loopback development at `http://localhost` is exempt. Phones and other remote
clients should use operator-provided HTTPS for both the UI origin and Guardian
connection.

## Prepare OpenPalm

Complete setup locally first. Then start only the non-admin host app with the
explicit remote opt-in:

```bash
OP_ALLOW_REMOTE_SETUP=1 openpalm app
```

This binds the host app beyond loopback so it can accept the remote Host and
Origin headers forwarded by the TLS proxy. `openpalm admin` and Electron ignore
this flag and remain loopback-only. Keep port `3880` blocked from untrusted
networks so clients use the HTTPS proxy rather than its plain-HTTP listener.

Ensure a Guardian-bearing addon is enabled. `gateway` is suitable when you only
need direct Guardian ingress:

```bash
openpalm addon enable gateway
```

Keep Guardian loopback-only and enable its direct listener explicitly in
`state/stack.env`:

```dotenv
OP_GUARDIAN_BIND_ADDRESS=127.0.0.1
GUARDIAN_DIRECT_INGRESS=true
```

There is no global bind cascade. `OP_GUARDIAN_BIND_ADDRESS` is the effective
Guardian bind; `OP_ALLOW_REMOTE_SETUP` applies only to the non-admin host app
process that inherits it.

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

Keep direct host access to ports `3880` and `3830` blocked from untrusted
networks. After firewalling, the HTTPS proxy is the only remotely reachable
listener.

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
- Guardian serves plain HTTP internally; TLS terminates at Tailscale, Caddy, or another operator proxy.
- Guardian principal authentication, ownership checks, limits, and content validation still apply behind TLS.
- The UI session cookie is `HttpOnly` and `SameSite=Lax`; serve one stable HTTPS origin.

This guide does not recommend public-internet exposure. Add firewalling, abuse
controls, and operational monitoring before using a public reverse proxy.
