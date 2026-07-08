# Unit=All RC Checklist

Operator worksheet for a coordinated `unit=all` release candidate. Use this when
the release contains foundational churn across packaging, deployment,
permissions, runtime artifact resolution, and install/upgrade behavior.

This checklist is intentionally stricter than the workflow preflight. The goal
is to prove that the release works as shipped across the major runtime surfaces,
not just that the source tree is green.

---

## Scope

`unit=all` publishes all coordinated release artifacts at one version:

- npm: `@openpalm/{lib,ui,client,guardian,skeleton}`, `openpalm`, `@openpalm/{discord,slack}-portal`
- Docker: `openpalm/{assistant,guardian,portal}`
- Electron installers
- CLI binaries
- Git tags and GitHub release metadata

It does **not** build the voice image.

---

## Evidence

For every checklist item, capture:

- command run
- exit code
- key output or log excerpt
- screenshot for browser/Electron/installability checks
- pass/fail note and any follow-up issue

If a step is skipped, record the reason explicitly.

---

## Setup

Set shared variables once:

```bash
export RC_VERSION="0.12.53-rc.1"
export REPO="$PWD"
export VERIFY_ROOT="$REPO/.tmp-openpalm-rc"
export VERIFY_HOME="$VERIFY_ROOT/home"
export VERIFY_PROJECT="openpalm-rc"
```

Important artifact note:

- pre-publish checks validate source, local builds, and release orchestration
- post-publish checks validate the actual published npm packages, container images, installers, and tags
- if there is no private staging registry, the public RC is the first true shipped-artifact test for guardian, skeleton, client, UI, CLI, and images

---

## Exit Criteria

Do not publish or announce the RC unless every required item below is marked
pass or has an explicit, reviewed waiver.

- [ ] `unit=all` workflow dry run passed for the exact RC version
- [ ] local preflight parity passed
- [ ] fresh install passed
- [ ] upgrade test passed
- [ ] failure/rollback test passed
- [ ] assistant/client isolated runtime test passed
- [ ] guardian direct-ingress/auth/CORS test passed
- [ ] browser-backed live stack test passed
- [ ] host UI smoke passed
- [ ] PWA smoke passed
- [ ] at least one real credentialed ingress path passed
- [ ] security-boundary verification passed
- [ ] rootless/ownership verification passed
- [ ] CLI binary smoke passed
- [ ] Electron installer smoke passed
- [ ] post-publish npm verification passed
- [ ] post-publish Docker verification passed
- [ ] post-publish GitHub tag/release verification passed
- [ ] post-publish shipped-artifact boot test passed

---

## 1. Release Orchestrator Dry Run

- [ ] Run the real release workflow for the exact RC version.

```bash
gh workflow run release.yml -f unit=all -f version="$RC_VERSION" -f dry_run=true
```

Pass criteria:

- [ ] the run starts successfully
- [ ] the computed version matches `RC_VERSION`
- [ ] no npm regression guard failure appears
- [ ] expected `unit=all` jobs are present: platform npm, portal npm, assistant image, guardian image, portal image, Electron, CLI binaries, tags/release staging
- [ ] no unexpected job skip appears

Evidence:

- workflow URL
- screenshots or copied logs for compute-version, regression guard, preflight, and dry-run preview

---

## 2. Local Preflight Parity

- [ ] Run the local equivalent of the release preflight.

```bash
bun install --frozen-lockfile
bun run client:build
bun run test
bun run ui:check
bun run ui-kit:check
bun run client:check
bun run --cwd packages/ui test:browsers
bun run ui:test:unit
bun run electron:test
bun run guardian:test
bun run cli:test
```

Pass criteria:

- [ ] every command exits 0
- [ ] any warning is understood and non-blocking
- [ ] no test was skipped unexpectedly

---

## 3. Fresh Install From Empty OP_HOME

- [ ] Test the supported install path against a brand-new `OP_HOME`.
- [ ] Use isolated ports and project name.

Pass criteria:

- [ ] install seeds `system/stack/{core,services,portals}.compose.yml`
- [ ] install seeds `config/stack/custom.compose.yml`
- [ ] install creates expected `knowledge/`, `data/`, and `workspace/` trees
- [ ] assistant boots successfully
- [ ] host UI is reachable
- [ ] no manual repair is needed

Evidence:

- resulting directory tree summary
- health output
- screenshot of first successful UI load

---

## 4. Upgrade Existing OP_HOME

- [ ] Test against a realistic pre-existing install.
- [ ] Prefer a real preserved fixture over a synthetic minimal tree.

Pass criteria:

- [ ] existing user-owned files in `config/` survive untouched unless explicitly intended
- [ ] managed `system/` files update correctly
- [ ] addon activation state still resolves correctly
- [ ] `knowledge/secrets/auth.json`, tasks, AKM data, and workspace remain intact
- [ ] upgraded stack boots cleanly

Evidence:

- before/after file diff summary for `config/`, `system/`, and `state/`
- health output after upgrade

---

## 5. Failure And Rollback Test

- [ ] Induce a controlled deployment failure.
- [ ] Good options: missing required secret, bad image tag, invalid compose substitution.

Pass criteria:

- [ ] apply fails closed
- [ ] previous known-good configuration remains recoverable
- [ ] rollback snapshot behavior matches the documented contract
- [ ] no user-owned config is clobbered during the failed attempt

Evidence:

- failing command
- failure output
- rollback snapshot path
- post-failure stack status

---

## 6. Assistant And Client Isolated Runtime Test

- [ ] Run the isolated compose flow from `manual-compose-runbook.md`.
- [ ] Build and pack a local client tarball.
- [ ] Boot assistant with `OP_CLIENT_VERSION=file:/stash/...`.

Verify:

```bash
curl -fsS http://127.0.0.1:4820/health
curl -sS -o /dev/null -D - -X HEAD http://127.0.0.1:3840/
curl -fsS http://127.0.0.1:3840/connections/new | grep '<!doctype html>'
curl -fsS -D - http://127.0.0.1:3840/runtime-config.json
```

Pass criteria:

- [ ] assistant health returns 200
- [ ] client `HEAD /` succeeds
- [ ] SPA fallback serves the app shell
- [ ] `runtime-config.json` is `cache-control: no-store`
- [ ] the locked default connection points at the host-published assistant URL

---

## 7. Guardian Direct Ingress, Auth, And CORS

- [ ] Boot guardian in the isolated stack with direct ingress enabled.

Verify:

```bash
curl -fsS http://127.0.0.1:9190/health
curl -i -sS -X OPTIONS http://127.0.0.1:9190/oc/session \
  -H 'Origin: http://127.0.0.1:3840' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization, content-type, x-openpalm-user'
```

- [ ] Re-run with `GUARDIAN_DIRECT_INGRESS=false`.

Pass criteria:

- [ ] guardian health returns 200
- [ ] allowed-origin preflight returns `204` with expected CORS headers
- [ ] disabled direct ingress returns `404 not_found`
- [ ] unauthenticated direct `/oc/*` traffic is rejected explicitly
- [ ] behavior matches current source expectations, not stale published package behavior

Evidence:

- guardian logs
- preflight response headers

---

## 8. Browser-Backed Live Stack Test

- [ ] Run stack-backed UI tests.

```bash
bun run ui:test:stack
```

- [ ] If the RC is meant to represent the full browser experience, also run:

```bash
bun run ui:test:e2e
```

Pass criteria:

- [ ] login succeeds
- [ ] connections UI works
- [ ] chat UI works
- [ ] runtime-config-driven routing works
- [ ] no assistant/client/UI artifact mismatch appears

---

## 9. Host UI Smoke

- [ ] Launch the host-served UI the way users actually do.

Pass criteria:

- [ ] `/host` loads
- [ ] `/connections` loads
- [ ] `/chat` loads
- [ ] admin login succeeds
- [ ] provider/auth state looks correct
- [ ] host UI and assistant-container client do not conflict or drift

Evidence:

- screenshots of `/host`, `/connections`, `/chat`

---

## 10. PWA Smoke

- [ ] Test localhost PWA installability from the host-served client origin.
- [ ] Test hosted PWA installability if applicable to this RC.

Pass criteria:

- [ ] installability is present on localhost
- [ ] installed localhost app reopens on the same origin and still works
- [ ] hosted origin works with expected runtime config behavior
- [ ] remote connection behavior matches HTTPS and guardian CORS requirements

Evidence:

- screenshots of install prompt or installed app

---

## 11. Real Credentialed Ingress Path

- [ ] Test at least one real credentialed ingress path.
- [ ] Minimum acceptable: guardian-hosted `chat` or `api`.
- [ ] Better: one baked portal adapter as well.

Pass criteria:

- [ ] authenticated request reaches guardian
- [ ] session is created successfully
- [ ] message flow completes successfully
- [ ] audit logging is present
- [ ] unauthenticated request is rejected correctly

---

## 12. Security Boundary Verification

- [ ] Inspect effective compose config and running containers.

Suggested checks:

```bash
docker inspect <assistant-container>
docker inspect <guardian-container>
docker compose ... config
```

Pass criteria:

- [ ] assistant has no Docker socket mount
- [ ] assistant has no default path to the host admin process
- [ ] guardian remains the only intended ingress bridge
- [ ] admin remains loopback-only by default
- [ ] no raw secret env values appear in inspect output
- [ ] secrets are granted as files, not broad env files

---

## 13. Rootless, Ownership, And Host Accessibility

- [ ] Run the guardrails already used in CI.

```bash
./scripts/validate-rootless-guardrails.sh
source scripts/rootless-smoke-fixture.sh && smoke_build_images assistant guardian portal
OP_ROOTLESS_SMOKE_SKIP_BUILD=1 ./scripts/rootless-ownership-smoke.sh stack
OP_ROOTLESS_SMOKE_SKIP_BUILD=1 ./scripts/rootless-ownership-smoke.sh portal-discord
OP_ROOTLESS_SMOKE_SKIP_BUILD=1 ./scripts/rootless-host-swap-smoke.sh
```

Pass criteria:

- [ ] no root-owned files appear under bind-mounted `OP_HOME`
- [ ] host user can still read and write expected files after boot
- [ ] secrets keep strict file modes
- [ ] no ownership-repair surprise appears during host swap

---

## 14. Cross-Environment Manual Checks

- [ ] Validate on native Linux.
- [ ] Validate on at least one Docker Desktop-style environment if that platform is supported.

Pass criteria:

- [ ] install/start/upgrade works without ownership or mount surprises
- [ ] any unsupported environment is explicitly waived with noted risk

Evidence:

- platform tested
- filesystem/runtime notes
- any deviations or waivers

---

## 15. Addon And Overlay Scenario Matrix

- [ ] Test no addons enabled.
- [ ] Test `chat` only.
- [ ] Test `api` only.
- [ ] Test a representative `custom.compose.yml` overlay.
- [ ] Test addon enable and disable round trip.

Pass criteria:

- [ ] compose profile resolution matches enabled addon state
- [ ] expected services appear and unexpected services do not
- [ ] no stale service lingers after disable
- [ ] user overlay still composes cleanly with the managed file set

---

## 16. CLI Binary Smoke

- [ ] Test at least one produced CLI binary artifact.

Verify:

```bash
openpalm --version
openpalm ui serve --help
openpalm install --help
```

Pass criteria:

- [ ] reported version matches `RC_VERSION`
- [ ] binary starts and prints expected help/version text
- [ ] install/start flow works from the built artifact, not just repo source

---

## 17. Electron Installer Smoke

- [ ] Install and launch the Electron build that `unit=all` will ship.

Pass criteria:

- [ ] app launches successfully
- [ ] packaged skeleton resolution works
- [ ] expected client/host UI routing works
- [ ] no packaged/runtime asset mismatch appears
- [ ] no repo checkout is required for normal operation

Evidence:

- installer artifact name
- screenshots of first successful launch

---

## 18. Auth, Permissions, And Policy Paths

- [ ] Verify admin auth success and failure.
- [ ] Verify guardian auth success and failure.
- [ ] Verify denied-origin and allowed-origin direct-ingress behavior.
- [ ] Verify content-validation fail-closed behavior if this release touched it materially.

Pass criteria:

- [ ] every failure path is explicit and safe
- [ ] no bypassable permission/auth path is found
- [ ] no unexpected leniency appears on direct ingress or browser-facing surfaces

---

## 19. Post-Publish npm Verification

- [ ] Verify each published npm artifact from the registry.

```bash
npm view @openpalm/lib@"$RC_VERSION" version
npm view openpalm@"$RC_VERSION" version
npm view @openpalm/ui@"$RC_VERSION" version
npm view @openpalm/client@"$RC_VERSION" version
npm view @openpalm/guardian@"$RC_VERSION" version
npm view @openpalm/skeleton@"$RC_VERSION" version
npm view @openpalm/discord-portal@"$RC_VERSION" version
npm view @openpalm/slack-portal@"$RC_VERSION" version
```

- [ ] Record dist-tags for key artifacts.

```bash
npm view @openpalm/client dist-tags --json
npm view @openpalm/guardian dist-tags --json
npm view @openpalm/skeleton dist-tags --json
```

Pass criteria:

- [ ] every expected package exists at the exact RC version
- [ ] dist-tags match prerelease expectations

---

## 20. Post-Publish Docker Verification

- [ ] Verify each image tag from the registry.

```bash
docker buildx imagetools inspect openpalm/assistant:"$RC_VERSION"
docker buildx imagetools inspect openpalm/guardian:"$RC_VERSION"
docker buildx imagetools inspect openpalm/portal:"$RC_VERSION"
```

Pass criteria:

- [ ] each tag resolves successfully
- [ ] manifest metadata looks correct
- [ ] no `latest` tag was created for the prerelease

---

## 21. Post-Publish GitHub Tag And Release Verification

- [ ] Verify expected tags exist.
- [ ] For `unit=all`, verify:
  - `platform-$RC_VERSION`
  - `portals-$RC_VERSION`
  - `assistant-$RC_VERSION`
  - `guardian-$RC_VERSION`
  - `electron-$RC_VERSION`
  - `$RC_VERSION`
- [ ] Verify the GitHub release exists and expected assets are attached.

Pass criteria:

- [ ] every expected tag exists
- [ ] tags point at the intended commit
- [ ] release assets are present and downloadable

---

## 22. Post-Publish Shipped-Artifact Boot Test

- [ ] Re-run the isolated stack against the actual published RC artifacts.
- [ ] Use the published npm packages and published images, not local source.

Pass criteria:

- [ ] runtime behavior matches pre-publish expectations
- [ ] no guardian/skeleton/client artifact drift appears
- [ ] health, client serving, auth, and direct-ingress checks still pass

---

## Risk Focus

If time is limited, prioritize these in order:

1. shipped guardian/skeleton/client artifact behavior
2. upgrade plus rollback behavior
3. rootless ownership and host accessibility
4. browser-backed live stack flow
5. real ingress auth/CORS/permission behavior
6. Electron and CLI packaged artifact sanity

---

## Related Documents

- [Release Management](release-management.md)
- [Manual Compose Runbook](manual-compose-runbook.md)
- [Core Principles](../technical/core-principles.md)
- [Environment Variables, Mounts, and Network Wiring](../technical/environment-and-mounts.md)
- [Release Architecture](../technical/release-architecture.md)
