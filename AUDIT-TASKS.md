# Audit Fix Tracking

## CRITICAL

- [ ] C1. Fix `detectChannelAccess` regex to match tab-indented closing brace
- [ ] C2. Fix channel env file naming to match compose `env_file` declarations
- [ ] C3. Change channel config save restart to use `"up"` instead of `"restart"`
- [ ] C4. Fix container list: parse raw JSON string in controller response
- [ ] C5. Fix JSONC parser to handle inline comments and trailing commas

## HIGH

- [ ] H1. Validate community registry `installTarget` before use
- [ ] H2. Block `..` in `validatePluginIdentifier` for path traversal prevention
- [ ] H3. Fix `validatePluginIdentifier` to accept `plugins/` prefix (no `./`)
- [ ] H4. Add `removeExtension`/`removeChannel` to SetupManager; call on uninstall
- [ ] H5. Only call `addChannel` for actual channel compose-service items
- [ ] H6. Call `setupManager.addExtension` in pluginId install path
- [ ] H7. Add `n8n`, `ollama`, `searxng` to controller's CORE_SERVICES (or EXTRA_SERVICES)
- [ ] H8. Add install handlers for `command-file`, `agent-file`, `tool-file` actions
- [ ] H9. Propagate `controllerAction` errors back to callers
- [ ] H10. Add `controller` and `openmemory-ui` to controller's ALLOWED set
- [ ] H11. Change `setAccessScope` to use `"restart"` instead of `"up"` for Caddy reload
- [ ] H12. Add Caddyfile existence guards (`existsSync`) before reads
- [ ] H13. Add auth check to `POST /admin/setup/step`
- [ ] H14. Fix opencode-core compose healthcheck port from 3000 to 4096
- [ ] H15. Make policy lint recurse into nested permission objects
- [ ] H16. Default `OPENCODE_CONFIG_PATH` to match actual config location

## MEDIUM

- [ ] M1. Add numeric range validation to `validateCron`
- [ ] M2. Require non-empty schedule in automation edit form and server
- [ ] M3. Sanitize automation name to strip newlines before crontab write
- [ ] M4. (Deferred — design decision) Debounce opencode-core restarts on automation mutations
- [ ] M5. Call `writeCrontab()` on automation store initialization
- [ ] M6. (Deferred — design decision) Add file locking to JSON store read-modify-write
- [ ] M7. Use atomic write (temp+rename) for Caddyfile modifications
- [ ] M8. Fix `DISCORD_PUBLIC_KEY` to render as `type="text"` not password
- [ ] M9. Fix `DISCORD_PUBLIC_KEY` required field to be consistent
- [ ] M10. (Deferred — requires channel health probes) Channel health badges
- [ ] M11. Add duplicate provider name check
- [ ] M12. Fix `fetchModels` to append `/v1/models` instead of `/models`
- [ ] M13. Clear env vars from `secrets.env` when provider is deleted
- [ ] M14. Allow clearing stored API keys (empty string writes)
- [ ] M15. Add step ordering enforcement in setup wizard
- [ ] M16. Warn when `setAccessScope` Caddyfile pattern match fails
- [ ] M17. Fix `formatTime` to properly parse ISO timestamps
- [ ] M18. Use atomic write in `applySmallModelToOpencodeConfig`
- [ ] M19. Create `agents/channel-intake.md` file or fix gallery reference
- [ ] M20. Auto-complete accessScope step when scope is set

## LOW

- [ ] L1-L17. Various minor issues (see AUDIT-REPORT.md)
