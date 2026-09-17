# @openpalm/lib

Private zero-runtime-dependency control plane shared by the CLI and optional
Admin utility.

The public surface is intentionally only `@openpalm/lib/lean` (the package
root resolves to the same module). It owns:

- OP_HOME path and permission handling;
- StackConfigV2 validation, named-credential policy configuration, and legacy-intent migration;
- selective Skeleton materialization;
- file-secret creation;
- Compose argument construction and Docker process execution;
- resolved-Compose security auditing; and
- lifecycle locking.

Legacy modules under `src/control-plane/` are not compiled or exported unless
their filename begins with `lean-` or is `stack-config.ts`. They remain only
pending exact deletion approval.

```bash
bun run --cwd packages/lib typecheck
bun run --cwd packages/lib test
```
