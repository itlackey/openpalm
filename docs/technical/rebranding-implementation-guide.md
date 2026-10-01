# f/hold hard fork implementation guide

fHold will be a new product in **fwdslsh/fhold**, derived from the latest
committed OpenPalm lean stack. This is a hard fork, not an OpenPalm rename,
an in-place upgrade or a compatibility distribution. The new repository
starts with the working personal-agent features and refined Admin UI, but
without OpenPalm naming, release baggage or legacy migration machinery.

This guide replaces the earlier continuity-first rebranding proposal.
It is an implementation plan; no new repository or runtime has been created.
Current OpenPalm commands and installations remain unchanged.

## Selected naming contract

| Context | Form |
|---|---|
| Primary wordmark | **f/hold** |
| Plain text, accessibility and app listings | **fHold** |
| Executable, repository, packages, files and artifacts | `fhold` |
| Secondary mark with explicit fwdslsh context | **/hold** |

Pronounce it **“eff hold.”** The descriptor is **“A home for your personal
AI.”** Fold, Manyfold, bare Hold and `f.hold` are not alternate spellings.

## Fork baseline and repository creation

At this review, the fetched `refactor/lean-stack` tip is
`56a946bd7025b2407f18dc0ee500e0fe541c86f1`. It includes Admin refinement
commit `94c6d9c700f4854af8fd27b7df5b86a9fe3312d7`
(“Simplify Admin task layout and verify rendered usability”), as well as the
earlier setup/Admin and data-preservation work. Use that lineage, not a
beta release tag or an older worktree checkout.

Immediately before creating the fork, fetch the primary lean branch again,
compare the publishing remote, and pin its latest agreed full commit SHA.
Confirm the Admin commit is an ancestor and inspect the resulting Admin tree.
If newer committed work exists, use the newer agreed tip and record it.
Do not silently include local uncommitted UI changes, generated output or
state; needed source changes must be reviewed and committed first.

The approved repository start is one new initial commit containing the
cleaned, tested source tree, with no inherited Git history. This does not
authorize rewriting or deleting OpenPalm history. Record the source repository
and exact commit in a concise provenance notice and retain the existing license
and required attribution.
Do not carry the old release tags, changelog, remote configuration or CI secrets
into a fresh-history repository.

Export only reviewed tracked source from the pinned tree into a new empty
checkout. Never copy an entire working directory: ignored homes, credentials,
local bundles, caches and build artifacts are not fork inputs. Do not modify,
move or remove existing user installations.

Repository identity is **fwdslsh/fhold**; it will be created on Gitea first with
fresh history. The first independent release targets **`0.1.0-alpha.1`**. GitHub is the
later public-release build host, not an initial publishing integration. These
decisions are approved; the repository and release have not been created.

## Product scope to carry forward

Retain the working lean product, not its historical explanations:

- One default Assistant container with OpenCode, AKM and supercronic.
- Persistent knowledge, natural-language recurring work and durable task results.
- Native provider sign-in and a real readiness request.
- Optional Guardian with authenticated MCP, credential policies and moderation.
- One optional Portal image with Discord/Slack adapters and per-user mappings.
- CLI installation and lifecycle management; optional local setup/Admin.
- Optional Claude Desktop MCPB bridge.
- Image-baked, default-off Codex and Claude Code remote workers, still experimental.
- Standard AKM integration, explicit native trust and hook approval.

Keep the latest Admin layout, progressive disclosure, welcome/instance picker,
working OpenCode links and user-controlled window sizing. Rebranding does not
justify another UI redesign or a new control plane. Keep native provider and
plugin installation processes; do not build fHold replacements for them.

## New product identifiers

There is no OpenPalm environment fallback, command alias, protocol alias,
existing-home adoption or old-handle acceptance in fHold. Change producers,
consumers, generated files, tests and release checks together.

| Surface | fHold target |
|---|---|
| CLI and bootstrap | `fhold`, `packages/cli/bin/fhold.js` |
| Public npm package | Proposed `fhold`; verify ownership/availability, otherwise use an approved fwdslsh-scoped package with the same command |
| Private workspace scope | `@fhold/*`, including `@fhold/lib` |
| Types and helpers | `FHoldState`, `createFHoldState`, `resolveFHoldHome`; no exported OpenPalm names |
| Home setting and default | `FHOLD_HOME`, default `~/.fhold` |
| Other product environment variables | `FHOLD_*`; replace both `OP_*` and `OPENPALM_*`, including subprocess allowlists |
| Compose project and images | Independent fhold-prefixed projects; `FHOLD_IMAGE_NAMESPACE` and approved fHold images |
| Container component names and profiles | Keep Assistant/Guardian/Portal and `gateway`, `discord`, `slack`; these are useful architecture, not OpenPalm branding |
| In-container product paths | `/opt/fhold`, `/run/fhold-credentials`, `/var/lib/fhold` |
| Runtime helper files and commands | `fhold-task`, `fhold-remote`, `fhold-remote-setup`, `fhold-codex-recall`, with paired filenames and callers |
| File-backed runtime secrets | `fhold_opencode_password`, `fhold_guardian_handle_key`; generate fresh keys |
| Guardian handle and proof domain | `fhold-guardian-handle-v1`, fhold-namespaced proof derivation and `fh1` handle prefix |
| Guardian session ownership metadata | `metadata.fholdGuardian` |
| MCP tools, prompts and resources | `fhold.*`, `fhold://`; regenerate all client and portal recipes |
| Product-specific OAuth identity | New fHold scopes and deployment resource/issuer bindings; no old tokens, grants or audience aliases |
| Memory capture identity | `fhold-memory` and renamed product metadata/checkpoints |
| Admin | fHold Admin, `fhold-admin`, `dev.fwdslsh.fhold.admin`, `window.fholdAdmin` |
| Admin preferences | Separate fHold userData and recent-instance list; no automatic OpenPalm profile transfer |
| MCPB | `name: fhold`, display name fHold, `fhold-claude-desktop-${version}.mcpb` |
| CLI assets | `fhold-cli-<platform>-<arch>[.exe]`, retaining the five supported targets |
| Admin assets | `fhold-admin-${version}-${arch}-${os}.${ext}`; Windows `fhold-admin-setup-${version}.${ext}` |
| Bootstrap/cache identity | Separate fhold cache and installed executable; never reuse or delete OpenPalm's cache |

Keep the useful filesystem layout under the new home: `system/`, `config/`,
`knowledge/`, `workspace/`, `state/` and `data/`. Establish fHold's own
installation identity and schema validation. Do not change a sound schema
shape merely to reset its number; do not add an OpenPalm-version branch.

Admin and CLI must refuse an OpenPalm directory as a managed fHold home,
without writing into it. A generic incompatible-directory message is enough;
do not embed an old-install detector, converter or compatibility wizard.
Fresh fHold setup generates runtime authority and requires its own approvals.
Existing OpenPalm clients must be configured anew to use fHold.

Third-party identifiers such as OpenCode, AKM, Codex, Claude Code, MCP and
vendor environment variables remain their native names. The fork changes
product identities, not standards or upstream harness configuration formats.

## File and implementation work

| Area | Required work in the new repository |
|---|---|
| Root and package manifests, `bun.lock` | Rename all workspace/package identities, bin mappings and descriptions; use fwdslsh/fhold repository/support URLs and an independent version; regenerate the lockfile |
| `packages/cli/src/`, `bin/`, build scripts | Apply fhold program/help names, bootstrap URLs, asset/cache names and renamed shared API imports; remove OpenPalm migration command wiring |
| `packages/lib/src/control-plane/` | Rename home/state/seed/Compose identities and exports; remove legacy import/version compatibility paths while preserving reusable validation, backup and lifecycle functions |
| `packages/electron/admin/`, `src/`, assets, builder config | Apply f/hold wordmark and fHold labels; rename preload API, IPC product identifiers, app/profile identity, executable and artifacts; retain committed Admin UX |
| `packages/guardian/src/` | Rename MCP vocabulary, resource schemes, ownership metadata, crypto domains and product-specific OAuth strings; retain policy/security behavior |
| `packages/portal/src/`, portal config | Use fhold MCP calls and fresh credential bindings; retain allowlists, user-map model and single Portal image |
| `packages/claude-desktop/` | New extension identity, product environment names, fwdslsh/fhold URLs and bundle name; test the native installation process |
| `containers/*/` | Rename helper filenames, imports, product paths, image labels and package filters; pair entrypoints, healthchecks and scheduler calls |
| `packages/skeleton/`, Compose and development scripts | Seed fHold-only intent, instructions and defaults; match mounts, secret paths, image namespace and security-audit expectations |
| `.github/`, release/bootstrap/smoke scripts | Set fwdslsh/fhold publication guards, artifact/image identities, signing and trusted-publisher settings; remove OpenPalm release assumptions |
| Tests, fixtures and snapshots | Rename ordinary fHold expectations; exclude OpenPalm migration-only fixtures/tests; retain security, data-preservation, scheduling and UX regressions |
| Docs, instructions and templates | Write current fHold product docs; rename files such as `managing-openpalm.md` to `managing-fhold.md` and repair links |

Make explicit paired changes rather than a blind text replacement. In
particular, package filters, helper invocations, secret audits, emitted
schedules, download validators and crypto producers/consumers must agree.
Preserve non-root execution and existing trust boundaries.

## Historical material excluded from fHold

Exclude these from the exported new-product tree, not from the existing
OpenPalm repository or users' homes:

- OpenPalm changelog, release notes, 0.13/0.14 migration guides and lab upgrade reports.
- Naming-market research, this fork plan and superseded architecture/rebranding proposals.
- OpenPalm-only importer/converter modules, CLI commands, version probes,
  history-recovery adapters and their legacy fixtures and tests.
- Backward-compatible command/env aliases, old MCP namespaces, old cryptographic
  identifiers, OpenPalm desktop profile handling and historical upgrade branches.
- Old repository/publishing URLs, tag expectations, artifact names and image defaults.
- Local instance wrappers, private credentials, deployment state and generated artifacts.

Do not remove a useful feature merely because its current implementation shares
a module with migration code. Separate reusable fHold backup/restore or native
history functionality from source-specific conversion; retain only the former
if it is part of the product. Move OpenPalm-specific tests with the converter,
not into fHold's runtime suite. Keep path-escape, conflict, atomicity and
preservation tests applicable to fHold's own operations.

The new changelog begins with fHold's first release. The new core principles,
AGENTS instructions and user docs describe the actual fHold architecture, not
why earlier OpenPalm features were retired. Rewrite any retained SSH proposal
for fHold and keep it clearly unimplemented.

The only retained OpenPalm references should be the concise provenance and
license/attribution notices needed to explain the source. Preserve actual
authorship and third-party notices; they are not runtime cruft. Do not rewrite
external source URLs to pretend upstream projects were renamed.

## Migration belongs in OpenPalm

Keep the migration script, OpenPalm-version parsing, lab recovery guides and
legacy regression fixtures on OpenPalm's current 0.14 lean branch. Do not copy
them into fHold. Refining that tool for fHold transfer is a separate change,
not part of creating the clean fork.

The intended workflow is a fresh fHold installation followed by an explicit
transfer of selected user content. The source-side tool may prepare a private,
versioned neutral export or perform reviewed transfer through fHold's ordinary
file/native restore interfaces. If an interface is needed, fHold implements
its own generic restore contract, not an OpenPalm importer. Do not invent a
second archive/restore framework just to rename the product.

| Category | Transfer boundary |
|---|---|
| Authored knowledge and workspace | Preview paths/counts, validate containment, preserve authored files and report omissions; omit generated dependency trees |
| Native conversation history | Source-side consistent export with WAL coverage and target-compatible native import; explicit workspace mapping, collision checks and stripped old authority |
| Persona/profile and safe preferences | Review content and translate only supported settings; do not copy managed runtime configuration |
| Tasks | Transfer reviewed definitions inactive; generate fhold helper references and require explicit activation |
| Provider credentials and private environment | Explicit opt-in and contained private files only; fresh sign-in remains the normal path |
| Portal assignments and access policies | Review mappings and map them to newly created fHold identities; never copy bearer keys or silently reactivate access |
| Runtime state, images, Docker intent, hooks and OAuth grants | Regenerate in fHold; do not transplant `system/`, `state/`, `data/`, Compose or old trust decisions |

Migration is not complete merely because knowledge files copied. The source
tool must account for native history, external work, symlinks and referenced
artifacts, with a receipt showing restored, privately preserved, pending and
excluded categories. Preserve existing target content and support safe retry.
No old Guardian/portal handle continuity is promised. Originals and private
rollback archives remain untouched; deleting them needs separate path-specific
approval. An unresolved transfer never justifies opening the old home directly
with fHold.

## Implementation sequence

1. Use the approved Gitea-first, fresh-history plan and `0.1.0-alpha.1` release
   target. Fetch/pin the latest committed lean tip and verify the Admin refinement.
2. Export reviewed tracked source to a new empty checkout. Exclude historical
   material, preserve licensing/provenance, and keep the source repository intact.
3. Apply all fHold identities, independent home handling and fresh runtime
   credentials. Remove OpenPalm-only migration code and aliases.
4. Rewrite product docs, manifests, release pipeline and all emitted client
   settings together; regenerate locks, embedded assets and packaged output.
5. Run clean-room verification on disposable fHold homes, including real
   installer/Admin, Assistant, scheduling, AKM, MCP and supported portals.
6. Establish the separate repository and publication accounts. Cut the first
   fHold prerelease only after the new artifacts pass acceptance.
7. Separately refine the source-side migration tool and verify an explicit
   OpenPalm-to-fHold transfer without modifying or adopting the source home.

Gitea remains for early/private work. GitHub builds public releases under
fwdslsh/fhold. No cross-host publishing bridge, copied CI credential or Gitea
token in GitHub is part of this fork.

## Acceptance gates

Run `bun run check`, `bun run test`, `bun run lint`, CLI build and Admin
bundle. Validate Compose with all three profiles; check changed Bash/PowerShell
entrypoints and run Guardian security and release-artifact checks.

Acceptance requires:

- A new user installs and sets up fHold without OpenPalm installed, old images,
  cached binaries, files or configuration.
- Default storage is `~/.fhold`; only `FHOLD_HOME` controls product home intent.
  An explicitly selected incompatible home is refused without mutation.
- OpenPalm and fHold can run separately with distinct homes/projects and
  explicit available ports; neither updates the other's images, state or keys.
- Every executable, image, downloaded asset, package reference, MCPB identity,
  emitted recipe and product API name belongs to fHold.
- Guardian authentication, ownership, moderation, path containment and
  credential scoping remain intact under the new identifiers. No old identity,
  handle or OAuth alias is accepted.
- Provider readiness, knowledge persistence, recurring results and AKM
  integration work in the supported harnesses. Codex/Claude remain experimental
  and require their own consent; defaults and failures do not disrupt Assistant.
- Setup/Admin retains the refined baseline, welcome selection, understandable
  connection details and accessibility, and never automatically resizes windows.
- The new tree has no OpenPalm migration/version adapters or historical product
  docs. Remaining old-name matches are limited to reviewed attribution/provenance.
- GitHub installer/release URLs, checksums, npm trusted publication, signed
  images and all five CLI targets are tested against actual fHold artifacts.

For the separate migration tool, verify source immutability, target preservation,
consistent history, content/count checks, task inactivity, credential opt-in,
interrupted retry and explicit omissions. Keep that suite on OpenPalm's branch.

Do not weaken meaningful tests to make the fork pass. Review tracked-name
matches and file paths after implementation, including `openpalm`,
`OpenPalm`, `OPENPALM_`, `OP_HOME`, `OP_PROJECT_NAME`, `OP_IMAGE_NAMESPACE`,
old secret names and crypto constants. A string scan supplements, not replaces,
real clean-room installation and protocol testing.
