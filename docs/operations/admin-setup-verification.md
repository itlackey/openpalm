# Admin setup verification

This runbook verifies the optional Admin against a fresh OpenPalm home and real
Docker containers. It never points at an existing installation.

The automated walkthrough is the preferred repeatable check. A manual pass is
still useful before a release when provider sign-in, desktop rendering, or a
specific operating system needs human inspection.

## What counts as a pass

The walkthrough must prove that:

1. Admin opens on a genuinely empty `OP_HOME`;
2. the default setup path hides ports and prevents duplicate installation;
3. Assistant starts healthy and OpenCode returns a filtered provider catalog;
4. an interrupted first start exposes working port correction and retry controls;
5. a failed provider request stays in **Connect your AI** and is announced as
   an error rather than setup success;
6. OpenCode, Claude Desktop, and generic MCP each expose a complete connection
   recipe without consulting another document;
7. Guardian can be enabled and starts healthy;
8. a named access key and its policy survive an Admin reload and stack restart;
9. a Discord user mapping survives that same restart;
10. Guardian returns `401` without a credential and accepts MCP with the mapped
   credential;
11. a `read` credential sees read tools but not full-only tools;
12. visible controls meet the minimum rendered-size and focus checks without
    document-level horizontal overflow; and
13. the isolated stack is stopped and removed after the test.

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
handlers, not a mock page. It deliberately stops the fresh Assistant once and
recovers it through the visible setup form. On success it removes its
containers, networks, browser profile, and temporary OpenPalm home. It retains
a report and five PNG screenshots, including startup recovery and 200%-zoom
reflow, in a printed `/tmp/openpalm-admin-e2e-artifacts-*` directory. A
provider-backed run also captures the ready overview.

The default run intentionally uses no provider secret. It verifies provider
discovery, lets Admin automatically test any detected sign-in, and proves that
an unsuccessful real request remains an incomplete setup error. It then marks
only the disposable test home complete with an explicit test fixture so the
visible management UI, all three connection recipes, Guardian, access, and
mapping flows can be exercised without pretending provider setup succeeded.
The report records `visibleSetupJourneyComplete: false` and
`managementUiFixtureUsed: true` in this mode. To test the successful **Your
personal agent is ready** journey without that fixture, set both variables for
a provider ID shown by OpenCode:

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

3. Confirm that the welcome screen describes the personal agent without
   showing ports, paths, Guardian, credentials, or Compose terminology. Open
   **Advanced network settings** only when this isolated test needs different
   ports, then click **Set up OpenPalm**. Confirm that the action immediately
   shows progress and cannot be submitted twice.

4. Confirm Admin advances to **Connect your AI**, Assistant shows **Running
   normally**, and provider discovery begins automatically. **Find providers**
   refreshes the list. Connected providers must be listed first by display
   name, not an arbitrary raw provider ID.

5. Complete provider authentication:

   - for an API-key provider, select it, enter the key, and click **Save key and
     verify**;
   - for browser/OAuth sign-in, choose the method, complete any provider-specific
     fields, and select **Open provider sign-in**. Finish in the system browser,
     paste an authorization code only when requested, then choose **Finish
     sign-in and verify**.

   Confirm the browser flow requires no terminal and applies to the exact
   isolated home launched in step 2.

   A rejected sign-in must show **OpenPalm could not verify this provider** and
   remain in setup. A successful real request must open **Overview**, show
   **Your personal agent is ready**, and offer OpenCode, Claude Desktop, and
   another MCP app as connection choices. Technical details may contain the
   real provider/model but must not be the primary status.

6. Follow each choice from Overview and confirm its guided panel is complete:

   - OpenCode shows server address, username `opencode`, and explicit password
     reveal/copy actions;
   - Claude Desktop shows protected-access state, extension download, endpoint,
     named identity, and explicit key reveal/copy actions; and
   - another MCP app shows its Streamable HTTP endpoint, bearer convention,
     named identity, and key actions.

7. In **Connections**, enable **Guardian MCP**, leave its loopback default
   unless the test needs another port under **Troubleshooting → Network
   settings**, and choose **Save connections**. Confirm Assistant and Guardian
   both show **Running normally**.

8. Open **People & access**. Create `manual-reader` with **Read files** access.
   Add a Discord identity override from a valid test platform user ID to
   `manual-reader`. The portal itself does not need to be enabled for this
   registry test.

9. Return to **Overview**, choose **Restart**, then **Refresh status**.
   Confirm the ports, protected-access setting, access policy, mapping, and two
   healthy services remain visible.

10. Check Guardian without printing the bearer key:

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

11. Open **Backup**, use **Choose folder**, and create a backup in a new empty
    directory. On a separate disposable fresh home, select that directory in
    the restore picker, preview it, then modify a source file. Confirm apply is
    refused until a new preview binds the changed content.

12. Stop the stack from Admin. Confirm no containers remain for the
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
