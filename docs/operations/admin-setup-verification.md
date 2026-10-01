# Admin setup verification

This runbook verifies the optional Admin against a fresh OpenPalm home and real
Docker containers. It never points at an existing installation.

The automated walkthrough is the preferred repeatable check. A manual pass is
still useful before a release when provider sign-in, desktop rendering, or a
specific operating system needs human inspection.

## What counts as a pass

The walkthrough must prove that:

1. Admin opens on welcome without seeding `OP_HOME`, supports one-click
   default/previous selection, remembers recent folders, and rejects invalid
   folders unchanged;
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
13. switching between two valid test homes clears transient keys, targets
    credential changes only at the selected home, and leaves the other stack running;
14. the isolated stack is stopped and removed after the test.

The setup restore walkthrough also previews a synthetic old home with omitted
runtime data, verifies that native-history disclosure is visible outside technical
details and apply stays disabled, then explicitly acknowledges the omission and
checks the copied file's content. It must not call that portable copy a complete
migration or activate the old runtime artifact. Native SQLite history recovery
has a separate real-engine suite described in the
[migration guide](migration-to-0.14.md#repeatable-migration-verification).

The walkthrough also changes the recurring-work timezone and automatic-memory
preference through the visible UI, applies them with a restart, and verifies
that both survive a renderer reload. It temporarily disables automatic memory
in this disposable home to keep the installer test's model-request budget
bounded, then restores it for runtime acceptance. Memory extraction and actual
timer execution have separate runtime acceptance checks.

A provider-backed run also verifies the installed default provider with a real
native request after restart and completes a real `openpalm.agent.run` request
through Guardian MCP. Setup success alone is insufficient for this check.

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
release_version="$(bun -e 'console.log((await Bun.file("package.json").json()).version)')"
docker build -f containers/assistant/Dockerfile \
  --build-arg PLATFORM_VERSION="$release_version" -t "openpalm/assistant:$release_version" .
docker build -f containers/guardian/Dockerfile \
  --build-arg GUARDIAN_VERSION="$release_version" -t "openpalm/guardian:$release_version" .
docker build -f containers/portal/Dockerfile \
  -t "openpalm/portal:$release_version" .
```

## Automated Electron and Docker walkthrough

From the repository root:

```bash
bun run admin:e2e
```

The test creates a unique Compose project, selects two free loopback ports, and
uses a generated temporary home. It drives the actual Admin renderer and IPC
handlers, not a mock page. It deliberately stops the fresh Assistant once and
recovers it through the visible setup form. Normally it stops and removes its
containers and networks and removes the generated browser profile. A generated
home without provider authentication is removed unless retention is requested.
Provider-backed homes and explicitly supplied homes are always retained, even
on failure, so copied operator authentication is never silently deleted.
Populated or unreadable provider-auth files also force retention. It retains a
report and PNG screenshots, including startup recovery, remote setup and 200%-zoom
reflow, in a printed `/tmp/openpalm-admin-e2e-artifacts-*` directory. A
provider-backed run also captures the ready overview.

Visual acceptance: the install action is visible at the default window size;
Docker readiness is checked before it becomes enabled. A stopped agent shows
startup recovery, not a running-agent claim or a competing account form.
At 200% zoom, setup progress becomes a compact header and forms remain usable
without horizontal scrolling. Refresh adds no overlay or success toast and
does not dismiss a persistent error. Under Connections, native remote setup
requires unchecked workspace consent; Codex's workspace-write default is
selected inside a closed Advanced settings disclosure. Connection details
remain private and startup status explicitly leaves client readiness unverified.

Codex setup includes an unchecked automatic-recall approval choice, an explanation
of prompt/knowledge access, and the actual native commands. The E2E walkthrough
also reviews recall independently, rejects approval without explicit consent,
saves native approval through real IPC, verifies **Ready** after container
recreation, and turns it off to **Installed** without enabling remote startup or
using a vendor account. A dedicated recall screenshot is retained in the report.
Image smoke separately changes definitions and verifies **Approval needed** plus
stale-review rejection. These checks require the beta.1 guided-recall image,
not just a new Admin bundle pointed at the published alpha.4 image.

### Guided-recall verification receipt (beta.1 candidate)

The October 1, 2026 Linux walkthrough used an isolated Assistant image built
from the guided-recall checkout, real Electron IPC, and a disposable home. It
passed explicit consent, native approval, container-recreation persistence,
opt-out, and unchanged remote startup. The rest of the Admin journey passed
startup recovery, preferences, connection recipes, credential/mapping
persistence, and authenticated Guardian MCP. The provider-free lane correctly
reported provider readiness as unsuccessful and used the documented management
fixture; it did not verify subscription sign-in or claim a complete provider
setup. Screenshots were visually reviewed.

Two test-harness corrections were needed: focus checks now inspect the control
actually reached by keyboard navigation rather than programmatically focusing
a possibly disabled control, and independent recall checks tolerate the expected
provider error only in the provider-free fixture lane. Neither correction
relaxes native recall consent or the provider-backed setup acceptance criteria.

Image smoke also exercises real recall in OpenCode, Claude Code, and Codex,
then verifies native approval persistence, changed-definition review, stale
approval rejection, opt-out persistence, and preservation of an unrelated
untrusted hook. No existing user instance is changed by these tests.

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

For an existing private key file, pass its path instead of putting the key in
the environment. For example, OpenCode Go uses the `opencode-go` provider ID:

```bash
OPENPALM_ADMIN_E2E_PROVIDER=opencode-go \
OPENPALM_ADMIN_E2E_PROVIDER_KEY_FILE=/absolute/path/to/private/key \
bun run admin:e2e
```

The test reads that file without modifying it. `providerRuntime` in the report
records the real native provider/model and whether the MCP response completed.

The key is entered through the real Admin form and copied only into the private
test home. A provider-backed run retains that home by default and prints its
exact path; reports record `homeRetained: true`. The source key file is never
modified. Do not place a key in a command-line argument or commit it to a test
fixture. Review retained credentials and obtain path-specific approval before
deleting that home.

Set `OPENPALM_ADMIN_E2E_KEEP_HOME=true` to retain a generated provider-free home
for inspection too. `KEEP_HOME=false` never overrides provider or explicit-home
retention. Retaining a home does not leave containers running. Set
`OPENPALM_ADMIN_E2E_KEEP_RUNNING=true` only for interactive diagnosis or the
follow-on live acceptance suite; it also retains the home and prints its
location. Stop that exact project and inspect the printed path before removing
it.

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

3. Confirm **Welcome to OpenPalm** offers the previous/default instance and
   **Open another folder…**, with paths so the target is unambiguous. Cancel
   the picker and confirm nothing changes. Select a legacy or unrelated
   nonempty test folder and confirm the error leaves its contents untouched.
   Open the fresh test home in one click. Its setup screen describes the agent
   without exposing Guardian, credentials, or Compose terminology. Open
   **Advanced network settings** only when this isolated test needs different
   ports, then click **Install OpenPalm**. Confirm that the action immediately
   shows progress and cannot be submitted twice.

   Before installing, choose **Choose another instance**, then reopen the
   previous test folder in one click. Restart Admin and confirm it still opens
   welcome, remembers the previous folder, and requires no shell change to
   `OP_HOME`. Keep all choices limited to disposable test directories.

   Note the window dimensions after manually sizing it. Navigation, refresh,
   setup transitions and instance switching must leave them unchanged. The
   automated walkthrough explicitly resizes its disposable window for narrow
   layout checks; those calls exist only in `admin-e2e.ts`, never in production.
   Its window title identifies it as **OpenPalm Admin — automated UI test**.

4. Confirm Admin advances to **Connect your AI**, Assistant shows **Running
   normally**, and provider discovery begins automatically. **Refresh accounts**
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

6. In Overview, expand **Agent preferences** and change to a different IANA timezone
   and turn automatic memory off. Save, wait for the restart, and refresh.
   Confirm both settings remain saved. Turning memory off must not remove
   existing knowledge. Re-enable it when testing the memory acceptance path.

   Follow each connection choice and confirm its guided panel is complete:

   - OpenCode shows a clickable server address, username `opencode`, and explicit
     **Load password**, **Show password**, and **Copy password** actions;
   - Claude Desktop shows protected-access state, extension download, endpoint,
     named identity, and explicit **Load key**, **Show key**, and **Copy key** actions; and
   - another MCP app shows its Streamable HTTP endpoint, bearer convention,
     named identity, and key actions.

7. In **Connections**, enable **Guardian MCP**, leave its loopback default
   unless the test needs another port under **Troubleshooting → Network
   settings**, and choose **Save connections**. Confirm Assistant and Guardian
   both show **Running normally**.

   In **Troubleshooting**, confirm the network labels say **Guardian MCP bind
   address / port**, and the copy actions provide full `/mcp` and `/health`
   URLs. The page must explain that Guardian is an API, not a website, and
   that credentials select policies. The health endpoint returns JSON; a
   `not_found` response at its base address is expected. With Guardian disabled,
   the page must not imply these endpoints are active.

   Under **Installation details**, Tab to **Trusted OpenCode address** and
   press Enter, then click the link. Both should open the configured address
   in your browser without navigating Admin away from its local page. No
   password belongs in the link; retrieve it through the explicit Connections
   actions if the browser asks. Direct access still bypasses Guardian.

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

### Verified final UI refinement: 2026-10-01

An independent design specialist reviewed the current welcome, install,
provider setup, recovery, overview, all client recipes, access management,
backup, troubleshooting, experimental setup, and Codex recall screens. The
final refinement was approved with no release-blocking design findings.
Neutral controls and disclosures reserve green for meaningful primary actions;
the overview leads with OpenCode access, and optional management forms are
collapsed without removing their controls. Validation automatically opens
portal tokens, and key management opens from its identity row.

The real Electron/Docker walkthrough passed before and after refinement.
The final report and 20 screenshots are retained at
`/tmp/openpalm-admin-e2e-artifacts-ZGLcEZ/` on the verification host. Normal
screenshots wait for control transitions and show the page from the top;
keyboard-focused controls are checked separately. Minimum-size layouts,
200%-zoom MCP reflow, masked secrets, native approvals, portal mapping,
restart persistence, and two-instance isolation passed. Production window
dimensions remain under user control. Dedicated narrow screenshots show only
the visible viewport, not every control inspected by the automated checks.

The regression suite passed 329 tests with one environment-dependent skip.
Type checks, lint, and the Admin build passed. No new dependencies or services
were added. These runs used no provider secret or native vendor sign-in:
the free provider rejected readiness, setup correctly remained incomplete,
and management used the explicit disposable-home fixture. This is UI and
management verification, not a new provider-authentication sign-off. Isolated
test containers were removed; private test homes and evidence were retained.

### Verified instance welcome and stable window size: 2026-10-01

The real Electron/Docker walkthrough passed with two disposable 0.14 homes:
one-click default/previous selection, persisted recents, folder-picker
cancellation, invalid-folder preservation, and switching back to the running
original stack. A credential created in the second home did not alter the
first; revealed keys cleared and a stale provider sign-in completion was
rejected. Window dimensions remained unchanged through switching. Explicit
test-only resizing verified the welcome and recent-instance layouts at 640px;
production-source tests prohibit automatic window resizing.

The regression suite passed 326 tests with one environment-dependent skip.
Type checks, lint, CLI/Admin builds, and all-profile Compose validation passed.
No provider secret or vendor login was used. Setup correctly rejected the free
provider request; management used an explicit test fixture, not live readiness.
Test containers were removed, and the existing Splinter stack remained healthy.
Report and screenshots remain at
`/tmp/openpalm-admin-e2e-artifacts-0c3UQg/` on the verification host.

### Verified provider-backed run: 2026-09-30

The fresh Electron/Docker walkthrough completed with OpenCode Go using a
private key file. OpenCode selected `opencode-go/gpt-5.6-luna`; both the initial
readiness check and the native default-provider check after restart returned
the expected token. A real guarded MCP agent request also completed after
restart. The report recorded `visibleSetupJourneyComplete: true` and
`managementUiFixtureUsed: false`.

Startup recovery, all three client recipes, access-policy filtering, a Discord
identity mapping, and configuration persistence after restart/reload passed.
Guardian returned `401` without a key and `200` for authenticated initialization
and tool discovery. The successful test stopped its isolated containers and
removed its generated home. API-key sign-in was exercised; this run does not
claim to exercise an interactive OAuth browser flow.

### Verified fwdslsh-style redesign: 2026-09-30

The redesigned installer and Admin passed the isolated Electron/Docker E2E,
including Docker readiness, startup recovery, all client recipes, credential
policies and mapping, restart persistence, and 200%-zoom reflow. Guardian
returned `401` without authentication and `200` for authenticated MCP discovery.
The full regression suite, type checks, lint, CLI/Admin builds, and Compose
validation with all three profiles passed. An independent design specialist
visually reviewed all ten screenshots and approved the design, contrast,
keyboard-focus treatment, explicit consent, and masked-secret presentation.

This redesign run used no provider secret. OpenCode's free-tier request was
rejected; setup correctly remained incomplete. Management screens used the
explicit disposable-home fixture (`managementUiFixtureUsed: true`), not a
claim of live account readiness. No native vendor login or remote-client
connection was verified. Test containers were stopped and private test homes
retained. Screenshot and report artifacts were retained under
`/tmp/openpalm-admin-e2e-artifacts-gowN7Y/` on the verification host.
