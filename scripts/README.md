# Scripts

Only a small script surface remains active.

| Script | Purpose |
|---|---|
| `dev-setup.sh` | Materialize an isolated `.dev` home for the lean stack |
| `set-version.mjs` | Validate semantic versions and stamp package/Compose versions |
| `bump-unit.mjs` | Stamp the platform or Admin release unit |
| `restore-release-candidate.sh` | Restore a source bundle for reusable CI gates |
| `setup.sh`, `setup.ps1` | Release bootstrap installers |
| `smoke-lean-image.sh` | Assert image startup and runtime security boundaries |
| `test-isolate-op-home.ts` | Force every Bun test into a throwaway `OP_HOME` |
| `validate-release-assets.mjs` | Verify the complete checksummed release set |

## Local development

```bash
./scripts/dev-setup.sh --seed-env
./scripts/dev-setup.sh --seed-env --enable-addon gateway
./scripts/dev-setup.sh --seed-env --enable-addon discord
bun run dev:build
```

`--force` refreshes generated non-secret development state. It does not
replace existing operator-owned files.

The adjacent test files cover release stamping, asset completeness, and the
deterministic end-to-end product path.
