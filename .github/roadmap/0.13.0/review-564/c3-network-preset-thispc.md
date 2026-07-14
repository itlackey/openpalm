# c3-network-preset-thispc: network-preset: validate this-pc against leftover host bind override (fail closed)

_Severity: critical. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🔴 `packages/lib/src/control-plane/network-preset.ts:237` (r3566887693)

'this-pc' preset is not validated against a leftover host bind override → unauthenticated OpenCode API on the LAN. validateNetworkPresetEnv short-circuits (if (preset !== 'shared-guardian') return {valid:true}) for every preset except shared-guardian, so choosing This PC only never checks the host-process env. If the host process has OP_ASSISTANT_BIND_ADDRESS=0.0.0.0 exported, performSetup validates OK and writes the all-loopback row to stack.env, but Compose gives process env precedence over --env-file, so opencode web --hostname 0.0.0.0 is still published on the LAN with OPENCODE_AUTH=false. detectNetworkPreset (reads only stack.env) then reports this-pc. A passive collectNetworkExposureWarnings log fires but no hard ok:false block. Fix: extend the loopback-integrity check to this-pc and fail closed when a host-env OP_ASSISTANT_BIND_ADDRESS/OP_BIND_ADDRESS would override the written loopback binds.

## Verification gates

- `bun run lib:test`
