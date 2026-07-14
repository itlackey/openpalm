# c2-guardian-upstream-auth: Guardian upstream auth: honor OPENCODE_SERVER_USERNAME + password whitespace agreement

_Severity: critical+major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/guardian/src/config.ts:156` (r3566889740)

Guardian upstream Basic auth hardcodes the 'opencode' username, ignoring OPENCODE_SERVER_USERNAME that the host UI honors (endpoints.ts:262 uses process.env.OPENCODE_SERVER_USERNAME || 'opencode'). An operator who sets OPENCODE_SERVER_USERNAME=<user> makes OpenCode expect <user>:<pw>; host UI authenticates but guardian keeps sending opencode:<pw> → every guardian→assistant call (proxy, drift, event fanout) 401s, silently taking down all portals. Fix: resolve the username the same way here (read OPENCODE_SERVER_USERNAME, default opencode).

### 🔴 `packages/guardian/src/config.ts:149` (r3566888272)

Password whitespace handling diverges between guardian and assistant → home-password preset 401s and breaks all portals. Guardian reads the OpenCode password with raw.trim() (strips ALL surrounding whitespace). The assistant entrypoint reads the same secret file with OPENCODE_SERVER_PASSWORD="$(cat ...)" (entrypoint.sh:158) — command substitution strips only trailing newlines, preserving surrounding spaces/tabs. setup-validation.ts:53 only checks password.length<8; secret written verbatim. An operator setting a password like 'lanpass1 ' (trailing space, ≥8) makes OpenCode expect 'lanpass1 ' while guardian sends 'lanpass1' → every guardian→assistant call 401s silently. Fix: make the two readers agree — reject/normalize surrounding whitespace at setup-validation.ts:53, or match the entrypoint (trim only newlines on both sides).

## Verification gates

- `cd packages/guardian && bun test --no-orphans`
- `bun run lib:test`
