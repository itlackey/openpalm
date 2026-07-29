# OpenPalm Architecture: One UI

> Authoritative overview of the 0.13.0 app/UI topology. See
> [`core-principles.md`](./core-principles.md) for filesystem and security
> invariants.

## Runtime Topology

```text
CLI or admin-capable host UI -> Docker Compose on the host

Browser -> OpenPalm UI -> same-origin /oc -> Assistant OpenCode
External portal -> Guardian /oc -> Assistant OpenCode
Remote connection -> exact OpenCode or Guardian URL
```

- The assistant is the one always-on core container. It runs OpenCode, the
  non-admin UI child, BusyBox cron, and AKM-backed assistant tools. It has no
  Docker socket, admin credential, or path to the admin process.
- Guardian is profile-gated ingress, not a core container. It authenticates
  principals and enforces ownership, rate, event-filtering, and moderation
  policy before transparently forwarding native OpenCode traffic.
- Admin capability exists only in Electron and `openpalm admin`, both host
  processes. They invoke Docker Compose through the host socket. There is no
  admin container or socket-proxy path.

## One UI

There is one front-end package, `@openpalm/ui` (SvelteKit with adapter-node).
The same build is:

- baked into the assistant image and served as a non-admin child
- installed under `OP_HOME/data/ui` for host-process serving
- loaded by the thin Electron harness
- installable as a PWA from a serving origin

There is no second client app or UI runtime-mode matrix. Server capabilities
vary by launch boundary; the browser application and connection model do not.

## Browser-Owned Connections

The browser owns its connection list in IndexedDB. A connection supplies the
exact base URL; Guardian paths are not inferred.

- The default local connection is root-relative `/oc`. It reaches the UI
  process's authenticated same-origin transparent pass-through, which then
  calls local OpenCode and attaches upstream Basic auth if needed.
- User-added remote OpenCode or Guardian connections are browser-direct and use
  their own per-connection credentials.
- Cross-origin requests omit the OpenPalm session cookie. Same-origin `/oc`
  requests include it because the UI session is the local credential.
- Stored Basic passwords use WebCrypto AES-GCM when the browser origin provides
  SubtleCrypto. On a non-secure http origin (the plain-HTTP LAN tier),
  SubtleCrypto is unavailable by platform rule, so credentials degrade to
  plaintext-at-rest there rather than refusing to save.

One transport implementation, session model, and SSE parser serve both local
and remote connection forms.

## Guardian

Guardian is a transparent 1:1 OpenCode reverse proxy. It preserves method,
path, query, body, response, and SSE framing while stripping hop-by-hop and
inbound credential headers.

Its policy overlays include:

- constant-time-verified HTTP Basic principal authentication
- SQLite-persisted session and permission ownership
- tenant-filtered `/event` streaming
- rate/resource limits
- content validation on prompt-bearing writes

`GUARDIAN_CONTENT_VALIDATION` defaults on in both package code and shipped
Compose. Explicit `0`, `false`, `no`, or `off` disables it. Suspicious input is
escalated to Guardian's loopback OpenCode moderator; a moderator failure or
unusable verdict blocks the escalated request.

Guardian also owns the one OpenAI/Anthropic-compatible listener at container
port `8182`, published on host port `3821` by default. Chat and API are not
separate listeners.

## Secret Topology

- Provider `knowledge/secrets/auth.json` remains in the assistant-readable AKM
  tree and is delivered to Guardian as one Compose secret.
- Delegated UI, OpenCode server, Guardian, API, portal, and bot credentials live
  under `private/secrets/`.
- `private/` is never mounted into assistant `/stash`; services receive only
  the named files they consume.
- `knowledge/env/user.env` is loaded by scoped tools on demand, not sourced by
  the assistant entrypoint.

## Admin Boundary

Admin is a launch capability, not a client-side UI mode. A process is
admin-capable only when launched by Electron or `openpalm admin`. A container,
PWA, or ordinary `openpalm app` launch cannot self-grant host capabilities.

| Surface | How the UI runs | Admin capability |
|---|---|---|
| Assistant container | Image-baked adapter-node child on port `3000` | No |
| Electron | Thin native harness starts the host build | Yes |
| `openpalm admin` | Host process | Yes |
| `openpalm app` | Host process | No |
| PWA | Installed from a non-admin serving origin | No |

Electron and `openpalm admin` remain loopback-only. A non-admin `openpalm app`
can be explicitly exposed only after local setup and should sit behind
operator-managed HTTPS.

## Development Ports

- `npm run dev` in `packages/ui`: `5173`
- root `bun run ui:dev:isolated`: `3880`
- installed host UI: `3880`
- assistant-served UI: host `3800` -> container `3000`
- assistant OpenCode: host `3810` -> container `4096`
