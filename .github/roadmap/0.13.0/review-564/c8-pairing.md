# c8-pairing: pairing: widen principal id randomness + renderSVG rollback/label cap

_Severity: major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/lib/src/control-plane/pairing.ts:172` (r3566891355)

Principal id uses only 4 hex chars (16 bits) of randomness + an upsert store → a same-label collision silently unpairs the earlier device. The principal id is `${slugifyLabel(label)}-${randomHex(2)}` — randomHex(2)=2 bytes=4 hex=16 bits. admin.ts:73 calls upsertPrincipal → state-db.ts INSERT ... ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash — id-keyed upsert with no collision check. Two devices paired over time with the same label (e.g. both default iPhone) that draw the same 4-hex suffix (1/65536 per pair, birthday-scaling) collide on id → the second overwrites the first's token_hash → the earlier device silently 401s. Fix: widen the suffix to a collision-resistant width (e.g. randomHex(8)+), or reject/retry on an existing id instead of upserting over it.

### 🟠 `packages/ui/src/routes/api/connections/pairing/+server.ts:92` (r3566891768)

renderSVG() runs on a user-length-controlled code with no try/catch, after the principal is minted → uncaught 500 orphans a durable guardian principal. label is only .trim()'d (line 61) and never length-capped (body limit 1MB). The handler mints a durable direct guardian principal first (77-82), then calls renderSVG(result.code) which embeds the full label via encodePairingCode. A multi-thousand-char label produces a base64url code exceeding a QR code's byte capacity (~2953 bytes) so uqr's renderSVG throws 'amount of data is too big'. Uncaught → route returns 500 after the principal exists, and its one-time code is never returned → orphaned principal that can't be completed or cleaned up. Fix: cap label length at validation time, and/or wrap renderSVG in try/catch that rolls back (deletes) the just-minted principal on failure.

## Verification gates

- `bun run lib:test`
- `bun run ui:check`
