# c4-home-password-rerun: Setup rerun over home-password must not rotate the password (keep-as-is)

_Severity: critical. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🔴 `packages/ui/src/lib/setup/setup-state.svelte.ts:964` (r3566887969)

Setup rerun over a home-password install silently rotates the OpenCode password → unpairs every already-paired device. On rerun the current-config endpoint never returns the secret (+server.ts:165 returns only hasOpencodePassword), so init() sets networkPreset='home-password' but leaves opencodePassword=''. NetworkAccessStep renders the preset selected with an empty password box and no 'kept as-is' notice (that only shows when networkPreset===null). If the operator types a value OR just clicks the already-selected home-password row, line 964 runs if (preset==='home-password' && !this.opencodePassword) this.opencodePassword=generatePassword() and sets networkDirty=true. The payload gate (!isRerun || networkDirty) is now true so install sends network={preset:'home-password', opencodePassword:<new>}, and setup.ts:359 unconditionally overwrites OP_OPENCODE_PASSWORD — rotating the secret and 401-invalidating every paired device. Earlier keep-as-is fixes (8e9834c/5f91b06) only cover the untouched rerun. Fix: treat an empty-but-unchanged home-password box on rerun as 'keep existing' (suppress generatePassword() + omit the password from the payload) rather than minting a new secret.

## Verification gates

- `bun run ui:check`
- `cd packages/ui && npx vitest --run src/lib/setup/setup-state.vitest.ts`
