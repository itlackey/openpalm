## Strategic/Architectural Discussion Items

These are from the contrarian review and architecture review. Not bugs -- they are strategic decisions that warrant deliberate evaluation.

### Complexity Reduction Opportunities

- [ ] **STRAT-1. Evaluate single orchestrator pattern** `[DISCUSSION]` `[architecture]`
  Currently two independent orchestrators (CLI on host, admin inside Docker) manage the same compose stack, requiring file-based lock, docker-socket-proxy, and dual code paths. A single-orchestrator pattern (CLI as host daemon, admin as UI calling CLI REST API) would eliminate: lock system, docker-socket-proxy, dual code paths, preflight duplication. Estimated reduction: ~800 LOC + docker-socket-proxy dependency. **Tradeoff:** Changes deployment model (CLI must be always-running).
  **DENIED**

- [ ] **STRAT-2. Evaluate single compose file with profiles** `[DISCUSSION]` `[architecture]`
  Replace 9 compose overlay files with 1 compose file using Docker Compose `profiles`. Eliminates: multi-file merge validation, `discoverStackOverlays`, `buildComposeFileList`, compose preflight merge validation step. **Tradeoff:** Loses the "drop a file" addon model, which is a genuine product differentiator for community channels.
  **DENIED**

- [ ] **STRAT-3. Simplify guardian to stateless forwarding** `[DISCUSSION]` `[architecture]`
  Guardian maintains session cache with TTL, locking, cleanup, and title tracking -- duplicating the assistant's own session management. A stateless guardian (HMAC verify, rate limit, forward with request ID) would eliminate ~200 lines in `forward.ts`. **Assessment:** Session proxy is the weakest part of the guardian. Let the assistant own sessions.

- [ ] **STRAT-4. Scope shared lib reduction** `[DISCUSSION]` `[architecture]`
  `@openpalm/lib` (5,400 LOC, 100+ exports) correctly prevents orchestrator divergence but has grown beyond justified scope. Should be lifecycle + Docker + config. Move scheduling logic, memory config, registry sync, and provider constants to their respective packages. Or add subpath exports to allow tree-shaking.

- [ ] **STRAT-5. Evaluate removing premature operational features** `[DISCUSSION]` `[architecture]`
  Feature-flag or remove: rollback/snapshot system (~200-400 LOC), `pass` secret backend (~200-400 LOC), orchestrator lock (unnecessary with single orchestrator). Re-add when users request them. Each removal reduces maintenance burden and test surface.

- [ ] **STRAT-6. Simplify guardian replay detection** `[DISCUSSION]` `[security]`
  Nonce cache + timestamp checking is over-engineered for the LAN-first threat model. A timestamp-only check (reject messages older than 5 minutes) would provide 95% of the protection at 10% of the complexity. The nonce cache (50K entries, periodic pruning) could be removed.

### Security Model Enhancements

- [ ] **STRAT-7. Evaluate session-based admin auth** `[DISCUSSION]` `[security]`
  Admin token is static with no rotation, stored in `localStorage` (XSS-exfiltrable), transmitted over HTTP (LAN-first = no HTTPS), controls destructive Docker operations. Combination of no rotation + localStorage + HTTP creates capture-and-full-control risk. Consider: session-based auth with expiry, token rotation, httpOnly cookies instead of localStorage, HTTPS-only mode or at least warn when over HTTP.

- [ ] **STRAT-8. Evaluate assistant direct host exposure auth** `[DISCUSSION]` `[security]`
  `.openpalm/stack/core.compose.yml` lines 93-94: assistant (OpenCode web UI) directly reachable on port 3800 from host, bypassing guardian entirely. SSH also exposed. Defaults to `127.0.0.1` but nothing prevents changing to `0.0.0.0` creating unauthenticated entry point. Compose has `OPENCODE_AUTH: "false"`. Consider enabling auth by default.

- [ ] **STRAT-9. Evaluate remote access addon (Tailscale/Cloudflare Tunnel)** `[DISCUSSION]` `[product]`
  LAN-first is correct default, but no supported path from LAN to remote access exists. A Tailscale/WireGuard addon or Cloudflare Tunnel addon would address the most common user request without changing the safe default.

- [ ] **STRAT-10. Document "file assembly, not rendering" scope** `[DISCUSSION]` `[architecture]`
  The rule is stated as absolute but the project already violates it in spirit through: Compose `${VAR}` substitution (50+ variable refs in core.compose.yml), `mergeEnvContent()` key-value patching, `generateFallbackSystemEnv()` string interpolation, `writeCapabilityVars()` config-to-env serialization. Clarify the rule applies to compose files only; env file generation is necessarily dynamic.

---
