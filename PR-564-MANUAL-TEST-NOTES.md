# PR #564 Manual Test Notes

Initial review: `review/pr-564` at `3825e005` on 2026-07-12.

Retest: current PR head `448c0bc8` on 2026-07-12. GitHub reported all six checks successful and merge state `CLEAN`. Manual release verdict remains **blocked** by the destructive unchanged-setup rerun defects below.

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

## Retest at `448c0bc8`

### Prior findings

| Initial finding | Retest result |
| --- | --- |
| P1-1 authenticated assistant healthcheck | Fixed. Both ASCII and UTF-8/trailing-space passwords made the assistant healthy; unauthenticated requests returned 401 and exact credentials returned 200. |
| P1-2 stale password after leaving `home-password` | Fixed. With the secret left non-empty, `OPENCODE_AUTH=false` returned unauthenticated health to 200 and the stack stayed healthy. |
| P2-1 unusable shared-guardian mDNS advertisement | Fixed for the normal stack-env path. Direct ingress off produced a 404 listener and `advertised:false`; direct ingress on opened the responder. See new precedence/status findings below. |
| P2-2 short pairing suffix | Partially fixed. Sixty-four generated principals were unique and used 16 hex characters, but insertion still upserts on the astronomically unlikely collision. |
| P3-1 undocumented pairing endpoint | Partially fixed. A section was added, but its status contract and collision guarantee are inaccurate/incomplete. |
| P3-2 quality checks | Improved. `git diff --check main...HEAD`, type checks, and production builds pass. Biome exits successfully with 12 warnings. |
| P3-3 parallel smoke port collision | Fixed. The portal target uses assistant port 3996 and ran while the stack target occupied 3896. |
| P3-4 clean-run smoke leak | Fixed. A normal portal run left zero project containers, networks, or volumes and removed its fixture. A keep-then-rerun failure remains below. |

### Expanded completed tests

| Scenario | Result |
| --- | --- |
| Source builds and default stack | Pass: rebuilt UI, client, assistant, guardian, and portal; baseline assistant/guardian stack became healthy with no root-owned fixture files. |
| `home-password` with ordinary credentials | Pass: assistant health, direct Basic auth, host `/api/host/health`, host assistant proxy, and guardian upstream forwarding worked. |
| `home-password` byte parity | Mixed: assistant and guardian accepted `päss 🔒 ` including the trailing space; host health reported OpenCode down and the host proxy returned 503. |
| Preset transition with stale secret | Pass: `home-password` to auth-off returned the assistant to unauthenticated healthy operation without clearing the secret file. |
| Built-in client auth | Failed with password only (`unauthorized`); passed when username `opencode` was explicitly supplied. |
| Unchanged setup rerun in real Chrome | Failed: stored portal credentials rendered as `[object Object]`; intercepted payload contained a newly generated UI login password and `[object Object]` portal secrets while the UI claimed the password was unchanged. The request was intercepted before persistence. |
| Removed-network update guard | Failed late: `checkCustomComposeChannelLan` returned the intended block error, but `applyUpdate` proceeded through managed asset reconciliation and failed only at Compose preflight. A fresh fixture confirmed current compose content is restored after failure. |
| Shared-guardian runtime/discovery precedence | Failed: process env could make Compose resolve `GUARDIAN_DIRECT_INGRESS=true` while host UI/mDNS continued to report it false from `stack.env`. |
| IPv6 mDNS status | Failed: an IPv6 bind returned guardian `advertised:true` while `resolveMdnsAdvertisements` returned no advertisement. |
| Pairing load/error contract | Pass behavior: 64/64 unique IDs, 16-hex suffixes, non-null QR; no session 401, hostile origin 403, malformed JSON 400, oversized body 413, 65-character label 400. Documentation does not match all of these. |
| Rootless portal clean run | Pass: source-built stack ran alongside the retained baseline stack and cleanup removed all project resources. |
| Rootless portal keep then rerun | Failed: profile-gated guardian/Discord containers survived pre-run cleanup; the rerun reused them, Discord restarted repeatedly, and the smoke failed. Final trap cleanup removed all resources. |
| mTLS/MCP/upstream-auth/mDNS/pairing targeted tests | Pass: 77 tests. |
| Client pairing/runtime/remote-attach/CORS tests | Pass: 29 tests. |
| UI unit suite | 1,316 tests passed; command failed only when the Vitest browser project could not find Playwright's pinned Chromium. Manual Chrome 150 testing covered the rerun flow. |
| Aggregate non-UI suite | 2,081 passed, 10 skipped, 6 failed: the same three unreachable-upstream policy timeouts and three assistant supervisor timing failures as the initial run. |

### Current P1 blockers

#### P1-1: Unchanged setup rerun silently rotates the UI login password

Rerun initialization generates a new password (`packages/ui/src/lib/setup/setup-state.svelte.ts:1201-1208`), while current config returns only `hasPassword` (`packages/ui/src/routes/api/setup/current-config/+server.ts:118-123`). The review UI says “Previously set — not changed” (`ReviewStep.svelte:178-185`), but every payload includes the generated value (`packages/ui/src/lib/setup/payload.ts:152-156`) and setup writes it (`packages/lib/src/control-plane/setup.ts:348`). The intercepted unchanged-rerun payload contained a new random password that was never shown to the operator. Submitting it would lock the operator out after the existing session expires.

#### P1-2: Unchanged setup rerun corrupts Discord and Slack credentials

Current config correctly returns secret-presence metadata rather than plaintext (`current-config/+server.ts:89-116`), but rerun state assigns those objects directly into credential fields (`setup-state.svelte.ts:1239-1246`). Payload serialization converts them to `[object Object]` (`payload.ts:134-149`), and `persistPortalCredentials` writes supplied values (`setup.ts:262-276`). Real Chrome displayed `[object Object]` in the fields and sent those exact strings in the intercepted update payload.

### Current P2 findings

#### P2-1: Host UI auth changes valid password bytes

The host endpoint resolver trims the file-backed password (`packages/ui/src/lib/server/endpoints.ts:286-292`), while assistant and guardian preserve surrounding spaces. Host forwarders also use Latin-1-only `btoa` (`opencode/http.ts:16-20`, `api/host/health/+server.ts:27-31`, and `proxy/assistant/[...path]/+server.ts:32-40`). A UTF-8 password with a trailing space worked directly and through guardian, but host health returned `opencode:false` and the host proxy returned 503. Ordinary ASCII credentials passed.

#### P2-2: Built-in client defaults to the wrong OpenCode username

`packages/client/src/lib/transport/index.ts:229-233` defaults Basic auth to `openpalm`; shipped OpenCode defaults to `opencode`. Against the live authenticated assistant, a password-only client probe returned `unauthorized`, while the same password with explicit username `opencode` returned `accessible`.

#### P2-3: Update does not fail before writes for a removed `channel_lan`

The deprecation guard blocks only `install` and `upgrade` (`packages/lib/src/control-plane/lifecycle.ts:237-255`), but `update` still calls `applyHome` before Compose preflight (`lifecycle.ts:257-265`, `83-123`). The isolated update logged managed-tree reconciliation and then failed with the undefined-network error. The user gets a late update failure instead of the intended pre-write migration instruction.

#### P2-4: mDNS can disagree with effective Compose configuration

`reconcileMdnsResponder` uses persisted `stack.env` for the direct-ingress gate, while Compose permits process-environment overrides. With `GUARDIAN_DIRECT_INGRESS=false` in the file and `true` in the host process, Compose resolved true while `/api/host/stack` and mDNS reported false. Conversely, an advertised endpoint can be disabled by the effective Compose environment.

#### P2-5: mDNS status can claim an advertisement that was dropped

`resolveMdnsStatus` reports the bind gate only (`packages/lib/src/control-plane/mdns-responder.ts:213-232`), while IPv6/hostname binds are filtered from A records (`mdns-responder.ts:159-166`). The live function result for `2001:db8::10` was `advertised:true` with an empty advertisements list.

#### P2-6: Preset host-environment validation omits managed keys

`validateNetworkPresetEnv` checks only `OP_ASSISTANT_BIND_ADDRESS` and `OP_BIND_ADDRESS` (`packages/lib/src/control-plane/network-preset.ts:238-259`). It returned `valid:true` for conflicting `OP_CLIENT_BIND_ADDRESS`, `OP_VOICE_BIND_ADDRESS`, and `OPENCODE_AUTH` values. Manual Compose users can therefore override parts of the selected preset.

#### P2-7: Rootless smoke pre-run cleanup is profile-unaware

Final cleanup enables profiles (`scripts/rootless-ownership-smoke.sh:99-108`), but pre-run cleanup uses plain `down` (`rootless-ownership-smoke.sh:112-116`). A retained portal fixture followed by a normal rerun reused old profile containers and failed with Discord restarting.

#### P2-8: mTLS relay protection is per connection, not aggregate

The 8 MiB queue cap is per direction and connection (`packages/guardian/src/tls-passthrough.ts:30,108-125`). There is no aggregate queue or concurrent-connection cap, so many authenticated slow readers can still consume unbounded aggregate guardian memory. The targeted flow-control tests pass but do not cover this multi-connection limit.

#### P2-9: Recovered mTLS client IP is not included in audit records

The passthrough maps the verified client IP and the proxy uses it for pre-auth limiting, but success audit calls omit it (`packages/guardian/src/proxy.ts:443,671`). This conflicts with the changelog claim that audit source IPs are accurate.

### Current P3 findings

- Pairing IDs are now collision-resistant but not collision-safe: guardian admin still upserts the principal. `docs/technical/api-spec.md:898-899` should not promise that re-pairing “never overwrites” without create-only insertion or conflict/retry.
- Pairing API docs say a missing session is 403, but the observed response is 401. They omit observed `400 invalid_json`, `413 too_large`, and `403 forbidden_origin` responses (`docs/technical/api-spec.md:906-912`).
- The server and spec allow `qrSvg: null`, but `packages/ui/src/lib/api/endpoints.ts:71-76` and `routes/connections/+page.svelte:53-55` type/state it as a string.
- Bare `openpalm` probes authenticated OpenCode without Basic auth (`packages/cli/src/main.ts:23-30`), so a healthy `home-password` assistant is classified as down and the CLI unnecessarily enters its stack-start path.
- The mDNS parser retains the QU bit, but response routing only considers source port 5353 (`mdns-responder.ts:538-548`); QU requests from port 5353 receive multicast rather than the requested unicast response.

### Remaining limitations

- A live legacy-unicast mDNS query was not received because UDP 5353 is shared by KDE Connect, Chrome, and the test responder. Socket activation and pure packet tests passed.
- Aggregate mTLS memory exhaustion, handshake-timeout boundary races, and a real MCP call through an mTLS-enabled guardian were identified as residual risks but not load-tested end to end.
- The long-lived main fixture's managed portal compose became stale during destructive lifecycle experiments and made its final guardian unhealthy. A fresh isolated lifecycle reproduction preserved the current file correctly, so this was treated as fixture contamination rather than a reproducible product defect.
