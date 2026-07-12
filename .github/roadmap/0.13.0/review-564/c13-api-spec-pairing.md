# c13-api-spec-pairing: document the pairing mutation in the API spec (P3-1)

_Severity: minor/docs (from PR #564 manual test notes)._

### 🟡 P3-1 `packages/ui/src/routes/api/connections/pairing/+server.ts` absent from `docs/technical/api-spec.md`
The pairing endpoint creates a durable `direct` guardian principal but is undocumented. Add it to `docs/technical/api-spec.md` in the same style as the surrounding entries: method + path, host-stack capability requirement, session/origin (CSRF) requirement, request body, success response (incl. the one-time code / QR and that principal tokens are never returned), the direct-ingress-off warning behavior, and the failure/oversized-label contract (coordinate with c8's renderSVG/label-cap fix so the documented failure modes match the code).

## Verification gates
- `bun run lint`
- Doc-only: ensure `git diff --check` stays clean (no trailing whitespace/EOF blank lines) and the described contract matches the actual handler.
