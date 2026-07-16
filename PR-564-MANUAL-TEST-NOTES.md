# PR #564 Manual Test Notes

Initial review: `review/pr-564` at `3825e005` on 2026-07-12.

Retest: PR head `448c0bc8` on 2026-07-12. GitHub reported all six checks successful and merge state `CLEAN`. Manual release verdict remained **blocked** by the destructive unchanged-setup rerun defects below.

Second retest: PR head `524d010f` on 2026-07-13. GitHub again reported all six checks successful and merge state `CLEAN`. The prior password and portal-secret rerun corruption is fixed, but the manual release verdict remains **blocked** by newly reproduced security-posture, setup-idempotency, mTLS availability, and mutation-ordering defects.

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

## Second Retest at `524d010f`

### Completion criteria

| Criterion | Result |
| --- | --- |
| Password byte parity across assistant, guardian, host proxy/health, and client | Pass. `päss 🔒 `, including the trailing space, worked on all four paths; a trimmed neighbor failed. |
| Explicit UI-password change invalidates old credentials | Fail. Setup wrote the new password to disk, but the live server still accepted only the inherited old password (`old=200`, `new=401`). |
| Auth-off transition with a stale password file | Pass. The assistant stayed healthy and unauthenticated with `OPENCODE_AUTH=false`. |
| Password-only direct client defaults to `opencode` | Pass against the source-built authenticated assistant. |
| `channel_lan` guard before writes | Partial. Full `applyUpdate` rejected before changing five hashed artifacts. A scoped UI update wrote its target version before returning 502, and setup persisted password/version changes before background deploy rejection. |
| mDNS direct-ingress/status/effective-env fixes | Partial. Normal direct-ingress gating and IPv6 status are fixed. Mixed QU/QM routing and asynchronous socket-error status are not. |
| mTLS aggregate flow-control bound | Fail. The aggregate budget exists, but an overflowed slow client retains its queue and active slot; normal blocked drain also has no deadline. |
| Audit IP provenance | Pass for direct guardian traffic. Spoofed `X-Forwarded-For` and `X-Real-IP` were ignored; success and failure audit rows used the socket-derived bridge peer. |
| Pairing create-only collision behavior and QR fallback | Pass for the advertised cases. Concurrent same-ID creates returned 200/409 and only the winner token authenticated; nullable QR client typing and manual-code fallback are present. |
| Pairing/API status documentation | Fail. Hook-generated invalid-Host and forbidden-Origin bodies omit `requestId`, contrary to the pairing contract; additional route/documentation drift remains below. |
| Rootless smoke cleanup and rerun isolation | Partial. Clean stack/portal runs and keep-then-rerun passed. Missing-env fallback reused retained networks/volumes, and an OP_HOME basename containing spaces survived the pre-run removal path. |
| Quality and aggregate tests | Partial. Type checks, builds, diff check, shell syntax, lint, and focused tests passed. Aggregate suites retain six local failures and the Vitest browser executable is unavailable. |

### Expanded completed tests

| Scenario | Result |
| --- | --- |
| Source-backed stack and auth parity | Pass: source assistant/guardian became healthy; direct, guardian, host, and client auth agreed byte-for-byte. |
| Real-Chrome unchanged rerun secret preservation | Pass for the prior blocker: payload sent `security:{}`, omitted portal credentials, preserved UI/Discord/Slack hashes, and retained the old UI password. |
| Real-Chrome unchanged rerun state preservation | Fail: a current `dev` install submitted `imageTag:"latest"` and `addons:{api:true}`; an actual run rewrote all four component versions and unexpectedly pulled registry images. |
| Ambient credential isolation | Fail: omitted UI/OpenCode/Discord/Slack values were replaced by same-named host process variables before keep-existing logic ran. |
| Explicit rotation and clearing | Fail: UI password disk/runtime diverged; an explicit empty Discord token left the existing token unchanged. |
| Setup failure atomicity | Fail: a fresh setup that rejected a missing UI password still persisted the submitted Discord token. With a live install lock, setup returned `install_in_progress` after generating five system secret files. |
| Addon/profile rerun behavior | Fail: `{discord:false}` left Discord enabled; disabling voice retained `OP_VOICE_PROFILE`, kept the profile active, and the next migration re-enabled voice. The setup profile endpoint also returned `null` for a persisted ROCm profile because it passed `stackDir` instead of OP_HOME. |
| Managed Compose environment parity | Fail: preflight resolved persisted `OPENCODE_AUTH=true`, while the streaming CLI execution inherited host `OPENCODE_AUTH=false`; the LAN-bound assistant then returned 200 without credentials. |
| Full and scoped removed-network paths | Mixed: full update was byte-for-byte non-mutating; scoped update changed `OP_ASSISTANT_VERSION` before failing the same preflight. |
| mTLS lifecycle fault injection | Fail: a 2 KiB aggregate overflow retained one active connection and 2 KiB queued; a second valid connection was rejected at the one-connection cap. |
| mDNS packet/lifecycle fault injection | Fail: unmatched QU plus matched QM sent QM by unicast; socket error left `advertised:true` with no close; a 30,026-byte duplicate-question query built a 150,012-byte answer; QCLASS=CHAOS received an IN answer. |
| Pairing and principal concurrency | Mixed: create-only race passed; JSON `null` returned unstructured 500; unknown principal kind silently became `portal`; ID `phone:one` was accepted but could not authenticate. |
| Guardian admin-token rotation | Fail: replacing a cached token file left token A valid and token B rejected until restart. |
| Pairing URL validation | Fail: `https://gw.example?tenant=home` was accepted and normalized to `https://gw.example/oc?tenant=home`; appending `/session` produced `...?tenant=home/session`. |
| Host/Origin failure contracts | Fail: invalid Host and forbidden Origin returned hook-local JSON without `requestId`; ordinary unauthorized route failures included one. |
| Rootless smoke clean/keep/rerun | Pass for stack and portal targets, including profile-gated teardown and post-run zero resources. |
| Rootless smoke fallback cleanup | Fail: after deleting the retained fixture's `stack.env`, pre-run cleanup removed three containers but reused two networks and four volumes on the next run. |
| Rootless smoke unusual path | Fail: with `OP_ROOTLESS_SMOKE_HOME='.rootless smoke space'`, a marker survived pre-run cleanup, demonstrating unsafe basename interpolation in the privileged removal command. |
| Bare CLI unrelated listener | Fail closed-identity expectation: an arbitrary localhost HTTP server returning 401 was accepted as a healthy assistant. |
| Client build | Pass. |
| UI unit suite | 1,337 server tests passed; the command failed only because Vitest's Playwright provider could not find its pinned Chromium. Real Chrome 150 manual flows passed where noted. |
| Aggregate non-UI suite | 2,128 passed, 10 skipped, 6 failed. Three policy tests pass when `OP_ASSISTANT_URL` is explicitly made unreachable; they otherwise wait on the ambient default upstream. Three supervisor tests expose host `date +%s%3N` incompatibility with uutils coreutils; the Debian assistant image emits the expected 13-digit millisecond value. |

### Current release blockers

#### P1-1: Managed preflight and execution use different environments

`runComposeWithPreflight` validates with env-file overrides but the streaming execution path in `packages/cli/src/lib/cli-compose.ts` inherits raw process environment. Captured Compose wrappers have the same mismatch. With persisted LAN/home-password settings and ambient `OPENCODE_AUTH=false`, preflight passed the authenticated configuration while the real assistant started unauthenticated on `0.0.0.0`.

#### P1-2: Unchanged setup reruns are not state-idempotent

The fixed password/portal omission path still does not hydrate current image versions or addon selection. Real Chrome submitted `imageTag:"latest"` and the locked API addon even when the current installation used source `dev` images and no API addon. The actual rerun rewrote `OP_ASSISTANT_VERSION`, `OP_GUARDIAN_VERSION`, `OP_PORTAL_VERSION`, and `OP_VOICE_VERSION`, then pulled unrelated registry images. Omitted `hostAkm` is also interpreted as enabled, so an explicitly disabled host stash reappears.

#### P1-3: Setup consumes ambient secrets as operator input

`performSetup` initializes state from process environment before applying keep-existing semantics. A setup payload with no credential values replaced existing UI, OpenCode, Discord, and Slack secret files from ambient variables. This makes unchanged-rerun behavior depend on how the host UI process was launched and can silently rotate access credentials.

#### P1-4: UI password rotation does not update the running auth authority

An authenticated setup call wrote `rotated-ui-password` to `knowledge/secrets/op_ui_login_password`, but the running host UI continued to authenticate only `rootless-smoke-password` from its inherited environment. The response reported success. The new disk credential cannot log in until restart, while existing/old credentials remain valid.

#### P1-5: mTLS backpressure failures retain capacity indefinitely

The aggregate budget rejects overflow, but the upstream-to-client overflow path does not destroy the slow client or remove its queued chunks. In a one-slot/1 KiB injected budget, a 2 KiB upstream write left `activeConnections=1` and `aggregateQueuedBytes=2048`; a second client was rejected. Separately, a finite sub-limit response whose client never drains has no deadline. Authenticated idle connections also have no post-handshake lifetime bound.

#### P1-6: Setup and update mutation boundaries remain incomplete

Full `applyUpdate` now performs the removed-network check before writes, but scoped updates advance version state first and setup persists configuration before asynchronous deploy validation. Setup itself is not transactional: rejected fresh setup left a submitted portal token, and lock rejection occurred only after system-secret generation. Explicit false addons are additive-only, so reruns cannot reliably disable Discord, voice, or Ollama.

#### P1-7: Pairing codes in `?pair=` disclose durable credentials to the HTTP request path

The pairing payload contains the live guardian principal token. The documented client handoff uses `/connections?pair=<code>` and strips it only in `onMount`, after the initial request has reached the static host. Access logs, browser history, reverse proxies, and referrers can therefore retain the credential despite documentation claiming it is never logged.

**Resolved (branch `claude/friendly-fermat-ukr9v1`):** the deep link now rides in the URL **fragment** (`/connections#pair=<code>`), which the browser never transmits to the server. The consumer reads the code from `window.location.hash` and strips the fragment via `replaceState`, so the durable credential no longer reaches access logs, reverse proxies, or `Referer` headers. `docs/managing-openpalm.md` and the #511 CHANGELOG entry were updated to match, and a regression test asserts the page no longer reads a `?pair=` query param.

### Additional P2 findings

- mDNS is vulnerable to response/allocation amplification: duplicate questions are not capped or deduplicated, non-IN classes are answered, direct legacy queries are accepted on the all-interface UDP socket, and repeated QM packets have no multicast suppression.
- mDNS status remains stale after asynchronous socket errors, while direct file edits can change reported desired status without reconciling the active responder. Graceful host-UI shutdown has no production hook to send goodbyes.
- Mixed QU/QM packets choose unicast if any matched or unmatched question has QU, rather than routing each matched response correctly.
- Guardian admin-token reads are cached solely by path. Rotating file contents does not revoke the old token and makes host pairing use a new token the live guardian rejects.
- Pairing JSON `null` reaches `body.label` and becomes a generic 500. Pairing fetch has no timeout against a listener that accepts but never responds.
- Guardian admin creation accepts malformed kinds and IDs. Unknown kinds become portals; IDs containing `:` cannot round-trip through Basic-auth parsing.
- Guardian URLs with query/fragment components pass server validation but break client route concatenation.
- Setup's voice/Ollama profile endpoints call `getAddonProfileSelection(state.stackDir, ...)` instead of passing `state.homeDir`, so persisted hardware profiles are not restored.
- Moving tags are recreated with `--pull missing`; an already-present `latest` image is not refreshed, so resetting reruns to `latest` can both unexpectedly change policy and later strand the old digest.
- The headless file-install path calls `runDeploy` without its setup-completion callback. A healthy non-interactive install can therefore omit `OP_SETUP_COMPLETE=true` and return to the wizard later.
- Full setup deploy calls Compose down before the risky pull/health-gated up. A failed replacement can remove a previously healthy stack rather than leaving it available.

### Additional P3 findings

- Pairing docs promise every error body has `requestId`; global Host/Origin rejections do not use the route response helper.
- The documented principal-rotation curl still reposts to the now-create-only collection endpoint and returns 409; it should use `/admin/principals/:id/rotate`.
- API docs list `/guardian/stats` with host-session auth, while the implemented guardian route is `/stats` with guardian-admin Bearer auth.
- Client UI placeholder/completion docs still suggest username `openpalm`, contradicting the fixed `opencode` password-only default.
- Rootless fallback cleanup removes only containers when fixture files are missing; labeled networks and volumes survive into the next run. Its privileged basename interpolation is unsafe for spaces.
- The assistant supervisor tests assume GNU `date` honors `%3N`; Ubuntu 26.04's uutils `date` emitted nanoseconds, causing every fast crash to look healthy and the local behavioral test loop not to terminate. The source-built Debian runtime used milliseconds and was not affected.

### Final verdict

**Blocked.** The fixes at `524d010f` resolve the previous destructive password/portal rerun corruption and several posted completion criteria, but the expanded cycle found reproducible security and lifecycle failures: effective Compose execution can disable authentication after a passing preflight; unchanged reruns reset image/addon/AKM state; ambient secrets silently replace preserved credentials; explicit UI rotation leaves old runtime auth active; mTLS overflow retains the connection cap; and setup/update paths still mutate before their full rejection boundary.
