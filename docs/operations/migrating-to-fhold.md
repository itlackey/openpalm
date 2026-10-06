# One-time migration from OpenPalm to fhold

This small Linux transition utility stays in the OpenPalm repository. It is
not part of fhold's installer, image, runtime or permanent compatibility surface.
It uses public commands from a packaged fhold CLI, not private library imports,
rewritten backup identities, direct database replacement or special test repairs.

Supported input is a lean OpenPalm 0.14 home owned by the same user, or a
reviewed 0.13 home with explicit new intent and a resolved native data directory.
This is a source-side transition, not an in-place update. Do not assume portable
import preserved history, external directories, named volumes or voice data.

## Before starting

1. Obtain the matching fhold CLI and Assistant/Guardian/Portal images. For
   interrupted history, use alpha.2 or later with `--archive-interrupted` support.
2. Inventory the actual home, service mounts, users/policies, native logins,
   plugins, task definitions and client addresses. The utility privately archives
   exact physical external bind sources and named volumes from that source's
   Compose containers. It does not automatically activate those mounts.
3. Choose a new home, instance name and private backup directory, all separate.
   They must not exist. Do not use the default home of an unrelated instance.
4. Keep the original CLI, images, homes, containers and any external data.
   The script never deletes them, changes the source or stops unrelated services.

Requirements: Linux, Node.js 22+, Docker/Compose and a packaged fhold CLI.
The script has no npm dependencies. Run it as the non-root instance owner.

## Preview

```bash
node scripts/migrate-to-fhold.mjs \
  --from /absolute/path/to/openpalm-home \
  --to /absolute/path/to/new-fhold-home \
  --name april \
  --fhold /absolute/path/to/fhold-cli \
  --source-image openpalm/assistant:0.14.0-beta.1 \
  --backup /absolute/path/to/private-new-migration-directory \
  --include-provider-auth --include-user-env --include-native-accounts
```

Preview does not create either directory. It reports selected file counts,
omissions, policies and services that still need stopping. The image must match
the source Assistant's exact installed image. No source or destination starts.
Native remote workers remain off for the first target boot so copying an account
cannot silently pair another worker. The receipt retains the original choices.

Opt-ins are independent:

- `--include-provider-auth`: native `auth.json`, supported provider preference
  JSON and exact private `/stash/secrets/` file references. OpenCode's standard
  `@ai-sdk/openai-compatible` SDK choice is preserved for custom/local endpoints;
  other package overrides require manual review. No credentials are printed.
- `--include-user-env`: only `knowledge/env/user.env`, not old managed env files.
- `--include-native-accounts`: **container-owned** `.claude`, `.claude.json` and
  `.codex`, including native conversations and cold SQLite/WAL files. Never use
  the host user's unrelated login directories. Native trust is not invented.
- Repeated `--native-path .example-addon` selects additional paths relative to
  the source Assistant home for user-installed tools. No vendor-specific addon
  belongs in fhold. Review those paths and their sensitivity first.
- `--runtime /resolved/assistant/.local/share/opencode` is required for linked
  Assistant homes and must match the selected Assistant's physical native data.
  Never blindly follow every symlink in the old installation.
- `--directory-map /private/directories.json` provides exact native history
  mappings when an old session ran outside `/work`. Every target must be `/work`
  or an existing contained workspace directory. Map deliberately, preserve the
  corresponding authored files and document changed project contexts.
- `--archive-interrupted`: after review, retain unfinished calls as terminal
  interrupted errors through fhold's native history command. Originals and raw
  exports stay unchanged; the calls are not executed. Default recovery blocks them.

Authored knowledge and workspace files, including workspace Git state, are
selected. Generated dependency trees are omitted. Source task definitions go to
`knowledge/imported-tasks/`, not the active scheduler. Empty project directories
are preserved so historical contexts remain discoverable.
Large authored regular files and Git packs use the same bounded-memory hashing
and native filesystem copy; they are not excluded by an arbitrary size limit.
Preview reports total selected bytes. Check adequate free local target disk and
private archive storage before beginning the cold transfer.

## Explicit 0.13 intent

Older homes do not have the lean `state/stack.json`. Supply `--source-config`
with a privately reviewed version-1 **OpenPalm lean intent** object containing
`assistant`, `gateway`, `credentials` and `portals`, using the existing lean
schema. Do not give it a `product` field. The tool converts that reviewed input
to fhold's current public install configuration; only the packaged CLI creates
the installation and authoritative state.

Review the actual source's addresses, timezone, memory choice, enabled bots and
allowlists, and the desired chat/read/full policies. A legacy default unrestricted
agent is not automatically a new chat-only bot, nor is an empty old allowlist
permission to expose a default-deny new bot to everyone. Preserve explicit scope
and choose the appropriate existing policy. Old service/image/env/Compose intent
is never inferred into the new runtime. Native workers remain off on first boot.

The resolved `--runtime` is also mandatory for this path. Original source homes,
their linked physical data and named volumes remain intact. This transition does
not activate the retired UI, SSH service, shared host bundles or other addons.
Retained user-owned files can be selected with `--native-path`; generated engine
caches/DBs must not be copied over the new engine. Reviewed `.config/gh` and
`.config/configstore` are supported personal application state, not whole `.config`
trees. Native historical tool outputs/snapshots can be preserved separately with
the exact `.local/share/opencode/tool-output` and `snapshot` paths when present;
their usability and old absolute references require separate acceptance.
Keep the source Assistant container present and stopped: this older-home path
refuses to proceed after it is removed, because its external volume inventory
would otherwise be incomplete.

## Cold transfer

Stop only the inventoried source services. For homes with external mounts or
named volumes, use `docker stop <exact-inventoried-container-IDs>` so their mount
inventory remains available for the cold archive. A source CLI that runs Compose
`down` removes that inventory; do not use it until physical sources and volumes
have separately been inventoried and archived. A resolved native-home symlink is
still archived when the source containers are absent, but that is not proof that
other external sources were captured. Never run a broad cleanup, stop another
home or remove a legacy project's unrelated service such as voice.

Run the **same reviewed command** with `--apply`. It refuses a still-running
source before writing anything. It then:

1. Creates a mode-0700 private cold whole-home archive and compares it to source.
   Each distinct external bind source and named volume gets its own cold tar,
   content comparison, SHA256 and source identity. These one-off source-image
   workers are non-root, offline, read-only and have no additional capabilities.
   Named volumes use Docker's volume identity, not privileged host traversal.
   An unreadable source or mismatch blocks transfer; do not call an incomplete
   archive a complete backup. This captures files not activated in fhold.
2. Exports conversations through `fhold history export`, using the original
   image offline and read-only. Raw exports remain private outside agent mounts.
3. Creates the named instance with the real `fhold --name /exact/new/home install --config
   ... --no-start` command. `install-config.json` is ordinary reviewed operator
   input; only the installer creates target state, managed files and provenance.
   Existing exact bind/port/timezone/memory/sandbox choices are preserved. Old
   source ports must be free before starting; normal fresh installs otherwise
   support automatic available-port selection.
4. Copies and hash-verifies selected files. Recreates named policies and portal
   allowlists/user mappings through the fhold CLI. New keys, password and handle
   authority are generated. Enabled or fully configured disabled portal tokens
   use secret-file commands; disabled portals remain disabled. Partial/incomplete
   disabled token pairs remain in the private whole-home archive for review.
   Blank/whitespace-only placeholders from older installers are not treated as
   configured disabled credentials; their original files remain in that archive.
5. Maps existing `/work` contexts without inventing external mounts. Runs native
   history preview, then apply with explicit same-owner continuation. fhold
   performs whole-batch native round-trip and preservation verification.

The destination remains stopped. A transfer receipt is **not** end-to-end
acceptance. If any step fails, retain both homes and the private backup. Do not
rerun `--apply` over a partially created home. Read the private plan and finish
the failed native/CLI step manually, or choose another new home/backup. Private
`commands.jsonl` records native/CLI diagnostics; treat it as credential-bearing
and never publish it. History
has its own safe retry journal; use identical mapping/archival options.

## Native plugins and first startup

Account transfer does not prove fresh authentication. Native tokens may expire
or refresh, and new binaries/plugin definitions may require another review.
Do not transfer `.openpalm-native-defaults`, generated OpenCode caches, managed
AKM configuration or old scheduler activation.

Review Claude/Codex plugin registration before enabling those workers. In
particular, an old AKM install can reference the previous image's
`/native-defaults` cache. Use each harness's **standard plugin commands** with
the current image-baked `/akm-marketplace`; do not rewrite registries by hand
or force acceptance of changed hook definitions. Preserve user-installed plugins
and their native credentials; independently verify that they still load.
The migration tool reports this review as outstanding, not as a passing test.

After the Assistant starts, run these standard native commands in its shell,
or through `docker compose exec assistant` using this home's recorded Compose
files and environment:

```bash
claude plugin marketplace update akm-plugins
claude plugin update akm@akm-plugins --scope user
codex plugin add akm@akm-plugins
claude plugin list --json
codex plugin list --json
```

These use the local image-baked marketplace. Codex's `marketplace upgrade` is
for Git marketplaces, not this local source; `plugin add` is its standard
reinstallation command and updates the installed cache without hand-editing
native registries. Check versions against the image's pinned AKM plugin and
review changed hooks. Do not reinstall a deliberately disabled plugin as part
of migration. No account login or hook approval is implied by these commands.

```bash
/absolute/path/to/fhold-cli --name /absolute/path/to/new-fhold-home setup
/absolute/path/to/fhold-cli --name /absolute/path/to/new-fhold-home doctor --readiness
/absolute/path/to/fhold-cli --name /absolute/path/to/new-fhold-home connect opencode
/absolute/path/to/fhold-cli --name /absolute/path/to/new-fhold-home connect mcp --credential owner
```

Use Admin or `fhold remote enable claude` / `fhold remote enable codex` for native
sign-in, consent and startup. Re-enable only the original/user-chosen workers.
Changed AKM hook definitions require explicit review. Native workers remain
experimental; signed-in/running is not proof of a real client/tool request.

Review tasks with `fhold task adopt <staged-file>`, test manually, inspect durable
results and resume only intentional recurring work. Arbitrary old shell/workflow
tasks need manual recreation; do not bulk-enable them.

## Acceptance and rollback

Verify conversation IDs/content/project discovery, workspace/Git files,
knowledge lookup, a real provider response, reviewed schedule results, restart
persistence, native login/plugins and real Claude/Codex client tool calls.
Test MCP and each enabled portal with both allowed/denied identities and the
intended policy. Portal handles and old delegated authority are not carried over;
old Discord threads may need a fresh conversation. Update native/MCP/desktop
clients with the new private credentials even if their host ports are unchanged.

Keep the source and private archive after acceptance. To roll back, stop only
the new instance, then start only the original recorded services. Never run two
copies of the same Discord/Slack bot. Token refresh can require signing in again;
do not downgrade a new native database over an old home. Deleting either home
or restoring archives over live data is a separate, path-specific user decision.

Unit contract tests: `node --test scripts/migrate-to-fhold.test.mjs`. These check
selection/safety and public command arguments, not live provider/portal readiness.
Qualify an actual transfer with packaged CLIs and exact images on disposable
homes before using the script with real data.

The opt-in native test creates both homes through the actual released CLIs,
imports synthetic conversations through OpenCode, runs this utility, starts the
new stack, refreshes plugins with standard vendor commands and verifies history
through the authenticated API before and after restart. It retains fixtures and
stops only the generated instances. It never reads real provider/native accounts.
Node.js 22.13+ with the built-in SQLite module is required for this test.

```bash
OP_MIGRATION_E2E_CLI=/path/to/released/openpalm-cli \
FH_MIGRATION_E2E_CLI=/path/to/released/fhold-cli \
OP_MIGRATION_E2E_IMAGE=openpalm/assistant:0.14.0-beta.1 \
  node --test scripts/migrate-to-fhold.e2e.test.mjs
```

The old CLI must select the specified old image through its normal release
configuration; build/install matching source images first. Docker must have free
default network subnets and host ports. Do not patch the image, fake state or
add test-only runtime configuration to bypass a failed prerequisite. Without
the three explicit variables this live qualification is skipped, not claimed
as a passing integration test.

The full test passed on October 6 on Linux x64 with OpenPalm `0.14.0-beta.1`, the
publicly released fhold `0.1.2610060849-beta.1` CLI and matching Docker Hub images,
and Node.js 24.18.0.
Both images used native OpenCode 1.18.34. It verified project-specific discovery
and transcript counts before and after restart, standard plugin refresh,
fresh keys, preserved policies and mappings, disabled imported schedules,
authentication denials, and interrupted history without replay. This synthetic
qualification does not substitute for the real provider, account and portal
acceptance checks above.
