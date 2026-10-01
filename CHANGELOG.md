# Changelog

OpenPalm follows [Semantic Versioning](https://semver.org/). This changelog
starts at the 0.14 product boundary; older releases describe a different stack
and remain available in Git history.

## [Unreleased]

### Added

- Admin welcome screen with one-click previous/default instance access, recent
  folders, and native directory selection. Switching reloads Admin without
  stopping stacks or carrying keys, forms, sign-in steps, or restore previews
  between instances. Local operations use the selected home explicitly, and
  new Admin installs receive distinct Compose project names. Target selection
  stays separate from operation dispatch for future SSH support; SSH itself
  is not included.
- Regression coverage ensures Admin never automatically resizes its window.
  Only explicit test-harness or user/agent window actions change its size.

### Fixed

- Admin labels Guardian network settings as MCP API endpoints, explains
  credential policies and JSON health checks, and offers copyable `/mcp` and
  `/health` URLs. The trusted OpenCode address opens the browser through the
  existing desktop browser opener instead of appearing as inert text.

## [0.14.0-beta.1] - 2026-10-01

Testing prerelease of the lean personal-agent stack. Moving from 0.13 requires
a fresh installation and the previewable importer, not an in-place upgrade.

### Changed

- Both Codex and Claude Code native remote access remain experimental in
  0.14.0, with consistent Admin, CLI, and documentation labels. They remain
  optional and default-off; promotion requires a future validated release.

### Fixed

- Shared Assistant instructions distinguish chat/read restrictions from
  full-access Guardian sessions. Explicit knowledge saves and task management
  are allowed when the selected profile permits them; automatic memory capture
  remains limited to trusted local sessions, and native tool approvals remain
  required.

### Added

- Codex setup and Admin's independent knowledge-recall review offer explicit
  approval of the actual AKM commands using native hook/config APIs. Admin shows
  Installed / Approval needed / Ready, with opt-out and renewed review for
  changed definitions; no manual `/hooks` command or trust bypass is needed.
- `openpalm remote recall codex` offers the same guided review, plus read-only
  status and digest-bound explicit approval/opt-out for automation.
- Real-harness image tests verify native approval persistence, unchanged
  unrelated trust, changed-definition and stale-review rejection, and opt-out.
  Admin E2E verifies consent and approval across container recreation.

## [0.14.0-alpha.4] - 2026-10-01

### Added

- Guided `openpalm remote enable claude|codex` and Admin setup: native browser
  sign-in links, human trust/consent answers, prerequisite checks, and automatic
  startup configuration. Cancellation and failure leave remote startup off.
- Codex read-only or workspace-write sandbox choices, checked before sign-in;
  no sandbox bypass, added capabilities, or host security changes.
- Optional `openpalm setup --claude-remote --codex-remote` onboarding and
  `openpalm remote disable claude|codex` without deleting vendor account state.
- Mandatory image smoke tests run the real OpenCode, Claude Code, and Codex
  harnesses against the real AKM CLI and verify session hooks and knowledge
  recall without vendor credentials or model calls. Codex hook trust is tested
  in an isolated fixture; production hooks require explicit user approval.

### Changed

- Compact, task-first Admin setup and management, using fwdslsh's charcoal,
  green-accent, forward-slash visual identity without external fonts or assets.
- Docker readiness gates installation; stopped-agent recovery takes priority
  over account setup. Refresh feedback is quiet and does not dismiss errors.
- Native remote access lives only under Connections. Codex defaults to
  workspace-write, with sandbox choices under Advanced settings and explicit
  native consent preserved. Startup status never claims a verified connection.
- Existing AI accounts are selected first; redundant sign-in choices are hidden.
  Access identities use a flatter list with per-identity management actions.
- Mouse/programmatic focus no longer adds blue borders to controls or headings;
  keyboard focus remains visible with the brand's green accent.
- Bun 1.4.2 throughout containers/CI, Node LTS 24.21.0 in Assistant, OpenCode
  1.18.34, Codex 0.159.3, and updated locked dependencies, including Electron
  44.5.1 and TypeScript 7.0.2. Real Node takes precedence over Bun's Node shim.
- All three AKM harnesses use CLI 0.9.20 and plugin 0.9.20202610010250.
  Claude/Codex use native marketplace installers during image build, not an
  inline loader or startup installation. Generated defaults are seeded into
  persistent homes and refreshed only while untouched; user configuration,
  account state, and hook-trust decisions are preserved.

## [0.14.0-alpha.3] - 2026-09-30

### Added

- Independent, default-off native Codex (experimental) and Claude Code Remote
  Control startup switches in CLI and Admin, with native sign-in/pairing guidance.
  These are trusted workspace agents, not Guardian clients or OpenCode sessions.
- Optional remote-worker supervision, private bounded connection output, shutdown
  cleanup, and intent auditing without new services, public ports, or privileges.

### Changed

- Image-baked Codex 0.159.2, Claude Code 2.1.286, and Node 24.18.0. No vendor
  CLI installs or self-updates occur at runtime.
- AKM CLI 0.9.20 and OpenCode/Claude plugins 0.9.20202609302253, without the
  temporary CLI dependency override. Claude loads its checksum-verified,
  image-baked AKM plugin in native terminal and remote-worker environments;
  user settings remain untouched and no marketplace download is needed.

## [0.14.0-alpha.1] - 2026-09-30

This is a testing prerelease, not the stable 0.14.0 release. Live verification
and platform-specific limitations are recorded in the release documentation.

### Breaking

- OpenPalm is now a fresh-install personal-agent stack. It does not upgrade an
  older home in place. Install into an empty `OP_HOME`, then use
  `openpalm import` to preview and copy the supported user-owned data.
- The retired browser UI, compatibility APIs, voice and model services,
  discovery and VPN features, public extension graph, and legacy control plane
  have been removed.
- The supported runtime is one Assistant container plus the optional Guardian
  gateway and unified Discord/Slack Portal.

### Added

- Native OpenCode provider onboarding with a real no-tool readiness request.
- Persistent AKM knowledge and guarded recurring work with durable results.
- AKM CLI 0.9.18 and OpenCode plugin 0.9.18202609300340. Automatic personal
  memory uses the existing native provider, bounded no-tool extraction, and
  AKM storage; it can be disabled without changing provider authentication.
- Host-detected, configurable schedule timezone; supervised scheduling with
  health checks and future-only recovery after downtime.
- A dry-run-first importer for knowledge, workspace files, supported Assistant
  preferences, staged tasks, and explicitly selected secrets or portal maps.
- Policy-scoped Guardian MCP with agent sessions, jobs, interaction responses,
  bounded workspace tools, prompt screening, and fail-closed moderation.
- A shared named credential registry with `chat`, `read`, and `full` policies
  for MCP, Slack, Discord, and OAuth identities.
- Configurable trusted direct OpenCode access, loopback-bound by default.
- Optional Claude Desktop MCPB and a static local Admin utility.

### Security

- Assistant receives neither Docker control nor delegated Guardian and Portal
  credentials.
- Guardian exposes only health, OAuth discovery metadata when enabled, and
  authenticated MCP.
- Portal access is default-deny and receives only the credential subset it
  needs.
- Scheduled work uses a restricted profile and writes only to its knowledge
  inbox.
- Custom Compose settings are checked against the managed security boundary
  before lifecycle operations.

### Operations

- One managed Compose file and one operator-owned override replace the former
  overlay graph.
- The CLI is the primary installer, setup assistant, importer, credential and
  portal manager, task manager, and lifecycle interface.
- Release gates build and verify the CLI, Assistant, Guardian, Portal, Admin,
  and Claude Desktop extension from one frozen workspace lock.
- Explicit updates pull versioned images and recreate enabled containers;
  locally built images can be applied with `--no-pull`.
- GitHub Actions builds the complete release and verifies its uploaded assets
  before publication. Gitea is used only for early/private development.
- The local Admin renderer uses small task-focused modules and executable
  behavior tests, with packaged startup checks for release artifacts.
