# Scripts

Only a small script surface remains active.

| Script | Purpose |
|---|---|
| `dev-setup.sh` | Materialize an isolated `.dev` home for the stack |
| `set-version.mjs` | Validate semantic versions and stamp package/Compose versions |
| `bump-release.mjs` | Stamp the complete product release |
| `setup.sh`, `setup.ps1` | Release bootstrap installers |
| `smoke-image.sh` | Assert image startup and runtime security boundaries |
| `smoke-admin-artifact.mjs` | Extract/install and launch a fresh native Admin package on its build runner |
| `test-isolate-op-home.ts` | Force every Bun test into a throwaway `OP_HOME` |
| `validate-release-assets.mjs` | Verify the complete checksummed release set |
| `publish-gitea-release.mjs` | Stage and hash-verify canonical Gitea assets before publishing |
| `publish-bootstrap.mjs` | Publish the matching npm bootstrap through GitHub trusted publishing |
| `live-acceptance.ts` | Opt-in real-provider runtime acceptance after a retained Admin E2E run |

## Local development

```bash
./scripts/dev-setup.sh
./scripts/dev-setup.sh --enable-addon gateway
./scripts/dev-setup.sh --enable-addon discord
bun run dev:build
```

The adjacent test files cover release stamping, asset completeness, and
deterministic control-plane wiring. Provider and AKM boundaries in
`acceptance.test.ts` are fixtures; they do not prove real-model memory or timer
execution.

## Real-provider acceptance

Build runtime images with the version from the root `package.json`, then run
`bun run admin:e2e` with provider authentication and
`OPENPALM_ADMIN_E2E_KEEP_RUNNING=true`. Pass its exact retained private home to
`OPENPALM_LIVE_TEST_HOME` and an optional private output path to
`OPENPALM_LIVE_TEST_REPORT`, then execute:

```bash
OPENPALM_LIVE_TEST_HOME=/absolute/path/to/disposable-e2e/home \
OPENPALM_LIVE_TEST_REPORT=/absolute/path/to/private/live-report.json \
  bun run scripts/live-acceptance.ts
```

The thin entrypoint imports the runner beside Guardian's private MCP client
dependency. It verifies trusted-native automatic memory, natural-language task
creation and real timer history/output, recall after update/restart, MCP policy
boundaries, resumable job and identity isolation, explicit permission approval
with cross-identity rejection, and credential rotation.
Guarded remote and scheduled sessions are excluded from automatic capture.
It refuses normal operator projects and non-loopback fixtures.

The runner retains the test home and report, closes MCP clients, and attempts
to pause its generated task. It does not stop the stack or erase secrets.
`directModelRequests` excludes background memory and scheduled requests, so
allow budget headroom and stop the exact test stack after review. See the
[testing workflow](../docs/technical/testing-workflow.md) for version-matching
build commands, private-home setup, cleanup, and verification limits.
