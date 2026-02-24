# Versioning & Releases (v0.3.0)

## Source of truth
| Target | Version source |
|---|---|
| Platform tag (`vX.Y.Z`) | `/package.json` |
| `admin` | `/core/admin/package.json` |
| `assistant` | `/core/assistant/package.json` |
| `gateway` | `/core/gateway/package.json` |
| `channel-chat` | `/channels/chat/package.json` |
| `channel-discord` | `/channels/discord/package.json` |
| `channel-telegram` | `/channels/telegram/package.json` |
| `channel-voice` | `/channels/voice/package.json` |
| `channel-webhook` | `/channels/webhook/package.json` |
| `channel-api` | `/channels/api/package.json` |
| `lib` | `/packages/lib/package.json` |
| `ui` | `/packages/ui/package.json` |
| `cli` | `/packages/cli/package.json` |

## Tag conventions
- `v1.2.3` → coordinated platform release
- `<component>/v1.2.3` → component release
- `cli/v1.2.3` → CLI release

## CLI helpers
```bash
bun run ver:status
bun run ver current [target]
bun run ver:bump <target> <patch|minor|major>
bun run ver:release <target> <patch|minor|major>
```

## Release flow (recommended)
1. Bump target version(s).
2. Run typecheck/tests.
3. Commit version changes.
4. Create release tag.
5. Let publish workflows build/publish artifacts.

## Notes
- Platform releases should keep core + channel + package versions intentionally aligned.
- If a component remains behind platform version, document why in release notes/changelog.
