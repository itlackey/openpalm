# Core: Admin

## Most important rules
- Keep apply flow simple:
  - render artifacts
  - write files
  - `docker compose up -d --remove-orphans`
- Reuse shared compose runner; do not add a second compose execution path.
- Do not add custom rollout/recovery/drift-detection systems.
- Validate intent at parse boundary and generated compose with `docker compose config`.
## Key files to prefer
- `packages/lib/src/admin/stack-spec.ts`
- `packages/lib/src/admin/stack-generator.ts`
- `packages/lib/src/admin/stack-manager.ts`
- `packages/lib/src/compose.ts`

## Key links
- `core/admin/README.md`
- `dev/docs/api-reference.md`
