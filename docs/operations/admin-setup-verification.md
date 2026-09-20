# Admin setup verification

This runbook verifies the optional Admin against a fresh OpenPalm home and real
Docker containers. It never points at an existing installation.

The automated walkthrough is the preferred repeatable check. A manual pass is
still useful before a release when provider sign-in, desktop rendering, or a
specific operating system needs human inspection.

## What counts as a pass

The walkthrough must prove that:

1. Admin opens on a genuinely empty `OP_HOME`;
2. the operator can choose non-conflicting Assistant and Guardian ports before
   installation;
3. Assistant starts healthy and OpenCode returns its provider catalog;
4. Guardian can be enabled and starts healthy;
5. a named credential and its policy survive an Admin reload and stack restart;
6. a Discord user mapping survives that same restart;
7. Guardian returns `401` without a credential and accepts MCP with the mapped
   credential;
8. a `read` credential sees read tools but not full-only tools; and
9. the isolated stack is stopped and removed after the test.

Provider discovery does not prove model readiness. A complete end-user setup
also requires one real provider response. Supply the optional provider inputs
below or perform the provider step manually.

## Prerequisites

- Docker Engine with Compose v2
- the repository dependencies installed with `bun install --frozen-lockfile`
- a Linux, macOS, or Windows desktop session that can open Electron
- the current runtime images available locally

Build the images from the checkout being tested:

```bash
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION=0.14.0 -t openpalm/assistant:0.14.0 .
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION=0.14.0 -t openpalm/guardian:0.14.0 .
docker build -f containers/portal/Dockerfile \
  -t openpalm/portal:0.14.0 .
```

## Automated Electron and Docker walkthrough

From the repository root:

```bash
bun run admin:e2e
```

The test creates a unique Compose project, selects two free loopback ports, and
uses a generated temporary home. It drives the actual Admin renderer and IPC
handlers, not a mock page. On success it removes its containers, networks,
browser profile, and temporary OpenPalm home. It retains a report and three PNG
screenshots in a printed `/tmp/openpalm-admin-e2e-artifacts-*` directory.

The default run intentionally uses no provider secret. It verifies provider
discovery and reports `providerReadiness.attempted: false`. To include a real
API-key readiness request, set both variables for a provider ID shown by
OpenCode:

```bash
export OPENPALM_ADMIN_E2E_PROVIDER=anthropic
read -rsp 'Temporary provider API key: ' OPENPALM_ADMIN_E2E_PROVIDER_KEY
export OPENPALM_ADMIN_E2E_PROVIDER_KEY
bun run admin:e2e
unset OPENPALM_ADMIN_E2E_PROVIDER_KEY
```

The key is entered through the real Admin form and lives only in the generated
test home, which is removed after the run. Do not place a key in a command-line
argument or commit it to a test fixture.

Set `OPENPALM_ADMIN_E2E_KEEP_HOME=true` to retain a failed test home for
inspection. Set `OPENPALM_ADMIN_E2E_KEEP_RUNNING=true` only for interactive
diagnosis; it also retains the home and prints its location. Stop that exact
project and inspect the printed path before removing it.

## Manual walkthrough

Use this process for release-candidate inspection or a provider OAuth flow.

1. Create a new temporary directory and record its exact printed path:

   ```bash
   test_root="$(mktemp -d /tmp/openpalm-admin-manual.XXXXXX)"
   printf '%s\n' "$test_root"
   ```

2. Bundle and launch Admin with an isolated project name:

   ```bash
   bun run --cwd packages/electron bundle
   OP_HOME="$test_root/home" \
   OP_PROJECT_NAME=openpalm-admin-manual \
   OPENPALM_REPO_ROOT="$PWD" \
   bun run --cwd packages/electron start
   ```

3. On the fresh-install screen, choose two unused ports. Confirm that the home
   shown at the top is exactly `$test_root/home`, then click **Install
   OpenPalm**.

4. Confirm Runtime shows `assistant · running · healthy`. Click **Load
   providers** and confirm the provider selector is populated.

5. Complete provider authentication:

   - for an API-key provider, select it, enter the key, and click **Save key and
     test**;
   - for OAuth or another interactive method, close Admin, run `openpalm setup`
     with the same `OP_HOME` and `OP_PROJECT_NAME`, then reopen Admin.

   The readiness result must contain `"ok": true` and a real provider/model.

6. Enable **Guardian MCP gateway**, choose its loopback port, and click **Save
   and apply**. Confirm both `assistant` and `guardian` are healthy.

7. Create `manual-reader` with the `read` policy. Add a Discord mapping from a
   valid test platform user ID to `manual-reader`. The portal itself does not
   need to be enabled for this registry test.

8. Click **Restart**, then **Refresh**. Confirm the ports, Guardian setting,
   credential policy, mapping, and two healthy services remain visible.

9. Check Guardian without printing the bearer key:

   ```bash
   curl -fsS "http://127.0.0.1:GATEWAY_PORT/health"

   curl -sS -o /dev/null -w '%{http_code}\n' \
     -X POST "http://127.0.0.1:GATEWAY_PORT/mcp" \
     -H 'content-type: application/json' \
     --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-check","version":"1"}}}'

   IFS= read -r guardian_key < \
     "$test_root/home/state/credentials/manual-reader/key"
   curl -fsS -X POST "http://127.0.0.1:GATEWAY_PORT/mcp" \
     -H 'accept: application/json, text/event-stream' \
     -H 'content-type: application/json' \
     -H "authorization: Bearer $guardian_key" \
     --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
   unset guardian_key
   ```

   Replace `GATEWAY_PORT` with the selected port. The first MCP request must
   return `401`. The authenticated catalog must include
   `openpalm.workspace.read` and exclude the full-only
   `openpalm.session.delete` tool.

10. Stop the stack from Admin. Confirm no containers remain for the
    `openpalm-admin-manual` project. Remove only the exact temporary directory
    printed in step 1 after reviewing it.

## Evidence to retain

For a release sign-off, record:

- commit SHA and image digests;
- operating system, Docker, Compose, and Electron versions;
- selected test ports;
- provider/model used for real readiness, without its credential;
- the E2E `report.json` and screenshots; and
- any deviation from the expected `401`, `200`, or tool-policy results.
