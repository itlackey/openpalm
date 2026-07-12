# PR #564 Manual Test Notes

Reviewed branch: `review/pr-564` at `3825e005` on 2026-07-12.

## Environment

- Docker 29.1.3, Docker Compose 2.40.3, Bun 1.3.14.
- Source-built `openpalm/assistant:dev`, `openpalm/guardian:dev`, and `openpalm/portal:dev` images.
- Isolated Docker projects and OP_HOME trees were used. No production stack or existing `.dev` state was used.
- Host browser: Google Chrome 150 headless. Playwright's pinned Chromium cannot install on Ubuntu 26.04 in this environment.

## Completed Tests

| Scenario | Method | Result |
| --- | --- | --- |
| Build and baseline boot | `rootless-ownership-smoke.sh stack` with source-built assistant and guardian | Pass: healthy containers and no root-owned OP_HOME files. |
| Portal boot and ownership | `rootless-ownership-smoke.sh portal-discord` on an isolated assistant port | Pass: assistant, guardian, and Discord portal booted; ownership check passed. |
| Type and production builds | `bun run check`, `bun run client:build`, UI build during both smoke runs | Pass. |
| Host UI runtime | Started `openpalm admin` against isolated OP_HOME; checked `/api/runtime` and capability metadata | Pass: loopback-only host UI, expected capabilities and client URL. |
| Host UI auth | Wrong and correct password login; protected host stack and connections endpoints | Pass: wrong login 401, host APIs require session, correct login succeeds. |
| Pairing flow | `POST /api/connections/pairing`, malformed request, and principal enumeration | Pass with expected warning when direct ingress is off. Pairing code was returned once and principal listings did not expose tokens. |
| Direct guardian ingress | Disabled and enabled modes, wrong/correct Basic credentials, CORS preflight and allowed/disallowed origins | Pass for expected auth/CORS behavior. |
| Principal rotation | Reposted the same direct-principal ID with a replacement token | Existing token immediately became 401 and replacement became 200. This confirms the pairing-collision impact below. |
| Guardian internal protection | `/stats` with and without admin bearer credential | Pass: unauthenticated 401, authenticated 200. |
| Network preset authentication | Applied actual PR managed compose assets, set home-password vars and secret, then recreated stack | Failed: OpenCode Basic auth works, but assistant healthcheck is unauthorized and guardian cannot deploy. See P1-1. |
| Preset transition | Disabled `OPENCODE_AUTH` after setting a password secret, then recreated stack | Failed: stale password still enables Basic auth and makes healthcheck fail. See P1-2. |
| Shared guardian discovery | Applied shared-guardian env row; confirmed UI reports guardian mDNS advertised while direct ingress is disabled | Failed/misaligned: advertised port returns 404 for `/` and `/oc/*`. See P2-1. |
| mTLS, guardian state, upstream auth | Targeted guardian TLS, passthrough, WAL, and upstream-auth tests | Pass: 27 tests. |
| Client remote attach | Pairing, URL policy, runtime handshake, remote attach, CORS tests | Pass: 37 tests. |

## Issues

### P1-1: Home-password cannot become healthy

`packages/skeleton/system/stack/core.compose.yml:172` probes OpenCode's `/health` without Basic credentials. With the advertised `home-password` preset, OpenCode correctly returns 401 to that probe. The assistant remains unhealthy and guardian is blocked by its `depends_on: assistant: service_healthy` condition. The feature's primary hardened-LAN path cannot deploy.

### P1-2: Leaving home-password leaves Basic auth enabled

`containers/assistant/entrypoint.sh:151-155` imports a non-empty password file even when `OPENCODE_AUTH=false`. OpenCode enables Basic auth from that password, so switching from home-password to any non-password preset leaves `/health` protected while the healthcheck is unauthenticated. The stack remains unhealthy until the secret is manually emptied.

### P2-1: Shared-guardian mDNS advertises an unusable listener

`packages/lib/src/control-plane/mdns-responder.ts:107-110` advertises guardian port 3830 whenever `OP_BIND_ADDRESS` is LAN-visible, without considering `GUARDIAN_DIRECT_INGRESS`. The shared-guardian preset leaves direct ingress off. The UI reported `openpalm-guardian.local:3930` advertised, but that listener returned 404 for `/` and `/oc/session`.

### P2-2: Pairing principal IDs can overwrite another device

`packages/lib/src/control-plane/pairing.ts:172` uses only four random hex characters for a device ID suffix. A collision reaches `upsertPrincipal` (`packages/guardian/src/state-db.ts:174-185`), which intentionally replaces the token for that ID. The manual principal-rotation check reproduced the destructive effect. Use a collision-resistant ID and/or reject/retry on conflict.

### P3-1: Pairing mutation is missing from the API specification

`packages/ui/src/routes/api/connections/pairing/+server.ts` creates a direct guardian principal but is absent from `docs/technical/api-spec.md`. Its host-stack capability, session/origin requirement, request/response, warnings, and failure contract need documenting.

### P3-2: PR quality checks are not clean

`git diff --check main...HEAD` reports trailing whitespace and EOF blank-line violations in new roadmap files. `bun run lint` reports new warnings in `packages/client/tests/transport-health-insecure.test.ts` in addition to existing warnings elsewhere in the repository.

### P3-3: Default parallel smoke ports collide

The `stack` and `portal-discord` rootless smoke defaults both use assistant port 3896. Starting both isolated projects concurrently causes Docker bind failure. The portal smoke passes with `OP_ROOTLESS_SMOKE_ASSISTANT_PORT=3996`.

### P3-4: Successful portal smoke leaks containers

After a successful `rootless-ownership-smoke.sh portal-discord` run, its cleanup removed the isolated OP_HOME but left the `openpalm-pr564-portal-guardian-1` and `openpalm-pr564-portal-discord-1` containers running. This makes later test runs and local development stateful despite the fixture's isolation/cleanup contract.

## Verification Gaps

- `bun run test` does not pass: three pre-existing guardian policy tests time out against their default unreachable upstream, and three pre-existing assistant supervisor tests have a process-cleanup race. The PR only adds unrelated password tests to the latter file.
- `bun run ui:test:unit` executed 1,309 tests successfully, then failed its browser-project phase because Playwright 1.58 does not provide Chromium for Ubuntu 26.04. Manual headless Chrome client loading was completed instead.
- Live mDNS response capture was inconclusive because other host processes already own multicast UDP 5353. The PR responder was listening, and the advertised-port behavior was verified through the host UI and guardian listener directly.
