# Contrarian / Devil's Advocate Review

**Reviewer**: Contrarian Agent
**Date**: 2026-03-24
**Branch**: release/0.10.0
**Scope**: Fundamental architectural assumptions, technology choices, complexity justification

---

## Executive Summary

OpenPalm is a self-hosted AI assistant platform with 19 stars, 0 forks, and effectively one contributor (plus AI pair-programming agents). It has 15 workspace packages, 6 Docker images, 243 TypeScript source files (~23,000 LOC), 100 test files, ~204 YAML config files, and an architectural principles document that reads more like a constitution than guidance for a pre-1.0 project.

The core question this review asks: **Is the architecture proportional to the problem being solved?**

The honest answer is mixed. Some decisions are genuinely well-reasoned for the self-hosted niche. Others are premature abstractions that impose a tax on every contributor interaction for theoretical benefits that may never materialize.

---

## 1. Is Docker Compose the Right Orchestration Choice?

### Current Approach
Docker Compose with a multi-file overlay pattern. `core.compose.yml` defines 4 core services (memory, assistant, guardian, scheduler). 8 addon overlays live in `.openpalm/stack/addons/`. The CLI and admin both orchestrate Compose operations via `execFile` with argument arrays (no shell interpolation -- that part is good).

### The Argument Against
- **Compose is designed for multi-container development environments**, not production deployments. Docker's own documentation positions it this way. For a self-hosted tool running on a single machine, you are adding the overhead of container networking, image pulls, volume mount permission headaches (the `ensureVolumeMountTargets` function in install.ts is 65 lines of working around Docker creating bind mounts as root), and multi-file compose merging -- all to run what could be 4 Bun processes.
- The multi-file overlay pattern (8 addon compose files merged at runtime) is clever but fragile. The `composePreflight` validation step exists *because* compose merge failures are a real and common failure mode. You are validating the merge before every mutation operation. That is complexity created to validate complexity.
- For 19 stars, Kubernetes is obviously overkill, but Compose is also arguably overkill. A process manager (systemd, PM2, supervisord) or even a single multi-process Bun application would eliminate the entire Docker dependency.

### Concrete Simpler Alternative
A single Bun process that spawns the assistant, guardian, memory, and scheduler as worker threads or child processes. No Docker required. For users who want isolation, provide a *single* Docker image with all services managed by supervisord inside one container. This eliminates: the compose overlay pattern, the preflight validation, the volume mount permission dance, the docker-socket-proxy addon, and approximately 400 lines of Docker orchestration code in `packages/lib/src/control-plane/docker.ts`.

### Honest Assessment
Docker Compose is defensible *specifically* because OpenPalm wraps third-party runtimes (OpenCode, which has its own filesystem expectations) and because the assistant must be isolated from the Docker socket. The isolation boundary between assistant and admin is real and important -- you do not want an AI agent with access to `docker exec`. Compose provides that isolation out of the box.

The multi-file overlay pattern is more questionable. Addons could be configured through environment variables on a single compose file rather than requiring file merging.

**Verdict: QUESTIONABLE** -- Docker itself is justified for isolation, but the multi-file compose overlay architecture adds more complexity than the addon flexibility warrants at this project's maturity. A single compose file with conditional service profiles would be simpler.

---

## 2. Is the Guardian Pattern Worth the Complexity?

### Current Approach
Every channel message flows: `External Client -> Channel Adapter -> Guardian -> Assistant`. The Guardian (`core/guardian/src/server.ts`, ~230 lines) performs: JSON parsing, HMAC-SHA256 signature verification, nonce-based replay detection (5-minute window, 50K nonce cache), fixed-window rate limiting (120 req/min per user, 200 req/min per channel), session management, and audit logging.

### The Argument Against
- **HMAC signing for internal Docker network traffic is security theater.** The channel and guardian are on the same Docker network (`channel_lan`). An attacker who can inject traffic into that network has already compromised the Docker host. The HMAC signing protects against an adversary who can send arbitrary HTTP requests to the guardian's port but cannot read the channel's HMAC secret -- a threat model that requires network access to the Docker bridge but not filesystem access to the vault. This is an extremely narrow attack surface.
- **Replay detection on a LAN-first tool.** The project's own rate-limit code acknowledges this: "This is acceptable for the guardian's use case (LAN-first, secondary to HMAC auth)." If you accept LAN-first, replay attacks require an attacker who is already on your LAN, can sniff Docker bridge traffic, and wants to replay a chat message. The threat model does not survive scrutiny.
- **The Guardian is a single point of failure.** If it goes down, all channels are dead. It adds latency to every message. It adds a session cache layer (with its own TTL, locking, and cleanup) on top of the assistant's own session management.

### Concrete Simpler Alternative
Move rate limiting and basic validation into the channel adapter base class (which already exists as `BaseChannel`). Use API key authentication instead of HMAC (simpler, no replay concern, no nonce cache). Let each channel authenticate directly with the assistant. This eliminates: the guardian service, the HMAC crypto library, the nonce cache, the session proxy layer, and approximately 500 lines of security code.

### Honest Assessment
The Guardian is more defensible than it first appears, for one reason: **it centralizes the trust boundary for all channels.** Without it, every channel adapter must independently implement auth, rate limiting, and session management correctly. The BaseChannel class helps, but a centralized enforcement point is genuinely more secure than distributed enforcement for a plugin ecosystem where community developers write channel adapters. The HMAC pattern ensures that even a buggy channel adapter cannot send un-authenticated messages to the assistant.

The timing-attack-resistant HMAC verification and the dummy-secret pattern for unknown channels (preventing channel name enumeration) show genuine security thinking.

However, the replay detection and nonce caching are over-engineered for the threat model. A timestamp check alone (reject messages older than 5 minutes) would provide 95% of the protection at 10% of the complexity.

**Verdict: JUSTIFIED** for the centralized trust boundary and channel plugin security model. The nonce cache and replay detection could be simplified to a timestamp check without meaningful security loss.

---

## 3. Is the Shared Lib Package (@openpalm/lib) Beneficial or Harmful?

### Current Approach
`packages/lib/` is a 5,400-line shared library with 44 source files exporting 100+ symbols. It contains: lifecycle management, Docker orchestration, env file parsing, secret management, stack spec parsing, config persistence, rollback, validation, scheduling logic, memory configuration, registry sync, and more. Both the CLI and admin import from it.

### The Argument Against
- **The barrel export (`index.ts`) re-exports 100+ symbols.** This is not "shared logic" -- it is "the entire application logic in a library that two consumers import." The admin is a thin SvelteKit wrapper; the CLI is a thin Citty wrapper. The real application is `@openpalm/lib`. This is a monolith wearing a trench coat pretending to be a modular architecture.
- **You cannot change lib without affecting both consumers.** This is explicitly the design intent (per CLAUDE.md: "Never duplicate control-plane logic in a consumer"). But in practice, the admin needs Vite-compatible code while the CLI needs Bun-native code. The lib must satisfy both constraints, which is why the admin needs `bunShim()` and `yamlTextImport()` Vite plugins to make lib work in a Node.js context. The shared lib is causing compatibility friction, not reducing it.
- **The lib has a Bun identity crisis.** The lib source files use `process.env` (Node-compatible) but the consumers use `Bun.env` in some places and `process.env` in others. The lib imports from `node:fs`, `node:crypto`, `node:child_process` -- all Node APIs. It is a Node library that happens to run under Bun. So why does the project use Bun at all? (See section 7.)

### Concrete Simpler Alternative
Collapse the lib into the CLI package. Have the admin make API calls to the CLI (which already runs on the host) rather than importing the same library and independently orchestrating Docker. The admin would be purely a web UI that calls a local REST API, not a second orchestrator with the same code.

### Honest Assessment
The shared lib correctly prevents the "two orchestrators diverging" problem. Without it, the CLI and admin would inevitably implement the same lifecycle logic differently, leading to state corruption. The lib is the *right* abstraction boundary -- it just has too much surface area for the project's maturity.

The barrel export with 100+ symbols is a code smell, but the alternative (duplicated logic) is worse. The real problem is not the lib's existence but its scope: it should be lifecycle + Docker + config, not also scheduling logic, memory configuration, registry sync, and provider constants.

**Verdict: JUSTIFIED** in principle, **NEEDS RETHINKING** in scope. The lib should be split: core lifecycle/config (~2000 lines) stays shared; scheduling, memory config, registry, and provider constants should live in their respective packages.

---

## 4. "File Assembly, Not Rendering" -- Is This Practical?

### Current Approach
The core principles document mandates: "Write whole files; no string interpolation or template generation." Compose files are static YAML. Environment files are assembled via `mergeEnvContent()` which preserves existing content and inserts new key-value pairs. The `writeCapabilityVars()` function in `spec-to-env.ts` is a 130-line function that deterministically maps a StackSpec to OP_CAP_* environment variables and writes them into stack.env.

### The Argument Against
- **This is template rendering with extra steps.** The `mergeEnvContent()` function reads existing file content, parses it, merges new key-value pairs, preserves comments, and writes back. That is a template engine. The `writeCapabilityVars()` function maps a typed object to string key-value pairs -- that is serialization, which is what templates do. The distinction between "file assembly" and "rendering" is philosophical, not practical.
- **The compose files use `${VAR:-default}` substitution extensively.** The `core.compose.yml` contains 50+ variable references. Docker Compose is performing the template rendering at runtime. The project has not eliminated rendering; it has delegated it to Compose's variable substitution engine.
- **The no-rendering rule makes code harder to read.** `generateFallbackSystemEnv()` in `config-persistence.ts` is 35 lines of string concatenation to produce an env file. A Jinja/Mustache template would be 15 lines and immediately readable. The rule optimizes for a principle at the cost of clarity.

### Concrete Simpler Alternative
Use a simple template system (even just `string.replace()` with `{{VAR}}` markers) for env file generation. Keep static compose files as they are (they are already fine). The difference in practice would be minimal because the project already does variable substitution through Compose.

### Honest Assessment
The "no rendering" rule has one genuine benefit: it prevents a class of bugs where a template engine introduces unexpected escaping, whitespace, or encoding issues in generated config files. Env files and YAML are sensitive to whitespace. By writing known-good strings and merging at the key-value level rather than the string level, the project avoids a real category of bugs.

But the rule is stated as an absolute when it is really a heuristic. The project already renders (via Compose variable substitution and `mergeEnvContent`). The rule should be "prefer file assembly over string interpolation for config files" rather than an architectural commandment.

**Verdict: QUESTIONABLE** -- The underlying principle (avoid template engines for config files) is sound, but the absolutist framing elevates a good practice into unnecessary rigidity. The code already violates the spirit of the rule through Compose variable substitution and programmatic env file construction.

---

## 5. Does "LAN-First" Still Make Sense?

### Current Approach
All services bind to `127.0.0.1` by default. The CLAUDE.md states "LAN-first by default. Nothing is publicly exposed without explicit user opt-in." The compose files use `${OP_*_BIND_ADDRESS:-127.0.0.1}:${OP_*_PORT:-XXXX}:YYYY` patterns, defaulting to localhost binding.

### The Argument Against
- **LAN-first limits the addressable market.** Most users who want a self-hosted AI assistant want to access it from their phone, laptop, or remote workstation. "Self-hosted" increasingly means "on a VPS" or "in a home lab accessible via Tailscale/Cloudflare Tunnel." LAN-first means every one of these users must figure out reverse proxying on their own.
- **The security benefits of LAN-first are overstated.** The project already has admin token auth, HMAC for channels, and guardian ingress control. These are the real security mechanisms. Binding to localhost adds a belt to the suspenders -- helpful, but not the primary defense.

### Concrete Simpler Alternative
Default to `0.0.0.0` binding with mandatory authentication. Provide a Tailscale/Cloudflare Tunnel integration as a first-class addon. This would make the product immediately accessible to VPS users, the fastest-growing segment of self-hosters.

### Honest Assessment
LAN-first is the correct default for a project at this maturity level. The project has 19 stars. An accidental public exposure with a default admin token would be a security incident that destroys trust before there is any trust to destroy. Defaulting to localhost and requiring explicit opt-in for public exposure is the responsible choice.

The real issue is not the default but the lack of a supported path from LAN to remote access. A Tailscale/WireGuard addon or a Cloudflare Tunnel addon would address this without changing the safe default.

**Verdict: JUSTIFIED** as a default. The project should invest in making the "expose remotely" path simple rather than changing the default.

---

## 6. Is This Project Over-Engineered for Its Maturity?

### Current Approach
15 workspace packages. 6 Docker images. 4 core services + 8 addons. 243 source files. 100 test files. 204 YAML configs. A `core-principles.md` document with 9 goals, 4 security invariants, a filesystem contract, and a volume-mount contract. An orchestrator lock system. A rollback/snapshot system. A registry sync system. A secret backend abstraction (plaintext vs. `pass`). A capability injection system (OP_CAP_* variables). A stack spec validator. A preflight validation system.

All of this for a project with 19 GitHub stars, 0 forks, and effectively 1 human contributor.

### The Argument Against
- **This is enterprise architecture for a side project.** The number of abstractions, contracts, validation layers, and architectural documents is disproportionate to the user base. Each abstraction has a maintenance cost. Each validation layer is code that must be kept consistent with the thing it validates. Each architectural document is a constraint on future decisions.
- **The package count inflates perceived complexity.** 15 workspaces means 15 `package.json` files, workspace linking, version synchronization, and import path management. The channels SDK exists to share ~200 lines of HMAC and logging code between channel adapters. Is that worth a separate package?
- **The rollback system (`snapshotCurrentState`, `restoreSnapshot`) exists for a project that does not yet have enough users to need operational resilience.** The lock system (`acquireLock`, `releaseLock`) protects against concurrent CLI/admin mutations that, with 1 user, will never happen concurrently.
- **The `pass` secret backend integration allows GPG-encrypted secret management for a project whose users are running `docker compose up` on their home lab.** The target audience does not use `pass`.

### Concrete Simpler Alternative
Collapse to 4 packages: `cli` (standalone binary), `admin` (SvelteKit app), `lib` (shared logic), `channels-sdk` (channel adapter contract). Inline the guardian, scheduler, and memory logic into the assistant or admin. Use a single compose file with conditional profiles instead of 9 compose overlay files. Delete the rollback system, the lock system, the `pass` backend, and the registry sync until there are users requesting these features.

### Honest Assessment
This is the single most important criticism in this review. The project exhibits a pattern of **solving imagined future problems at the expense of present simplicity.** The rollback system, lock system, pass backend, and registry sync are all genuinely useful features -- *for a mature project with many users*. For a pre-1.0 project with 19 stars, they are:
- Code that must be maintained
- Tests that must pass
- Abstractions that must be learned by contributors
- Constraints that slow down iteration

However, the counter-argument is that the project is designed to manage an AI agent with access to user data. The security invariants (assistant isolation, guardian ingress, vault boundary) are not over-engineering -- they are necessary. An AI assistant that can `docker exec` into containers or read arbitrary secrets is a real threat. The architecture prevents this.

The problem is that necessary security architecture (isolation boundaries) is mixed with premature operational features (rollback, registry sync, `pass` integration) under the same umbrella of "core principles."

**Verdict: NEEDS RETHINKING** -- The security architecture is justified. The operational features (rollback, lock, pass backend, registry sync, multi-file compose overlays) are premature. The project should explicitly separate "security invariants" (must have now) from "operational niceties" (add when users request them).

---

## 7. Is Bun the Right Choice?

### Current Approach
The repo uses Bun as the primary runtime for: CLI, guardian, scheduler, channel adapters, and all channel runtime containers. The admin uses Node.js (via SvelteKit/Vite). The shared lib uses Node.js APIs (`node:fs`, `node:crypto`, `node:child_process`) but is consumed by both Bun and Node contexts. The channels-sdk uses Bun-specific APIs (`Bun.CryptoHasher`, `Bun.serve`, `Bun.env`, `Bun.file`).

### The Argument Against
- **The Bun/Node split creates a compatibility tax.** The admin cannot use Bun because SvelteKit + Vite requires Node.js. So the shared lib must be Node-compatible. But the guardian and channels use `Bun.CryptoHasher` (Bun-only), `Bun.serve` (Bun-only), and `Bun.env` (Bun-only). This means the project maintains two runtime contexts, and the boundary between them is not always clear.
- **Bun-specific API usage is minimal and replaceable.** `Bun.CryptoHasher` replaces `crypto.createHmac`. `Bun.serve` replaces `http.createServer` or Hono. `Bun.env` replaces `process.env`. `Bun.file` replaces `fs.readFile`. None of these are capabilities that Node lacks. The Bun APIs are marginally nicer syntax for the same operations.
- **Bun's ecosystem maturity is still catching up.** The project already documents compatibility workarounds: the `bunShim()` Vite plugin that injects `globalThis.Bun = { env: process.env }` so lib modules work in Vite. The CLAUDE.md notes that admin Docker builds must use npm, not Bun, and warns "Do not deviate from this pattern."
- **The CLI compiles to a standalone Bun binary.** This is the one genuine Bun advantage -- single-binary distribution. But Go, Rust, or Deno also offer single-binary compilation without the Node compatibility issues.

### Concrete Simpler Alternative
Standardize on Node.js everywhere. Use Hono or Fastify for HTTP servers. Use `node:crypto` for HMAC. The shared lib already uses Node APIs. This would eliminate the Bun/Node split, the `bunShim()` workaround, and the Docker dependency resolution dance.

### Honest Assessment
Bun provides three real advantages: faster startup (relevant for CLI), single-binary compilation (relevant for distribution), and a nicer developer experience (`Bun.serve` is genuinely cleaner than `http.createServer`). For a single-developer project, developer experience matters more than enterprise considerations.

The Bun/Node split is a real cost, but it is largely confined to the Docker build pattern (admin uses npm, everything else uses Bun) and the Vite shims. The shared lib is Node-compatible, which is the right boundary.

The risk is Bun API instability. If Bun changes `Bun.CryptoHasher` or `Bun.serve`, the guardian and all channels must update. But the Bun surface area used is small and stable (these are not experimental APIs).

**Verdict: QUESTIONABLE** -- Bun provides real developer experience benefits and the single-binary CLI is a genuine advantage. But the Bun/Node split creates a maintenance cost. The project would be simpler with Node everywhere. The current approach is acceptable but not optimal.

---

## 8. The Admin/CLI Duality -- Is This a Design Smell?

### Current Approach
Two independent orchestrators manage the same Docker Compose stack:
- **CLI**: Runs on the host, directly executes `docker compose` commands, serves the setup wizard
- **Admin**: Runs inside Docker, executes `docker compose` via docker-socket-proxy, provides web UI + API

Both import `@openpalm/lib` for lifecycle logic. The admin is behind `profiles: ["admin"]` and is optional. There is a file-based lock (`acquireLock`/`releaseLock`) to prevent concurrent mutations.

### The Argument Against
- **Two orchestrators for the same state is inherently fragile.** The lock system exists *because* two separate processes can mutate the compose state concurrently. A single orchestrator would not need a lock.
- **"Admin is optional" creates a testing matrix explosion.** Every feature must work with admin present and with admin absent. The assistant has different capabilities depending on whether admin is running (admin-tools vs assistant-tools only). The setup wizard runs in the CLI *or* in the admin. This is not optionality; it is two products sharing a codebase.
- **The admin runs inside Docker but manages Docker from inside Docker.** This requires the docker-socket-proxy (a third-party image with specific version pinning and SHA256 digest), a dedicated Docker network (`admin_docker_net`), and careful capability restrictions (`EXEC: 0`). This is complexity that exists solely because the admin chose to be a Docker container managing Docker containers. If the admin ran on the host (like the CLI), none of this would be needed.

### Concrete Simpler Alternative
Make the admin a host-side process (like the CLI) that serves the web UI. The CLI becomes the admin's backend. No docker-socket-proxy needed. No Docker-in-Docker management. One orchestrator, one source of truth.

Alternatively, keep the admin in Docker but make it a pure UI that communicates with a host-side agent (the CLI running as a daemon) via a local API. The admin would never touch Docker directly.

### Honest Assessment
The duality is genuinely problematic, but the project is aware of the risks and has mitigated them (shared lib, lock system, docker-socket-proxy restrictions). The "admin is optional" design serves a real use case: headless/CLI-only installations for power users.

The docker-socket-proxy pattern is industry standard for container management UIs (Portainer, Yacht all use it). The security restrictions are correctly configured.

The real issue is not the duality itself but the complexity it forces: two code paths for setup, two code paths for lifecycle operations, a lock system, and a docker-socket-proxy addon. A host-side daemon pattern (CLI runs as a service, admin is a UI for it) would be simpler but would require the CLI to be always-running, which changes the deployment model.

**Verdict: QUESTIONABLE** -- The design is defensible but creates a disproportionate amount of complexity for the flexibility it provides. The lock system, the docker-socket-proxy, and the "two orchestrators" testing burden are real costs. A host-side daemon pattern would be simpler for most users.

---

## 9. The Channel/Guardian/Assistant Pipeline -- Too Many Hops?

### Current Approach
A message from a user to the assistant traverses:
1. **External Client** (e.g., Discord, HTTP API)
2. **Channel Adapter** (translates protocol, HMAC-signs, forwards to guardian)
3. **Guardian** (verifies HMAC, checks nonce, rate limits, manages session, forwards to assistant)
4. **Assistant** (OpenCode runtime, processes message, returns response)

That is 3 network hops for every single message.

### The Argument Against
- **Each hop adds latency.** On a LAN, each hop adds ~1-5ms for network + JSON serialization. With 3 hops, that is 3-15ms of overhead per message before the assistant even starts thinking. The assistant's response time is measured in seconds (LLM inference), so the overhead is negligible in absolute terms.
- **Each hop is a failure point.** If the guardian is restarting, all channels are down. If a channel crashes, messages from that platform are lost. The more services in the pipeline, the more failure modes exist.
- **The guardian-assistant session management duplicates OpenCode's own session management.** The guardian maintains a session cache (`sessionCache`, `sessionTitleCache`) with TTL, locking, and cleanup. OpenCode also manages sessions. The guardian is a session proxy that adds complexity to bridge two session systems.

### Concrete Simpler Alternative
Two options:
1. **Merge guardian into assistant.** The assistant already has a health endpoint and HTTP server. Add HMAC verification and rate limiting as middleware. Eliminates one network hop and the session proxy layer.
2. **Merge channel into guardian.** The guardian already has HTTP handling. Add protocol translation. Each "channel" becomes a route handler in the guardian. Eliminates one network hop.

### Honest Assessment
The 3-hop pipeline is justified by the separation of concerns:
- **Channels** are protocol adapters (community-extensible, untrusted code)
- **Guardian** is the trust boundary (security-critical, centrally maintained)
- **Assistant** is the AI runtime (third-party software, isolated)

Merging guardian into assistant would give the AI runtime responsibility for security enforcement. Merging channels into guardian would make the guardian a monolith that must understand every external protocol.

The session proxy layer is the weakest part. The guardian should forward messages without managing sessions; let the assistant handle its own session lifecycle. This would eliminate ~200 lines of session management code in `forward.ts`.

**Verdict: JUSTIFIED** for the separation of trust domains. The session management in the guardian should be removed or simplified to stateless forwarding.

---

## 10. What Would I Build If Starting From Scratch?

Knowing what OpenPalm does -- self-hosted AI assistant with memory, multiple chat interfaces, admin panel -- here is what I would build differently:

### Remove Entirely
- **The registry sync system** -- premature for the user base
- **The rollback/snapshot system** -- premature
- **The `pass` secret backend** -- target audience does not use GPG
- **The orchestrator lock system** -- single orchestrator eliminates the need
- **The multi-file compose overlay pattern** -- single compose file with profiles
- **The spec-to-env capability injection pipeline** -- too many layers of indirection between config and runtime

### Simplify
- **One compose file, one env file.** The StackSpec YAML -> deriveSystemEnvFromSpec -> writeCapabilityVars -> stack.env -> Compose ${VAR} substitution pipeline has 4 transformation steps between "user configuration" and "running service." Each step is a bug surface. A single well-documented env file that users edit directly would serve 90% of use cases.
- **One orchestrator.** CLI on the host, admin is a UI that talks to the CLI daemon. No docker-socket-proxy. No lock contention.
- **Stateless guardian.** HMAC verify, rate limit, forward. No session management, no session cache, no audit log. Let the assistant own sessions.
- **5 packages, not 15.** `cli`, `admin`, `lib`, `channels-sdk`, `memory`. Everything else inlines.

### Keep As-Is
- **The guardian as a trust boundary.** This is genuinely good architecture for a system where community developers write untrusted channel adapters.
- **The assistant isolation (no Docker socket).** Critical security invariant.
- **Docker Compose for service isolation.** The right tool for isolating the AI runtime from the control plane.
- **The BaseChannel SDK pattern.** Clean, extensible, well-designed. Making it easy to add new channels is a real product differentiator.
- **LAN-first defaults.** Correct for the target audience.
- **The vault/config/data directory separation.** Clear ownership boundaries, sensible permissions model.

### Architecture

```
CLI (host daemon, always running)
  |
  +-- REST API (admin UI calls this)
  |
  +-- Docker Compose (single file, profiles for addons)
       |
       +-- memory (sqlite-vec)
       +-- assistant (OpenCode, no docker socket)
       +-- guardian (HMAC verify + rate limit, stateless forward)
       +-- channel-* (one per addon profile)
```

The admin is a static SvelteKit app that calls the CLI daemon's REST API. No Docker socket proxy needed. No shared lib -- the CLI *is* the control plane. The admin is a view layer.

---

## Summary Verdicts

| # | Challenge | Verdict |
|---|-----------|---------|
| 1 | Docker Compose | QUESTIONABLE |
| 2 | Guardian Pattern | JUSTIFIED |
| 3 | Shared Lib (@openpalm/lib) | JUSTIFIED / NEEDS RETHINKING |
| 4 | File Assembly, Not Rendering | QUESTIONABLE |
| 5 | LAN-First | JUSTIFIED |
| 6 | Over-Engineering | NEEDS RETHINKING |
| 7 | Bun Choice | QUESTIONABLE |
| 8 | Admin/CLI Duality | QUESTIONABLE |
| 9 | Message Pipeline Hops | JUSTIFIED |
| 10 | From-Scratch Alternative | N/A |

### Top 3 Changes That Would Most Reduce Complexity

1. **Single orchestrator pattern.** Make the CLI a host daemon with a REST API. Admin calls the daemon instead of independently orchestrating Docker. Eliminates: lock system, docker-socket-proxy, dual code paths, preflight duplication.

2. **Single compose file with profiles.** Replace 9 compose overlay files with 1 compose file using Docker Compose profiles. Eliminates: multi-file merge validation, `discoverStackOverlays`, `buildComposeFileList` overlay logic, the compose preflight step for merge validation.

3. **Stateless guardian.** Remove session management from the guardian. Forward messages with a request ID and let the assistant manage sessions. Eliminates: session cache, session locks, session TTL management, session title cache, session list cache (~200 lines in forward.ts).

### What Is Actually Well-Designed

- The security isolation model (assistant has no Docker socket, guardian is the only ingress, vault has clear boundaries) is genuinely thoughtful and correct.
- The BaseChannel SDK with `handleRequest()` as the only required method is an excellent developer experience for channel adapter authors.
- The `execFile` with argument arrays (no shell interpolation) for Docker commands is a real security practice, not theater.
- The HMAC timing-attack resistance (constant-time XOR, dummy secret for unknown channels) shows someone who understands security primitives.
- The env file merge system (`mergeEnvContent` with comment preservation) is well-implemented for its use case, even if the overall config pipeline is too complex.
