# c1-host-username-auth: Host UI: opencode username on all forwarders + read auth from stack.env

_Severity: critical+major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🔴 `packages/ui/src/lib/server/endpoints.ts:507` (r3566888629)

The 'openpalm'→'opencode' username fix was applied only to defaultEndpoint(); the sibling forwarders still default to the stale 'openpalm' → user-added OpenCode connections perpetually 401. Same '|| openpalm' / '?? openpalm' fallback survives in: endpoints.ts:189 (username: rt.username || 'openpalm'), endpoints.ts:507 (probeEndpoint endpoint.username ?? 'openpalm'), routes/proxy/assistant/[...path]/+server.ts:38 (username || 'openpalm' live chat proxy), lib/server/opencode/http.ts:17 (endpoint.username || 'openpalm'). A user adds a remote-OpenCode connection with only label/url/password; every probe and proxied chat request sends Basic openpalm:<pw> and 401s. Fix: default these four fallbacks to 'opencode' (or a shared constant) to match defaultEndpoint().

### 🟠 `packages/ui/src/lib/server/endpoints.ts:269` (r3566889513)

defaultEndpoint() reads auth from frozen process.env but URL/port from fresh stack.env → host-UI 401s until the process is restarted after setup. authEnabled (line 269) and the OP_OPENCODE_PASSWORD fallback (line 272) are read only from process.env (promoted once at startup only-if-unset). URL/port (254-257) fall back to persisted=readStackEnv(...) read fresh every call. Completing the wizard with home-password writes OPENCODE_AUTH=true + password to stack.env and redeploys the assistant with auth; the long-lived host UI never re-reads that env so authEnabled stays false, password stays undefined, and every probe/chat 401s until manual restart. Fix: read OPENCODE_AUTH/OP_OPENCODE_PASSWORD from the same persisted stack.env snapshot used for the URL (falling back to process.env).

## Verification gates

- `bun run ui:check`
- `cd packages/ui && npx vitest --run src/lib/server/endpoints.vitest.ts`
