# f/hold rebranding implementation guide

The selected new name is **f/hold**, a fwdslsh product. This guide defines its
name variants and the changes needed to rebrand OpenPalm while preserving
working installations. The name was selected on October 1, 2026; the runtime
rename and distribution changes have not shipped. Current release commands
and downloads still use OpenPalm.

## Selected naming contract

| Context | Selected form | Usage |
|---|---|---|
| Primary visual identity | **f/hold** | Wordmark, website masthead and in-app brand mark |
| Plain text and accessibility | **fHold** | Product prose, window titles, app listings and spoken-label text |
| Technical identifiers | `fhold` | New executable, package, repository and artifact names; never put the slash in a filesystem name |
| Compact secondary mark | **/hold** | Only where the fwdslsh parent brand is already explicit; not a standalone command or package |

Pronounce the name **“eff hold.”** The descriptor is **“A home for your personal
AI.”** Use **fwdslsh fHold** when parent-brand attribution is helpful. Fold,
Manyfold and `f.hold` are not additional product spellings. Existing
compatibility identifiers are exceptions to the technical slug, not variants
of the new brand.

The recommended boundary is to rename the public product and its distribution
identity, but preserve existing data and protocol identifiers unless a separate
breaking change has a concrete benefit. A new display name does not require a
new database, environment-variable vocabulary, or access-control scheme.

The [market review and selection record](../research/product-name-market-review-2026-10-01.md)
records the decision and earlier alternatives. Name selection is not trademark
clearance or reservation of a package, domain or registry namespace.

## Distribution decisions still needed

The display name and technical slug are settled. Confirm the remaining
distribution choices before editing manifests or publishing:

| Decision | Suggested approach |
|---|---|
| Display name and slug | Selected: f/hold wordmark, fHold plain text, `fhold` technical slug |
| Public repository | Target repository slug `fhold`; owner and rename versus independent fork remain undecided |
| npm package and executable | Target command `fhold`; verify ownership/availability of the proposed `fhold` npm package before publication, or choose an approved scoped package with the same command |
| Container registry | Choose the actual approved registry and owner; retain Assistant, Guardian, and Portal component names |
| Release version | Use a new release, never rename or overwrite existing release assets |
| Existing installations | Prefer managing the same explicit `OP_HOME`, project, keys, and state schema |
| New-install default home | Retain `~/.openpalm` initially; users can select another explicit `OP_HOME`, without adding a second home-resolution scheme |
| Desktop identity | Preserve it for a branding-only update, or explicitly handle preferences when shipping a distinct app |
| MCP and OAuth identifiers | Preserve existing wire identifiers initially; changing them is an integration break |

Package and registry examples in a future patch must follow the chosen owner
and registry, not a guessed naming pattern. The current Compose image shape is
`${OP_IMAGE_NAMESPACE}/assistant`, `/guardian`, and `/portal`; check that the
chosen namespace is legal for the chosen registry before changing defaults.

## Concrete rename targets

These are implementation targets, not commands or downloads available today.
Package and repository ownership must be verified before publication.

| Surface | Current name | fHold target |
|---|---|---|
| Public product | OpenPalm | f/hold wordmark; fHold in ordinary text |
| Admin display name | OpenPalm Admin | fHold Admin |
| CLI executable and bootstrap | `openpalm`, `packages/cli/bin/openpalm.js` | `fhold`, `packages/cli/bin/fhold.js` |
| Public npm package | `openpalm` | Proposed `fhold`; an approved scoped package is acceptable if unavailable |
| Workspace package scope | `@openpalm/*` | `@fhold/*`, with all imports, filters and workspace dependency references updated together |
| Repository slug | `openpalm` | `fhold`, under the separately approved owner on each host |
| Compiled CLI assets | `openpalm-cli-<platform>-<arch>[.exe]` | `fhold-cli-<platform>-<arch>[.exe]`, retaining the five existing targets |
| Admin executable | `openpalm-admin` | `fhold-admin` |
| Admin release assets | `OpenPalm-Admin-${version}-${arch}-${os}.${ext}` | `fhold-admin-${version}-${arch}-${os}.${ext}` |
| Windows Admin installer | `OpenPalm-Admin-Setup-${version}.${ext}` | `fhold-admin-setup-${version}.${ext}` |
| Claude Desktop bundle | `openpalm-claude-desktop-${version}.mcpb` | `fhold-claude-desktop-${version}.mcpb`; display name fHold, existing extension identity retained |
| Container image namespace | Current approved OpenPalm namespace | Approved registry/owner with a `fhold` product namespace; still `/assistant`, `/guardian`, `/portal` |

The intended user commands are `fhold install`, `fhold setup`, `fhold status`,
`fhold connect mcp --credential owner`, and `fhold remote enable claude` or
`codex`; only the executable name changes. Do not introduce a separate command
tree, another installer or a configurable branding layer. Until the rename
ships, runnable user guides must keep the actual `openpalm` commands.

Keep source filenames such as `docs/managing-openpalm.md` when moving them adds
no user benefit. Update their displayed titles when the runtime is rebranded,
and update links atomically if any files really move. Historical release and
migration evidence continues to name the OpenPalm version actually tested.

## Public branding and documentation

These are low-risk changes when only labels and accurately paired examples change.

| Files | Required review or change |
|---|---|
| `README.md`, `docs/README.md` | Product title, description, install commands, download links, image references, and guide index |
| `docs/installation.md`, `docs/managing-openpalm.md` | CLI commands, home defaults, service/image examples, and the name users see during setup |
| `docs/claude-desktop.md`, `docs/remote-mcp.md`, `docs/native-remote-access.md` | Extension display name and download URL; client examples; distinguish display branding from retained MCP identifiers |
| `docs/portals/discord-setup.md`, `docs/portals/slack-setup.md` | Product references and connection examples; do not rotate working bot tokens or change platform IDs for branding |
| `docs/operations/release.md`, `admin-setup-verification.md`, `migration-to-0.14.md` | Current release/install commands, artifact names, acceptance evidence and transition instructions |
| `docs/technical/core-principles.md`, `architecture.md`, `foundations.md`, `environment-and-mounts.md`, `api-spec.md` | State which identities changed and which remain stable; preserve all security and ownership contracts |
| Remaining `docs/technical/*.md`, including SSH proposal | Examples, package names and descriptions; do not present future SSH support as implemented |
| `AGENTS.md`, `.github/CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates | Current product identity and repository/support links; preserve actual authorship and security reporting routes |
| `packages/*/README.md`, `packages/skeleton/config/README.md`, `packages/skeleton/system/stack/README.md`, `containers/*/README.md`, `scripts/README.md` | Package, runtime, command, image, and developer examples |

Do not rewrite external source URLs, old release tags, historical product names,
or evidence referring to an actual older OpenPalm binary. Current command
examples must match the installed executable; a retained internal identifier
must not be described as if it were renamed.

## Setup and Admin

| Files | Required review or change |
|---|---|
| `packages/electron/admin/index.html` | f/hold brand wordmark; fHold page title, accessibility text and setup/management headings |
| `packages/electron/admin/*.js` | User-facing labels, statuses, copied connection recipes and CLI examples; inspect all modules, not only the welcome screen |
| `packages/electron/admin/admin.css` | Only styles needed for an approved wordmark/icon change; preserve the polished layout and accessibility |
| `packages/electron/assets/icon.png` | App icon if the visual identity changes; generate packaging artifacts through the existing build |
| `packages/electron/src/admin-app.ts` | BrowserWindow title, folder-picker labels, setup messages and the hard-coded extension release URL |
| `packages/electron/src/admin-main.ts` | Windows AppUserModelId, release-smoke flags/markers, and startup messages if distribution identity changes |
| `packages/electron/electron-builder.yml` | `productName: fHold Admin`, `fhold-admin` artifact/executable names above; preserve app ID initially and update the release asset checker together |
| `packages/electron/package.json` | Description, author attribution, desktop name, dependency scope and package identity as appropriate |
| `packages/electron/src/admin-domain.ts`, `admin-instances.ts` | Install messages and new-project prefix; preserve existing selected homes and persisted project identity |
| `packages/electron/src/admin-preload.ts`, `admin-types.ts`, renderer callers | `window.openpalmAdmin` and IPC/type identifiers are internal, not branding; rename only if all producers, consumers and tests move together |

Admin currently stores recent instances in `instances.json` under Electron's
`userData`. A different app name/profile can strand those preferences. For a
distinct new app, explicitly select an existing home or implement a narrowly
reviewed one-time preference transfer; never copy the entire host application
profile or authentication files. Do not silently create a replacement stack
because the old profile is no longer found.

Keep window dimensions under user control. A rebrand must not reintroduce
automatic sizing or reset deliberate instance selections.

## CLI and workspace packages

| Files | Required review or change |
|---|---|
| Root `package.json`, `packages/*/package.json`, `containers/*/tools/package.json` | Package names, descriptions, repository links, binary mapping, build artifact names and workspace dependency references |
| `packages/cli/bin/openpalm.js` -> `packages/cli/bin/fhold.js` | Bootstrap filename and bin mapping; approved release base URL, all five `fhold-cli-*` platform assets, distinct fhold cache root and messages |
| `packages/cli/src/main.ts`, `src/commands/*.ts`, `src/lib/action.ts` | Program/help name, printed commands, recipe names and statuses; do not change command behavior just for naming |
| `packages/cli/scripts/pack-embedded-assets.ts`, `src/lib/embedded-assets.ts` | Review embedded skeleton lookup/build paths; regenerate the existing embedded asset rather than hand-editing a generated archive |
| `packages/lib/src/index.ts`, imports from `@openpalm/lib` throughout packages | Change to `@fhold/lib` with the workspace-scope rename; update every producer, consumer and build filter together |
| `packages/lib/src/control-plane/foundation.ts`, `state.ts`, `seed.ts` | Home resolution, default project/image namespace, environment contract, seed locations and user messages |
| `bun.lock` | Regenerate with the locked supported Bun after manifest changes; do not manually rewrite lock metadata |

Names such as `OpenPalmState`, `createOpenPalmState`, and `resolveOpenPalmHome`
may become `FHoldState`, `createFHoldState`, and `resolveFHoldHome` during
source-level cleanup, but are not prerequisites for a user-facing rebrand.
If renamed, update exported types/functions and every import/test together.
Do not add a runtime branding registry or duplicate installer/config parser.

OpenCode, AKM, Codex, Claude Code, MCP and third-party plugin identities do not
become part of the product rename. Retain their standard installation processes
and native consent. Do not reset approved AKM definitions or disguise changed
hook definitions as previously approved ones.

Preserve versioned bootstrap caches or use a distinct cache namespace so an old
binary cannot be mistaken for the new distribution. Never delete an existing
cache or installed executable as an unreviewed cleanup step.

## Containers and managed configuration

| Files | Required review or change |
|---|---|
| `packages/skeleton/system/stack/stack.compose.yml` | Published image references and, only if explicitly chosen, managed in-container helper/mount paths; service/profile names need not change |
| `compose.dev.yml`, `scripts/dev-setup.sh`, root package scripts | Development image names, project prefixes, test/dev home names and build filters |
| `containers/assistant/Dockerfile`, `guardian/Dockerfile`, `portal/Dockerfile` | Package filters, image-baked helper names, entrypoints, PATH, WORKDIR and managed directories; coordinate with Compose and security audit |
| `containers/assistant/entrypoint.sh`, `healthcheck.sh`, `opencode-run.sh`, `containers/guardian/entrypoint.sh` | Calls to renamed helpers, environment names, health commands and paths |
| `containers/assistant/openpalm-task.mjs`, `openpalm-remote.mjs`, `openpalm-remote-setup.mjs`, `openpalm-codex-recall.mjs` | Helper names and imports only if actually renamed; pair callers, generated schedules and native remote guidance |
| `packages/lib/src/control-plane/remote.ts`, `codex-recall.ts`, CLI task implementation | Container-side helper invocation names and approval/status behavior |
| `packages/lib/src/control-plane/secret-audit.ts` | Expected image names, mounts, environment values, helper/healthcheck commands and project/network identity |
| `packages/skeleton/system/assistant/AGENTS.md`, `agents/*.md`, managed plugin/memory code | Product descriptions and helper instructions; generated schedules must call an installed helper |
| `packages/skeleton/config/assistant/persona.md`, `user-profile.md`, configuration READMEs | Seed descriptions only; do not overwrite the operator's existing persona/profile |
| `.gitignore`, `.dockerignore` | Review changed default/generated paths without exposing old ignored state, credentials or backups |

In-container `/opt/openpalm`, `/run/openpalm-credentials` and `/var/lib/openpalm`
can stay as implementation paths. If renamed, update the Docker build, mounts,
audit, healthchecks and callers atomically. Do not loosen the audit to make an
incomplete rename pass.

`state.ts` currently derives `OP_IMAGE_NAMESPACE` from the process environment
or its default when regenerating runtime inputs. A new image default therefore
needs explicit existing-instance tests; do not assume editing a Compose default
alone controls which registry an update selects.

## Persistent and protocol identifiers

These identifiers are compatibility contracts, not wordmarks. The recommended
first rebrand leaves them unchanged.

| Contract and files | What breaks if blindly renamed |
|---|---|
| `OP_HOME`, `.openpalm`; `foundation.ts`, installation scripts, Admin selection | The application may open a different empty home instead of the user's existing instance |
| Persisted `OP_PROJECT_NAME`; `state.ts`, `docker.ts`, `admin-domain.ts` | Docker Compose may create another stack/network instead of managing the existing one |
| `OP_*`, `OPENPALM_*`; `stack-config.ts`, `docker.ts`, seed code, shell helpers, bootstrap | Custom environments stop working; Docker's subprocess environment allowlist currently recognizes `OP_` |
| `op_opencode_password`, `op_guardian_handle_key`; `state.ts`, `opencode.ts`, Compose | Native authentication and Guardian handle continuity break if file/key identity is replaced |
| `openpalm-guardian-handle-v1`, key/proof derivation strings and `op1`; `packages/guardian/src/conversation.ts` | Existing encrypted handles no longer decrypt and existing ownership proofs no longer verify |
| `metadata.openpalmGuardian`; Guardian conversation and gateway code | Sessions cease to be recognized as owned by their original credential |
| `openpalm.*` tools/prompts and `openpalm://` resources; Guardian MCP and portal chat client | Saved integrations, callers and client recipes break even when discovery of new names succeeds |
| OAuth scopes/issuer/resource bindings; Guardian OAuth, operator config and clients | Existing authorization may fail; issuer/audience/resource URLs are not interchangeable branding labels |
| Extension `name: openpalm`; MCPB manifest and bridge | Claude may treat it as a different extension and require reconfiguration |
| `openpalm-memory` state and memory metadata; managed Assistant memory code | Losing capture checkpoints can cause duplicate processing or changed session classification |
| Existing schema versions, database paths, history journals and import receipts | Rebranding does not justify schema changes, lost retry safety or replacing user state |

Guardian display titles and its descriptive server name can change without
changing tool IDs, cryptographic constants or ownership metadata. The same
separation applies to the fHold MCPB display name versus its retained
`name: openpalm` extension identity. A fHold-branded client may therefore
correctly discover `openpalm.*` tools and `openpalm://` resources. Document
this explicitly rather than adding duplicate protocol aliases.

If the goal is an independent clean-slate product rather than continuity,
use an explicitly selected fresh home and the reviewed portable/native-history
recovery paths. Do not transplant an old runtime wholesale. Native recovery
does not restore old portal handles or grants. Use same-instance confirmation
only for a genuine same-owner continuation, not a merger of unrelated agents.
Keep originals and private rollback artifacts; renaming never authorizes deleting them.

## Distribution and external setup

| Files or system | Required review or change |
|---|---|
| `.github/workflows/release.yml` | GitHub repository guard, container publication/signing identity, artifact upload patterns, release title and npm publisher context |
| `.github/workflows/gates.yml`, `ci.yml` | Build tags, cache scopes, test environment labels and native-history image variable values |
| `.github/release-manifest.json` | Verify all manifests and Compose remain covered; paths need edits only if actually moved |
| `scripts/validate-release-assets.mjs` | CLI/Admin/MCPB expected filenames; checksum matching must use exact renamed artifact names |
| `scripts/setup.sh`, `setup.ps1` | GitHub release URLs, platform asset names, installed executable, messages and cache/temp names |
| `scripts/publish-bootstrap.mjs` | Hard-coded GitHub repository, release API URL and npm integrity lookup; keep verified GitHub-only trusted publishing |
| `scripts/bump-release.mjs`, `set-version.mjs` | Output branding and image-reference matching; preserve semantic-version and no-overwrite checks |
| `scripts/smoke-admin-artifact.mjs`, `smoke-image.sh`, `smoke-akm-harnesses.mjs` | Artifact/executable markers, helper paths and package references |
| `packages/claude-desktop/manifest.json`, `src/index.ts`, `scripts/build.ts`, `scripts/pack.ts` | Display text, bridge environment/identity if chosen, repository links and MCPB filename |
| `packages/electron/src/admin-app.ts`, `packages/lib/src/control-plane/connection.ts` | Extension download URLs, displayed client labels and generated recipes |
| Registry and host settings outside Git | npm ownership/trusted publisher, image permissions, GitHub settings, signing identities, domains and client/bot display names |

Gitea remains for early/private code; GitHub builds public releases. Rebranding
does not add a cross-host publisher or copy a Gitea credential into GitHub.
Keep immutable old releases downloadable for rollback. Repository redirects
are not a substitute for testing new installer URLs and publication guards.

Existing Discord/Slack IDs, portal user maps and credential policy assignments
need no rename. Operator-managed bot display names or reverse-proxy hostnames
can be changed separately after the application works. A hostname change also
requires reviewing TLS, MCP client URLs and OAuth resource/provider registration.

## Implementation sequence

1. Apply the selected f/hold naming contract and settle the remaining
   distribution decisions above. Verify namespace
   ownership/availability and obtain appropriate legal clearance separately.
2. Make a baseline inventory of the exact old home, project, images, native
   sessions, handles, credentials, portal maps and desktop preferences. Back up
   the selected instance according to the migration preservation guide.
3. Apply f/hold to visual marks and fHold to prose, titles and accessibility
   labels, preserving behavior and security identifiers. Review every actual
   setup/Admin screen and command help.
4. If distribution changes, update packages, build helpers, artifact checks,
   installers and release workflow as one consistent change. Regenerate locks
   and embedded/bundled output using the existing build process.
5. Build/test on disposable homes. Verify both a fresh install and managing an
   existing 0.14 home without moving its data or creating a duplicate project.
6. Cut a prerelease through GitHub, test the actual downloaded artifacts and
   npm bootstrap, then test a deliberate update/rollback of a named instance.
7. Change operator-managed public links/client branding only after acceptance.
   Retain an explicit record of technical identifiers intentionally unchanged.

Avoid a generic legacy-name translation layer. Either preserve a contract or
make one explicit, tested breaking transition; do not add indefinite dual
registries, automatic host scans or broad filesystem copying.

## Verification requirements

Run `bun run check`, `bun run test`, `bun run lint`, CLI build and Admin bundle.
Run `bash -n` on changed shell files and platform-specific checks on PowerShell.
Validate Compose with all three profiles and run the Guardian security suite.

Update the affected expectations in CLI `main`, bootstrap, install, operation,
connection, remote and task tests; lib state/seed/stack/Compose/audit tests;
Guardian MCP/conversation/OAuth tests; portal runtime/client tests; MCPB tests;
Admin static/domain/instance/E2E tests; and release/bootstrap/smoke tests.
Do not weaken a test merely because its old name is inconvenient.

The release acceptance matrix must establish:

- New installers and the npm bootstrap fetch the same intended release, verify
  checksums and execute the correct version on every supported target.
- Assistant, Guardian and Portal use the approved immutable images; required
  helpers, AKM integration in all supported harnesses, native remote consent
  and scheduling work.
- An existing selected home retains its project name, native sessions, provider
  auth, knowledge, authored work, paused/active schedules and policy maps.
- If wire/security identifiers are preserved, a pre-rebrand handle and ownership
  proof still work for their original principal and still fail for another.
  Fixtures must contain old literal identifiers, not ones generated solely by
  the newly edited implementation.
- MCP discovery, saved tool/resource calls, Claude Desktop and enabled portals
  work; OAuth audience/resource/scope decisions remain deliberate.
- Admin remembers or explicitly selects the correct instance, clears transient
  secrets on switching, and never changes the user's window size automatically.
- An interrupted migration/recovery remains retryable, unrelated target data
  stays intact, and rollback uses preserved originals rather than new state.

Ordinary renaming tests alone are insufficient: changing producers and consumers
in the same test can conceal broken old persisted values. Include a real old
fixture or installed prerelease in transition verification.

## Scope and effort

The earlier scan found approximately 1,600 name occurrences across 180 files,
excluding the lockfile, AGENTS instructions and changelog. This is a rough
reference count, not a count of independent engineering changes. Re-run a
tracked-file inventory before implementation:

```bash
git grep -n -i -e openpalm -e OP_HOME -e OP_PROJECT_NAME -e OP_IMAGE_NAMESPACE
git grep -l -i openpalm
```

Classify every match as display branding, distribution identity, source-only
name, historical reference, or persisted/wire contract before editing it.

Rough engineering estimates including verification: display/docs only, half to
one day; distribution rename, two to four days; complete identity change with
verified transition, four to seven days. Registry/signing/legal lead time is
separate. These are planning estimates, not a guarantee. No runtime rename or
release has been implemented by this guide. The selected name is settled;
publication ownership, release timing and rename-versus-fork are not.
