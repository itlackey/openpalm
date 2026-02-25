# Package: Lib

## Most important rules
- `packages/lib` is source of truth for stack spec parsing and stack generation.
- Keep APIs deterministic, typed, and side-effect minimal.
- Centralize validation/normalization logic; avoid duplicating contracts elsewhere.
- Keep compose helpers thin wrappers around Docker Compose commands.

## Key files to prefer
- `packages/lib/src/admin/stack-spec.ts`
- `packages/lib/src/admin/stack-generator.ts`
- `packages/lib/src/admin/snippet-discovery.ts`
- `packages/lib/src/admin/setup-manager.ts`
- `packages/lib/src/compose.ts`
