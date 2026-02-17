# Admin Implementation Guide (Advanced)
*Optional administrator tools that are user-friendly, gated behind additional verification, and safe by design.*

## 1) Cross-platform installer + guided setup

### Goals
- One installer that:
  1) checks prerequisites (Docker/Compose)
  2) installs Docker if needed (or guides user)
  3) selects a directory for persistent data
  4) writes `.env` + compose overrides
  5) boots stack and verifies health

### Recommended path
- **CLI installer (Node/Bun)** first for speed and portability.
- Optional **Tauri UI installer** later for a premium wizard UX.

### Installer flow
1. Detect OS + admin privileges
2. Detect Docker + Compose
3. If missing:
   - Windows/macOS: guide to Docker Desktop install
   - Linux: offer scripted install with explicit confirmation
4. Prompt for persistent data directory
5. Write env + compose override that bind-mounts persistent paths
6. `docker compose up -d`
7. Health check endpoints
8. Enroll first admin with step-up auth (passkey preferred)

### Persistent data layout
```
<DATA_DIR>/
  openmemory/
  opencode/
  gateway/
  observability/
  backups/
```

---

## 2) Safe runtime updates for tools/skills/plugins

### Pattern: “Staged Change + Verified Apply”
Implement a **Change Manager** in the Gateway.

#### Lifecycle
1) Propose (bundle created)
2) Validate (automated gates)
3) Admin review + step-up verify
4) Apply atomically
5) Rollback available

### Bundle structure
```
bundle/
  manifest.json
  skills/
  tools/
  plugins/ (optional, higher risk)
  checksums.txt
  signature.sig (optional)
```

### Automated gates (before admin review)
- Path allowlist (only approved directories)
- Secret detection (block keys/tokens)
- Static checks for tools/plugins (limit exec/network/env)
- JSON/JSONC parse + schema validation
- Optional TS compile/lint/tests

### Risk tiers
- Low: skills only
- Medium: tools calling internal services only
- High: filesystem/network tool changes
- Critical: plugins, permissions, channels, compose changes

### Admin verification
- Step-up auth for applies (WebAuthn passkey / TOTP)
- Optional 2-person rule for High/Critical

---

## 3) Settings UI (edit config + restart)

### Do not embed config editing inside Grafana
Use a **Gateway Admin Console**, and link to it from dashboards.

### Admin Console pages
- System status
- Config editor (schema-aware)
- Change manager (diff/apply/rollback)
- Service control (restart/rotate keys)
- Admin/security (users, passkeys, audit)

### Safe config editing flow
1) Parse JSONC
2) Validate schema
3) Policy lint (deny widening permissions without extra approval)
4) Write atomically with backup
5) Restart OpenCode (deterministic)

### Restart without mounting Docker socket into Gateway
Prefer a restricted “compose-control” sidecar:
- Exposes only a tiny HTTP API (restart specific services)
- Requires shared secret from Gateway
- Gateway requires step-up auth before calling it

---

## 4) Admin access protection (“approved user”)

### Auth model
- Primary: local account or SSO
- Secondary: required for admin actions (passkey/TOTP)

### Step-up triggers
- apply bundles
- edit permissions
- add channels
- restart services
- export memory/logs
- change allowlists

### Audit trail
Log:
- who/when/what
- diff hash
- verification method
- restarts performed

---

## 5) Hardening: protect your channels

### Universal channel hardening
- Dedicated secrets per channel
- Signature verification (when supported)
- Replay protection (timestamp + nonce)
- Rate limiting per user/channel
- Max message size + attachment allowlist
- Outbound allowlist for fetches
- Separate admin-only channel path (stronger auth)

### Network placement
- Public entrypoint: reverse proxy + TLS
- Keep OpenCode/OpenMemory private; only Gateway can access them

### Capability isolation
Channel adapters should not:
- access Docker
- access host filesystem
- hold non-channel secrets
