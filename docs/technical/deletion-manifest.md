# Legacy deletion manifest

Status: **awaiting path-specific approval**.

No path in this manifest has been deleted. The active build, tests, package
exports, image COPY instructions, Compose assembly, CI, and release workflow do
not reference these candidates.

This manifest separates source-repository cleanup from cleanup of an installed
`OP_HOME`. It grants no authority to remove either. Installed homes contain
machine-specific operator data and require a separate inventory.

## Whole tracked trees

Each directory below is wholly outside the lean product:

```text
.github/roadmap/
containers/voice/
docs/reviews/
packages/portal-discord/
packages/portal-sdk/
packages/portal-slack/
packages/ui/
```

Reasons: retired Svelte/chat/Admin server, public portal SDK and split adapters,
Voice runtime, point-in-time reviews, and old roadmap material.

## Exact files in mixed active trees

The following 494 tracked files share a parent with active files, so
they are enumerated individually rather than hidden behind a wildcard.

## CLI legacy files

```text
packages/cli/src/commands/addon.ts
packages/cli/src/commands/admin.test.ts
packages/cli/src/commands/admin.ts
packages/cli/src/commands/app.test.ts
packages/cli/src/commands/app.ts
packages/cli/src/commands/audit-secrets.ts
packages/cli/src/commands/automations.test.ts
packages/cli/src/commands/automations.ts
packages/cli/src/commands/backups.test.ts
packages/cli/src/commands/backups.ts
packages/cli/src/commands/doctor.test.ts
packages/cli/src/commands/doctor.ts
packages/cli/src/commands/install-port-seed.test.ts
packages/cli/src/commands/install.test.ts
packages/cli/src/commands/install.ts
packages/cli/src/commands/logs.ts
packages/cli/src/commands/repair-ownership.test.ts
packages/cli/src/commands/repair-ownership.ts
packages/cli/src/commands/reset-password.test.ts
packages/cli/src/commands/reset-password.ts
packages/cli/src/commands/restart.ts
packages/cli/src/commands/rollback.test.ts
packages/cli/src/commands/rollback.ts
packages/cli/src/commands/scan.ts
packages/cli/src/commands/self-update.ts
packages/cli/src/commands/start.test.ts
packages/cli/src/commands/start.ts
packages/cli/src/commands/status.test.ts
packages/cli/src/commands/status.ts
packages/cli/src/commands/stop.ts
packages/cli/src/commands/ui.ts
packages/cli/src/commands/uninstall.test.ts
packages/cli/src/commands/uninstall.ts
packages/cli/src/commands/unlock.ts
packages/cli/src/commands/update.test.ts
packages/cli/src/commands/update.ts
packages/cli/src/commands/validate.ts
packages/cli/src/lib/browser.test.ts
packages/cli/src/lib/browser.ts
packages/cli/src/lib/cli-compose.test.ts
packages/cli/src/lib/cli-compose.ts
packages/cli/src/lib/cli-state.test.ts
packages/cli/src/lib/cli-state.ts
packages/cli/src/lib/embedded-archives.d.ts
packages/cli/src/lib/embedded-assets.test.ts
packages/cli/src/lib/embedded-assets.ts
packages/cli/src/lib/github.test.ts
packages/cli/src/lib/github.ts
packages/cli/src/lib/host-info.test.ts
packages/cli/src/lib/host-info.ts
packages/cli/src/lib/mock-openpalm-lib.ts
packages/cli/src/lib/output-format.test.ts
packages/cli/src/lib/output-format.ts
packages/cli/src/lib/paths.ts
packages/cli/src/lib/ports.test.ts
packages/cli/src/lib/ports.ts
packages/cli/src/lib/prompt.ts
packages/cli/src/lib/ui-server.test.ts
packages/cli/src/lib/ui-server.ts
packages/cli/src/main.test.ts
packages/cli/src/main.ts
```

## Library legacy files

```text
packages/lib/src/control-plane/access-apply.test.ts
packages/lib/src/control-plane/access-apply.ts
packages/lib/src/control-plane/access-status.test.ts
packages/lib/src/control-plane/access-status.ts
packages/lib/src/control-plane/access-toggles.test.ts
packages/lib/src/control-plane/access-toggles.ts
packages/lib/src/control-plane/activation-paths.test.ts
packages/lib/src/control-plane/activation.ts
packages/lib/src/control-plane/addon-availability.ts
packages/lib/src/control-plane/addon-env-schemas.ts
packages/lib/src/control-plane/addon-ids.test.ts
packages/lib/src/control-plane/addon-ids.ts
packages/lib/src/control-plane/addon-network-boundary.test.ts
packages/lib/src/control-plane/addons.test.ts
packages/lib/src/control-plane/addons.ts
packages/lib/src/control-plane/akm-db-journal.test.ts
packages/lib/src/control-plane/akm-db-journal.ts
packages/lib/src/control-plane/akm-endpoints.ts
packages/lib/src/control-plane/akm-migrate-boot.test.ts
packages/lib/src/control-plane/akm-sources.test.ts
packages/lib/src/control-plane/akm-sources.ts
packages/lib/src/control-plane/akm-stats.test.ts
packages/lib/src/control-plane/akm-stats.ts
packages/lib/src/control-plane/akm-user-env.test.ts
packages/lib/src/control-plane/akm-user-env.ts
packages/lib/src/control-plane/apply-stack-di.test.ts
packages/lib/src/control-plane/apply-validation.test.ts
packages/lib/src/control-plane/assistant-akm.ts
packages/lib/src/control-plane/assistant-endpoint.test.ts
packages/lib/src/control-plane/assistant-endpoint.ts
packages/lib/src/control-plane/auth-json-inode.test.ts
packages/lib/src/control-plane/backup-prune.test.ts
packages/lib/src/control-plane/backup-space.test.ts
packages/lib/src/control-plane/backup.test.ts
packages/lib/src/control-plane/backup.ts
packages/lib/src/control-plane/bind-warning.test.ts
packages/lib/src/control-plane/bind-warning.ts
packages/lib/src/control-plane/cli-version-skew.test.ts
packages/lib/src/control-plane/compose-args.test.ts
packages/lib/src/control-plane/compose-args.ts
packages/lib/src/control-plane/compose-contract.test.ts
packages/lib/src/control-plane/compose-errors.test.ts
packages/lib/src/control-plane/compose-errors.ts
packages/lib/src/control-plane/compose-mount-basename.test.ts
packages/lib/src/control-plane/compose-services.test.ts
packages/lib/src/control-plane/compose-services.ts
packages/lib/src/control-plane/config-persistence-access-intent.test.ts
packages/lib/src/control-plane/config-persistence-bind-migration.test.ts
packages/lib/src/control-plane/config-persistence-host-port-defaults.test.ts
packages/lib/src/control-plane/config-persistence-operator-ids.test.ts
packages/lib/src/control-plane/config-persistence-port-migration.test.ts
packages/lib/src/control-plane/config-persistence.ts
packages/lib/src/control-plane/core-assets.test.ts
packages/lib/src/control-plane/core-assets.ts
packages/lib/src/control-plane/create-state-purity.test.ts
packages/lib/src/control-plane/crypto.ts
packages/lib/src/control-plane/defaults.ts
packages/lib/src/control-plane/deploy-collision-message.test.ts
packages/lib/src/control-plane/deploy-interim-poll.test.ts
packages/lib/src/control-plane/deploy-journal.test.ts
packages/lib/src/control-plane/deploy-phase-contract.test.ts
packages/lib/src/control-plane/deploy-volume-reap.test.ts
packages/lib/src/control-plane/deploy.ts
packages/lib/src/control-plane/deployment-scenarios.test.ts
packages/lib/src/control-plane/discover-bind-mounts.test.ts
packages/lib/src/control-plane/disk-headroom.test.ts
packages/lib/src/control-plane/disk-headroom.ts
packages/lib/src/control-plane/docker-spawn-boundary.test.ts
packages/lib/src/control-plane/docker.test.ts
packages/lib/src/control-plane/docker.ts
packages/lib/src/control-plane/env-grammar-parity.test.ts
packages/lib/src/control-plane/env.test.ts
packages/lib/src/control-plane/env.ts
packages/lib/src/control-plane/errors.test.ts
packages/lib/src/control-plane/errors.ts
packages/lib/src/control-plane/extends-support.test.ts
packages/lib/src/control-plane/fallback-system-env.ts
packages/lib/src/control-plane/format-bytes.ts
packages/lib/src/control-plane/fs-atomic-writers.test.ts
packages/lib/src/control-plane/fs-atomic.ts
packages/lib/src/control-plane/guardian-api-overlay.test.ts
packages/lib/src/control-plane/guardian-gating.test.ts
packages/lib/src/control-plane/guardian-reconcile.test.ts
packages/lib/src/control-plane/guardian-reconcile.ts
packages/lib/src/control-plane/guardian-required.test.ts
packages/lib/src/control-plane/guardian-required.ts
packages/lib/src/control-plane/guardian-rootless.test.ts
packages/lib/src/control-plane/hardware-detect.ts
packages/lib/src/control-plane/harness-parity.test.ts
packages/lib/src/control-plane/healthcheck-parity.test.ts
packages/lib/src/control-plane/home-schema.test.ts
packages/lib/src/control-plane/home-schema.ts
packages/lib/src/control-plane/home-version-skew-lifecycle.test.ts
packages/lib/src/control-plane/home-version-skew.test.ts
packages/lib/src/control-plane/home.layout.test.ts
packages/lib/src/control-plane/home.ts
packages/lib/src/control-plane/host-akm-sharing.test.ts
packages/lib/src/control-plane/host-akm-sharing.ts
packages/lib/src/control-plane/host-identity.test.ts
packages/lib/src/control-plane/host-identity.ts
packages/lib/src/control-plane/host-opencode.test.ts
packages/lib/src/control-plane/host-opencode.ts
packages/lib/src/control-plane/image-baked-contract.test.ts
packages/lib/src/control-plane/image-content-reduction.test.ts
packages/lib/src/control-plane/image-snapshots.test.ts
packages/lib/src/control-plane/image-snapshots.ts
packages/lib/src/control-plane/image-volume-retention.test.ts
packages/lib/src/control-plane/image-volume-retention.ts
packages/lib/src/control-plane/install-edge-cases.test.ts
packages/lib/src/control-plane/install-lock.test.ts
packages/lib/src/control-plane/install-lock.ts
packages/lib/src/control-plane/instructions-resolve.test.ts
packages/lib/src/control-plane/lan-urls.test.ts
packages/lib/src/control-plane/lan-urls.ts
packages/lib/src/control-plane/launch-home-assets.test.ts
packages/lib/src/control-plane/launch-status.test.ts
packages/lib/src/control-plane/launch-status.ts
packages/lib/src/control-plane/lifecycle-host-port-defaults.test.ts
packages/lib/src/control-plane/lifecycle-install-ownership.test.ts
packages/lib/src/control-plane/lifecycle-overlay-guard.test.ts
packages/lib/src/control-plane/lifecycle-rollback-pin.test.ts
packages/lib/src/control-plane/lifecycle-update.test.ts
packages/lib/src/control-plane/lifecycle-volume-reap.test.ts
packages/lib/src/control-plane/lifecycle.ts
packages/lib/src/control-plane/markdown-task.ts
packages/lib/src/control-plane/mdns-responder.test.ts
packages/lib/src/control-plane/mdns-responder.ts
packages/lib/src/control-plane/model-runner.test.ts
packages/lib/src/control-plane/model-runner.ts
packages/lib/src/control-plane/net-interfaces.ts
packages/lib/src/control-plane/network-contract.test.ts
packages/lib/src/control-plane/network-contract.ts
packages/lib/src/control-plane/network-partitioning.test.ts
packages/lib/src/control-plane/opencode-auth.ts
packages/lib/src/control-plane/opencode-client.test.ts
packages/lib/src/control-plane/opencode-client.ts
packages/lib/src/control-plane/opencode-db-maintenance.test.ts
packages/lib/src/control-plane/opencode-db-maintenance.ts
packages/lib/src/control-plane/openpalm-helper-script.test.ts
packages/lib/src/control-plane/openpalm-helper-script.ts
packages/lib/src/control-plane/operator-ids.test.ts
packages/lib/src/control-plane/operator-ids.ts
packages/lib/src/control-plane/overlay-deprecations.test.ts
packages/lib/src/control-plane/overlay-deprecations.ts
packages/lib/src/control-plane/ownership-reconcile.test.ts
packages/lib/src/control-plane/ownership-reconcile.ts
packages/lib/src/control-plane/pairing.test.ts
packages/lib/src/control-plane/pairing.ts
packages/lib/src/control-plane/paperclip-compose-contract.test.ts
packages/lib/src/control-plane/paperclip.test.ts
packages/lib/src/control-plane/paperclip.ts
packages/lib/src/control-plane/paths.ts
packages/lib/src/control-plane/port-probe.test.ts
packages/lib/src/control-plane/port-probe.ts
packages/lib/src/control-plane/portal-rootless.test.ts
packages/lib/src/control-plane/portal-secret-contract.test.ts
packages/lib/src/control-plane/portals.test.ts
packages/lib/src/control-plane/portals.ts
packages/lib/src/control-plane/pre-mutation-refusal.test.ts
packages/lib/src/control-plane/profile-ids.ts
packages/lib/src/control-plane/project-rename.test.ts
packages/lib/src/control-plane/project-rename.ts
packages/lib/src/control-plane/provider-import.test.ts
packages/lib/src/control-plane/provider-import.ts
packages/lib/src/control-plane/provider-models.ts
packages/lib/src/control-plane/remote-access.test.ts
packages/lib/src/control-plane/remote-access.ts
packages/lib/src/control-plane/remote-addon-registry.test.ts
packages/lib/src/control-plane/remote-apply.test.ts
packages/lib/src/control-plane/remote-apply.ts
packages/lib/src/control-plane/remote-compose.test.ts
packages/lib/src/control-plane/remote-provider-apply.test.ts
packages/lib/src/control-plane/remote-provider-apply.ts
packages/lib/src/control-plane/remote-provider-status.test.ts
packages/lib/src/control-plane/remote-provider-status.ts
packages/lib/src/control-plane/remote-providers.test.ts
packages/lib/src/control-plane/remote-providers.ts
packages/lib/src/control-plane/require-existing-install.test.ts
packages/lib/src/control-plane/rollback-recovery-marker.test.ts
packages/lib/src/control-plane/rollback.test.ts
packages/lib/src/control-plane/rollback.ts
packages/lib/src/control-plane/route-canonical-helpers.test.ts
packages/lib/src/control-plane/scheduler.ts
packages/lib/src/control-plane/secret-audit.test.ts
packages/lib/src/control-plane/secret-audit.ts
packages/lib/src/control-plane/secret-strip-notice.test.ts
packages/lib/src/control-plane/secrets-files.test.ts
packages/lib/src/control-plane/secrets-files.ts
packages/lib/src/control-plane/secrets-migration.test.ts
packages/lib/src/control-plane/secrets-migration.ts
packages/lib/src/control-plane/secrets.test.ts
packages/lib/src/control-plane/secrets.ts
packages/lib/src/control-plane/seeded-skill-hashes.ts
packages/lib/src/control-plane/setup-recommendation.test.ts
packages/lib/src/control-plane/setup-recommendation.ts
packages/lib/src/control-plane/setup-status.test.ts
packages/lib/src/control-plane/setup-status.ts
packages/lib/src/control-plane/setup-validation.ts
packages/lib/src/control-plane/setup.test.ts
packages/lib/src/control-plane/setup.ts
packages/lib/src/control-plane/skeleton-guardrail.test.ts
packages/lib/src/control-plane/sqlite-driver.test.ts
packages/lib/src/control-plane/sqlite-driver.ts
packages/lib/src/control-plane/storage-report.test.ts
packages/lib/src/control-plane/storage-report.ts
packages/lib/src/control-plane/task-files.test.ts
packages/lib/src/control-plane/task-files.ts
packages/lib/src/control-plane/task-last-run.test.ts
packages/lib/src/control-plane/task-last-run.ts
packages/lib/src/control-plane/types.ts
packages/lib/src/control-plane/ui-assets.test.ts
packages/lib/src/control-plane/ui-assets.ts
packages/lib/src/control-plane/ui-origin-env.test.ts
packages/lib/src/control-plane/ui-runtime-config-schema.ts
packages/lib/src/control-plane/ui-runtime-config.test.ts
packages/lib/src/control-plane/ui-runtime-config.ts
packages/lib/src/control-plane/ui-supervisor.test.ts
packages/lib/src/control-plane/ui-supervisor.ts
packages/lib/src/control-plane/url-normalize.test.ts
packages/lib/src/control-plane/url-normalize.ts
packages/lib/src/control-plane/validate.test.ts
packages/lib/src/control-plane/validate.ts
packages/lib/src/control-plane/versioning.test.ts
packages/lib/src/control-plane/versioning.ts
packages/lib/src/control-plane/versions.test.ts
packages/lib/src/control-plane/versions.ts
packages/lib/src/control-plane/voice-host-probes.ts
packages/lib/src/control-plane/voice-lan-access.test.ts
packages/lib/src/control-plane/volume-ownership.test.ts
packages/lib/src/control-plane/volume-ownership.ts
packages/lib/src/control-plane/workspace-loopback-overlay.test.ts
packages/lib/src/index.ts
packages/lib/src/logger.test.ts
packages/lib/src/logger.ts
packages/lib/src/pairing.test.ts
packages/lib/src/pairing.ts
packages/lib/src/provider-constants.ts
```

## Guardian legacy files

```text
packages/guardian/src/admin.test.ts
packages/guardian/src/admin.ts
packages/guardian/src/assistant-client.ts
packages/guardian/src/audit.ts
packages/guardian/src/auth.test.ts
packages/guardian/src/auth.ts
packages/guardian/src/config.test.ts
packages/guardian/src/config.ts
packages/guardian/src/content-screen.test.ts
packages/guardian/src/content-screen.ts
packages/guardian/src/event-fanout.ts
packages/guardian/src/index.ts
packages/guardian/src/mcp.ts
packages/guardian/src/moderation.test.ts
packages/guardian/src/moderation.ts
packages/guardian/src/oc-path.test.ts
packages/guardian/src/oc-path.ts
packages/guardian/src/openai-api-oc-client.ts
packages/guardian/src/openai-api-oc-events.ts
packages/guardian/src/openai-api-permissions-shared.ts
packages/guardian/src/openai-api-permissions.test.ts
packages/guardian/src/openai-api-permissions.ts
packages/guardian/src/openai-api-secret-file.ts
packages/guardian/src/openai-api-server.ts
packages/guardian/src/openai-api-stream.test.ts
packages/guardian/src/openai-api-stream.ts
packages/guardian/src/openai-api-utils.ts
packages/guardian/src/openai-api.test.ts
packages/guardian/src/openai-api.ts
packages/guardian/src/ownership.ts
packages/guardian/src/proxy-rewrite.test.ts
packages/guardian/src/proxy-touch.test.ts
packages/guardian/src/proxy.ts
packages/guardian/src/reconciliation.test.ts
packages/guardian/src/reconciliation.ts
packages/guardian/src/server.ts
packages/guardian/src/sse.test.ts
packages/guardian/src/sse.ts
packages/guardian/src/state-db.test.ts
packages/guardian/src/state-db.ts
packages/guardian/src/transport.ts
```

## Admin legacy files

```text
packages/electron/assets/entitlements.mac.plist
packages/electron/assets/splash.html
packages/electron/assets/tray-icon.png
packages/electron/electron-builder.yml
packages/electron/src/assets.ts
packages/electron/src/launch-on-login.ts
packages/electron/src/main.ts
packages/electron/src/permissions.ts
packages/electron/src/preload.ts
packages/electron/src/process-tree.ts
packages/electron/src/settings.ts
packages/electron/src/splash.ts
packages/electron/src/tray.ts
packages/electron/src/ui-port.ts
packages/electron/src/updater.ts
packages/electron/test/deploy-quit-guard.test.ts
packages/electron/test/initial-url.test.ts
packages/electron/test/main.test.ts
packages/electron/test/permissions.test.ts
packages/electron/test/repo-hygiene.test.ts
packages/electron/test/settings.test.ts
packages/electron/test/single-instance-lock.test.ts
packages/electron/test/tray.test.ts
packages/electron/test/updater-quit-install-guard.test.ts
packages/electron/test/updater.test.ts
packages/electron/test/version-flag.test.ts
packages/electron/vitest.config.ts
```

## Skeleton legacy files

```text
packages/skeleton/config/akm/.gitkeep
packages/skeleton/config/assistant/persona.md
packages/skeleton/config/assistant/tui.json
packages/skeleton/config/assistant/user-profile.md
packages/skeleton/config/guardian/.gitkeep
packages/skeleton/config/paperclip/akm/config.json
packages/skeleton/config/paperclip/opencode/opencode.json
packages/skeleton/data/akm/cache/.gitkeep
packages/skeleton/data/akm/data/.gitkeep
packages/skeleton/data/assistant/.cache/.gitkeep
packages/skeleton/data/assistant/.gitkeep
packages/skeleton/data/assistant/.local/bin/.gitkeep
packages/skeleton/data/assistant/.local/share/opencode/.gitkeep
packages/skeleton/data/assistant/.local/state/opencode/.gitkeep
packages/skeleton/data/backups/.gitkeep
packages/skeleton/data/guardian/.gitkeep
packages/skeleton/data/logs/.gitkeep
packages/skeleton/data/paperclip-akm/cache/.gitkeep
packages/skeleton/data/paperclip-akm/data/.gitkeep
packages/skeleton/data/portal/.gitkeep
packages/skeleton/data/rollback/.gitkeep
packages/skeleton/knowledge/secrets/.gitkeep
packages/skeleton/knowledge/tasks/akm-improve.yml
packages/skeleton/knowledge/tasks/assistant-daily-briefing.yml
packages/skeleton/knowledge/tasks/prompt-assistant.yml
packages/skeleton/knowledge/tasks/session-maintenance.yml
packages/skeleton/openpalm.ps1
packages/skeleton/openpalm.sh
packages/skeleton/system/assistant/instructions/conversation.md
packages/skeleton/system/assistant/instructions/core.md
packages/skeleton/system/assistant/instructions/system.md
packages/skeleton/system/assistant/themes/mercury.json
packages/skeleton/system/assistant/themes/openpalm.json
packages/skeleton/system/paperclip/.gitignore
packages/skeleton/system/paperclip/bin/bun
packages/skeleton/system/paperclip/bin/opencode
packages/skeleton/system/paperclip/opencode.json
packages/skeleton/system/paperclip/package.json
packages/skeleton/system/paperclip/plugins/akm.ts
packages/skeleton/system/paperclip/security.md
packages/skeleton/system/skills/config-diagnostics/SKILL.md
packages/skeleton/system/skills/install-optional-tool/SKILL.md
packages/skeleton/system/skills/install-optional-tool/scripts/install-tool.sh
packages/skeleton/system/skills/install-optional-tool/tools.json
packages/skeleton/system/skills/notify/SKILL.md
packages/skeleton/system/skills/notify/examples/apprise.conf
packages/skeleton/system/skills/notify/examples/apprise.yaml
packages/skeleton/system/skills/notify/examples/usage.md
packages/skeleton/system/skills/notify/scripts/notify.sh
packages/skeleton/system/stack/core.compose.yml
packages/skeleton/system/stack/guardian.compose.api.yml
packages/skeleton/system/stack/portals.compose.yml
packages/skeleton/system/stack/services.compose.yml
packages/skeleton/system/stack/voice.compose.cdi.yml
packages/skeleton/system/stack/voice.compose.lan.yml
packages/skeleton/system/stack/voice.compose.rootless.yml
packages/skeleton/system/stack/workspace.compose.loopback.yml
packages/skeleton/workspace/.gitkeep
```

## Container legacy files

```text
containers/assistant/AGENTS.md
containers/assistant/Dockerfile
containers/assistant/Dockerfile.models
containers/assistant/entrypoint.sh
containers/assistant/workspace.package.json
containers/guardian/entrypoint.sh
containers/portal/portal-entrypoint.ts
containers/portal/start.sh
containers/portal/start.test.ts
containers/portal/workspace.package.json
```

## Script legacy files

```text
scripts/akm-pin-integration-smoke.sh
scripts/cross-uid-smoke.sh
scripts/dev-e2e-test.sh
scripts/dev-e2e-test.test.ts
scripts/guardian-image-offline-smoke.sh
scripts/load-test-env.sh
scripts/multi-instance-smoke.sh
scripts/release.sh
scripts/rootless-host-swap-smoke.sh
scripts/rootless-ownership-smoke.sh
scripts/rootless-smoke-fixture.sh
scripts/setup-sh-latest-resolver.test.ts
scripts/test-tier.sh
scripts/upgrade-path-smoke.sh
scripts/validate-rootless-guardrails.sh
scripts/validate-updater-feed.mjs
scripts/validate-updater-feed.test.ts
```

## Documentation legacy files

```text
docs/backup-restore.md
docs/how-it-works.md
docs/operations/diagnostic-playbook.md
docs/operations/manual-compose-runbook.md
docs/operations/manual-headless-install.md
docs/operations/manual-tailscale-paperclip-testing.md
docs/operations/persistent-assistant-tools.md
docs/operations/secrets-env-migration.md
docs/operations/upgrade-0.10-to-0.11.md
docs/operations/upgrade-0.12-to-0.13.md
docs/operations/upgrade-hardening-plan.md
docs/password-management.md
docs/portals/community-portals.md
docs/providers.json
docs/remote-access-tls.md
docs/setup-guide.md
docs/system-requirements.md
docs/technical/adding-an-addon.md
docs/technical/artifact-delivery-pattern.md
docs/technical/bunjs-rules.md
docs/technical/code-quality-principles.md
docs/technical/design-intent.md
docs/technical/multi-endpoint-session-ux.md
docs/technical/network-partitioning-d5a.md
docs/technical/opencode-behavior-notes.md
docs/technical/openpalm-opencode-boundary.md
docs/technical/paperclip-addon-design.md
docs/technical/portal-rich-ux-design.md
docs/technical/registry.md
docs/technical/remote-provider-contract.md
docs/technical/sveltekit-rules.md
docs/technical/ui-design-rubric.md
docs/technical/ui-route-map.md
docs/technical/ui-styling-unification.md
docs/technical/voice-container-build.md
docs/technical/voice-settings-architecture.md
docs/theming.md
docs/troubleshooting.md
```

## Retired workflows and analysis config

```text
.github/workflows/publish-assistant-models.yml
.github/workflows/publish-extensions.yml
.github/workflows/publish-voice-models.yml
.github/workflows/publish-voice.yml
fta.json
```

## Approval and execution rule

Approval must name each whole-tree path and each exact mixed-tree file intended
for removal. Before executing an approved cleanup:

1. verify the branch and a clean backup/commit;
2. re-run the active tests and reference scan;
3. remove only approved tracked paths;
4. do not touch ignored or untracked paths such as `.dev*`, `.private`,
   `.env*`, `knowledge`, `state`, `data`, backups, or credentials; and
5. review the resulting diff before committing.

Git history can recover these tracked repository paths. It is not a substitute
for backing up an installed home.
