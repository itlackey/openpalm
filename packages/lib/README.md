# @openpalm/lib

Private zero-runtime-dependency control plane shared by the CLI and optional
Admin utility.

The public surface is intentionally only `@openpalm/lib` (the package
root resolves to the same module). It owns:

- OP_HOME path and permission handling;
- StackConfig validation, named-credential policy, portal-user mapping, and the
  previewable allowlisted importer;
- selective Skeleton materialization;
- file-secret creation;
- Compose argument construction and Docker process execution;
- resolved-Compose security auditing; and
- lifecycle locking.

Every module under `src/control-plane/` belongs to the active control plane and
is reachable through the narrow package entry point where needed.

```bash
bun run --cwd packages/lib typecheck
bun run --cwd packages/lib test
```
