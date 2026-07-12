# Guardian direct-listener mTLS — adapter transport identity

> Design note for issue #435. Records the D1 spike evidence, the
> passthrough architecture, the fail-closed verification rule, the identity
> model, operator provisioning, rotation, and known trade-offs.

## 1. What this ships

An **opt-in** TLS-terminating passthrough in front of the guardian's direct
listener (port 3830 — LAN/adapter ingress; the internal 8080 and admin 3831
listeners are untouched). Configured with three environment variables:

- `GUARDIAN_TLS_CERT_FILE` — path to the guardian's TLS server certificate (PEM)
- `GUARDIAN_TLS_KEY_FILE` — path to the matching private key (PEM)
- `GUARDIAN_MTLS_CA_FILE` — path to the operator's adapter CA certificate (PEM)

All three set → mTLS on. All three unset/empty (the default) → the direct
listener binds byte-for-byte as it does today: plain HTTP, `Bun.serve`. Any
other combination is a **fail-closed boot error** naming the missing
variable(s) — there is no server-only-TLS mode on this listener (see § 5).

Any client certificate signed by the operator's adapter CA passes the
transport. The **Principal still comes from HTTP Basic auth**, exactly as
before — this is a machine/transport identity for adapters, not an identity
provider. See § 4.

## 2. D1 — why a `Bun.listen` passthrough, not `Bun.serve({ tls })` or `node:https`

The assessment's "single biggest unknown" was Bun's server-side client-cert
verification. It was spiked before writing spec 435, on Bun 1.3.11 (this
repo's pinned runtime), with a real openssl fixture (operator CA, a
CA-signed client cert, and a client cert signed by a *different*,
untrusted CA) and cross-validated against Node 22, which enforces all three
cases correctly.

| Server construction | good cert | no cert | **wrong-CA cert** |
|---|---|---|---|
| `Bun.serve({ tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true } })` | 200 | rejected | **200 — ACCEPTED (broken)** |
| `node:https createServer(...)` under Bun | 200 | rejected | **200 — ACCEPTED; `req.socket` has no `getPeerCertificate`/`authorized`** |
| `Bun.listen({ tls: {...} })` + `handshake(socket, success, authorizationError)` | `success=true, authorizationError=null` | `success=false` | `success=true`, **`authorizationError = "unable to verify the first certificate"`**; `socket.authorized` is buggy-`true`; `getPeerX509Certificate()` works (subject + `fingerprint256`) |

Conclusions:

1. On the current Bun runtime, both `Bun.serve({ tls })` and the `node:https`
   shim accept a client certificate signed by **any** CA when
   `requestCert`/`rejectUnauthorized` are set. Shipping either as "mTLS"
   would only verify a cert is *present*, not that it chains to the trusted
   CA — a false security claim, worse than shipping nothing.
2. `Bun.listen`'s `handshake` callback is the one Bun API that reliably
   surfaces the verification result — as the `authorizationError` parameter,
   **not** as `socket.authorized` (which reports `true` even on
   verification failure). The fail-closed acceptance condition the guardian
   implements is therefore:

   ```
   success === true && authorizationError === null
   ```

   `packages/guardian/src/tls-passthrough.test.ts` pins the wrong-CA
   rejection case, so any future Bun handshake-semantics change fails CI
   loudly instead of silently weakening the boundary. **If a future Bun
   upgrade fixes `Bun.serve({ tls })`'s client-cert verification, this
   passthrough can be simplified away deliberately — re-run the wrong-CA
   test against the new runtime first.**
3. Deferring to #557's Caddy/Tailscale edge was rejected for this issue's
   surface: #557 is not landed, targets *remote* browser clients, and the
   direct listener is the LAN adapter surface this issue uniquely owns. See
   § 6 for the coordination contract.

## 3. Architecture

```
                 mTLS (verified)              plain HTTP (loopback only)
adapter  ───────────────────────►  Bun.listen  ───────────────────────►  Bun.serve
(LAN)         port 3830           (tls-passthrough.ts)   127.0.0.1:ephemeral  (direct handler)
```

- `Bun.listen` binds the **public** port (3830) with
  `tls: { cert, key, ca, requestCert: true, rejectUnauthorized: true }`.
- On `handshake`, a rejected connection (`!success || authorizationError !== null`)
  is logged (`mtls_handshake_rejected`, with the error string and remote
  address) and the socket is ended — **no byte reaches the upstream**.
- On an accepted handshake, the accepted client cert's `subject` and
  `fingerprint256` are logged (`mtls_handshake_accepted`) — this is public
  material (not a secret), logged so operators can correlate which adapter
  connected. The cert/key **PEM contents are never logged**, at handshake or
  at boot.
- The guardian's existing direct-request `fetch` handler is re-bound on
  `Bun.serve({ port: 0, hostname: '127.0.0.1' })` (an ephemeral loopback
  port) instead of the public port. The passthrough relays raw bytes
  bidirectionally between the verified client socket and this loopback
  socket, honoring `write()` backpressure on both directions.
- Because this is a raw byte pipe (no HTTP parsing), it transparently
  supports the direct listener's streaming (SSE `/oc/event`) and every
  existing route (`/health`, `/oc/*`, `/mcp`) unchanged.
- This is ~150 lines in one new module (`tls-passthrough.ts`), zero new
  dependencies (`node:net`/`bun`'s `Bun.listen`/`Bun.connect` only).

## 4. D2 — identity model: transport, not an identity provider

mTLS here answers **"is this connection from a certificate the operator's
adapter CA signed?"** — CA membership is adapter-fleet membership. It does
**not** answer "who is the acting principal?" — that question is still
answered by HTTP Basic auth exactly as before (`auth.ts`, unmodified).
There is no cert-fingerprint → principal mapping anywhere in this design; a
verified mTLS connection with no `Authorization` header still gets a 401 from
`/oc/*`.

This matches the issue's own framing ("a machine/transport identity for
adapters, not an identity provider") and the milestone's schema policy: no
`cert_fingerprint` column is added, because no consumer of it ships in this
issue. If a downstream ever wants cert→principal mapping, #433's
`user_version` migration runner is the ready path — deliberately not used
here.

## 5. D3 — why "all three or nothing" (no server-only TLS)

A server-only-TLS direct listener (cert+key, no client CA) is **#557's**
scope: edge TLS for remote browsers, paired with a guide steering operators
toward a Tailscale/Caddy front. Shipping a second, overlapping TLS knob on
the same port mid-milestone would be confusing and duplicate effort. The
`DirectTlsConfig` type is a discriminated union (`{ mode: 'off' }` |
`{ mode: 'mtls'; certPath; keyPath; caPath }`), so adding a server-only mode
later is additive, not a breaking change.

## 6. D6 — coordination with #557

The direct listener's mTLS is a separate raw-TLS surface on 3830 for **LAN
adapters** authenticating with client certificates. It does not move behind
#557's future Caddy/Tailscale edge, and the two are not mutually exclusive:
if an operator later fronts the guardian with such an edge for **remote
browsers**, the mTLS passthrough on 3830 and the edge's TLS termination
coexist — different ports, different audiences (adapters vs. browsers).
#557's guide should link this note for operators who want client-cert auth
at the Caddy edge instead of (or in addition to) this direct-listener mTLS.

## 7. Operator provisioning

All commands use `openssl` (already required for anything TLS-adjacent);
EC P-256 keys keep this fast. Run once, in a directory the operator
controls **outside** `~/.openpalm/knowledge/secrets/` for the CA key (see
warning below).

```bash
# 1. Mint the operator's adapter CA. KEEP THIS KEY OFFLINE — it signs every
#    adapter cert. It is never mounted into the guardian container; only the
#    CA CERTIFICATE (not the key) is granted as op_guardian_mtls_ca below.
openssl ecparam -name prime256v1 -genkey -noout -out adapter-ca-key.pem
openssl req -x509 -new -key adapter-ca-key.pem -sha256 -days 3650 \
  -subj "/CN=<your-name> OpenPalm Adapter CA" -out adapter-ca-cert.pem

# 2. Mint the guardian's server certificate. The SAN MUST cover whatever
#    address/hostname adapters dial (the LAN IP or DNS name of the host
#    running the guardian, NOT necessarily 127.0.0.1).
openssl ecparam -name prime256v1 -genkey -noout -out guardian-server-key.pem
openssl req -new -key guardian-server-key.pem -subj "/CN=<guardian-host>" -out guardian-server-csr.pem
printf 'subjectAltName=IP:<lan-ip>,DNS:<guardian-host>\nextendedKeyUsage=serverAuth\n' > server-ext.cnf
openssl x509 -req -in guardian-server-csr.pem -CA adapter-ca-cert.pem -CAkey adapter-ca-key.pem \
  -CAcreateserial -days 825 -sha256 -extfile server-ext.cnf -out guardian-server-cert.pem

# 3. Mint one client cert per adapter (repeat per device).
openssl ecparam -name prime256v1 -genkey -noout -out adapter-1-key.pem
openssl req -new -key adapter-1-key.pem -subj "/CN=adapter-1" -out adapter-1-csr.pem
printf 'extendedKeyUsage=clientAuth\n' > client-ext.cnf
openssl x509 -req -in adapter-1-csr.pem -CA adapter-ca-cert.pem -CAkey adapter-ca-key.pem \
  -CAcreateserial -days 825 -sha256 -extfile client-ext.cnf -out adapter-1-cert.pem
```

### Enabling it

1. Place `guardian-server-cert.pem`, `guardian-server-key.pem`, and
   `adapter-ca-cert.pem` (the CA **certificate** only — never the CA key)
   under `~/.openpalm/knowledge/secrets/` as `op_guardian_tls_cert`,
   `op_guardian_tls_key`, and `op_guardian_mtls_ca` respectively (`0600`).
2. Grant those three secrets to the guardian service via the sanctioned user
   extension point, `~/.openpalm/config/stack/custom.compose.yml` (core
   principles § 1b) — the managed `portals.compose.yml` deliberately does
   **not** grant them unconditionally (D4: Compose fails `up` when a
   `secrets:` file is missing on disk, and the guardian deploys with any
   portal addon, so an unconditional grant would break every certless
   install):

   ```yaml
   services:
     guardian:
       secrets:
         - op_guardian_tls_cert
         - op_guardian_tls_key
         - op_guardian_mtls_ca

   secrets:
     op_guardian_tls_cert:
       file: ${OP_HOME}/knowledge/secrets/op_guardian_tls_cert
     op_guardian_tls_key:
       file: ${OP_HOME}/knowledge/secrets/op_guardian_tls_key
     op_guardian_mtls_ca:
       file: ${OP_HOME}/knowledge/secrets/op_guardian_mtls_ca
   ```

3. Set the three env vars in `~/.openpalm/knowledge/env/stack.env` (they are
   explicitly non-secret-like `*_FILE` path variables, so `stack.env` is the
   correct file for them):

   ```
   GUARDIAN_TLS_CERT_FILE=/run/secrets/op_guardian_tls_cert
   GUARDIAN_TLS_KEY_FILE=/run/secrets/op_guardian_tls_key
   GUARDIAN_MTLS_CA_FILE=/run/secrets/op_guardian_mtls_ca
   ```

4. `docker compose up -d guardian` (or the full stack). Distribute a
   per-adapter client cert (`adapter-N-cert.pem` + `adapter-N-key.pem`) to
   each adapter out of band — these are not managed by OpenPalm compose.

### Rotation

Replace the relevant secret file(s) under `knowledge/secrets/`, then
`docker compose up -d guardian` to recreate the container (it reads the TLS
files once at boot) — the same "rotate both secret files, then recreate
services" model documented for portal principal secrets in core-principles.md
§ Addon secret lifecycle. Rotating the CA itself requires re-minting every
adapter client cert.

## 8. Known trade-off: the pre-auth per-IP limiter sees the passthrough's loopback address

`proxy.ts`'s Gate 0 pre-auth per-IP rate limiter (`proxy.ts:161`,
`allowPreAuth(clientIp)`) reads the connecting socket's remote address. In
mTLS mode, every request that reaches the loopback `Bun.serve` direct
handler arrives *from the passthrough*, so `clientIp` is `127.0.0.1` for
every mTLS-connected adapter, not the adapter's real LAN address — they
share one pre-auth bucket.

This is **accepted, not a regression**: the pre-auth limiter exists to bound
an *unauthenticated* flood before the body is read. In mTLS mode, an
unauthenticated peer cannot even complete a TLS handshake — the flood
surface that limiter guards is already gated by client-cert verification
before a single HTTP byte is parsed. The authenticated per-principal and
per-user rate limiters (`rate-limit.ts`) key off the Basic-auth principal,
not the IP, and are completely unaffected.

Forwarding the real client IP through the passthrough (e.g. the PROXY
protocol) is explicitly out of scope for this issue — revisit only if this
trade-off bites in practice (a single misbehaving mTLS-authenticated adapter
exhausting the shared pre-auth bucket for all other mTLS adapters).

## 9. Terminology note

The surface documented here is the **direct listener** (published on
`portal_net`, `OP_BIND_ADDRESS:${OP_GUARDIAN_PORT:-3830}`, internal port
3830). Issue #435's original text referenced a `channel_lan` network; that
name was removed from the codebase in #490 and is stale — nothing in this
design or its tests reintroduces it.
