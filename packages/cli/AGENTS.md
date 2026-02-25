# Package: CLI

## Most important rules
- Keep commands scriptable and deterministic:
  - stable flags
  - predictable stdout/stderr
  - non-zero exit on failure
- Reuse `packages/lib` instead of duplicating config/compose logic.
- Do not hide destructive actions; require explicit operator intent.

## Test expectations
- CLI tests must pass on fresh runners without installed OpenPalm state.
- Compose execution tests must guard on `openpalmInstalled` (not only Docker presence).
- Keep command-recognition tests separate from command-execution tests.

## Key links
- `docs/cli.md`
- `dev/docs/release-quality-gates.md`
