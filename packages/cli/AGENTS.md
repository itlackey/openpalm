# Package: CLI

## Rules
- CLI should convert simple operator intent into deterministic config/actions.
- Keep commands scriptable: stable flags, predictable stdout/stderr, non-zero exit on failure.
- Do not hide destructive operations; require explicit opt-in.

## Patterns
- Keep command modules small and composable.
- Reuse `packages/lib` primitives instead of duplicating logic.
- Emit concise human output and machine-friendly error messages.

## Testing
- **All CLI tests must pass on fresh CI runners** where OpenPalm is not installed.
- Tests that exercise compose commands (status/ps, start, stop, etc.) must guard on
  `openpalmInstalled`, not just `dockerAvailable`. The compose commands require the
  state directory files (`.env`, `docker-compose.yml`) to exist on disk.
- Separate command recognition tests (verify the CLI doesn't print "Unknown command")
  from command execution tests (verify compose succeeds). Recognition tests should
  work everywhere; execution tests need environment guards.
- The `publish-cli` workflow runs `bun test packages/cli/test/` on a fresh runner.
  Any test that fails there blocks the npm publish and binary release.

## Gotchas
- Avoid interactive-only flows unless explicitly requested.
- Keep file writes atomic where possible to prevent partial state.
- Ensure CLI defaults match Admin/generator assumptions.
- `docker info` succeeding does NOT mean compose commands will work -- they also
  need the compose file and env file at the XDG state path.
