# OpenPalm stack, UI, and host-management architecture review

**Reviewed revision:** `0.13.4` (`e66a0fd1`)

**Review date:** 2026-09-04

**Scope:** assistant image, assistant-hosted UI, host browser UI, Electron, PWA, host control plane, lifecycle locking, and options for a smaller/customizable assistant image.

## Executive summary

OpenPalm has a sound high-level trust model: Docker Compose remains understandable and operator-accessible, the host CLI/admin process is the only component allowed to manage Docker, containers do not receive the Docker socket, and `@openpalm/lib` centralizes most lifecycle behavior. The same-origin `/oc` proxy and browser-owned connection model also solve real browser and portability problems cleanly.

The product hierarchy supplied after the initial review materially changes the preferred target: **the Electron desktop application is the primary interactive client**, while a CLI-only installation must provide the same local admin application in a normal browser. Electron should not implement a separate admin transport; it should launch or adopt the same host-only loopback admin server that `openpalm admin` launches, then wrap that endpoint in a native window. A remote/container-served web/PWA client remains secondary and optional.

The current implementation nevertheless crosses its own boundaries in several important ways:

1. The assistant service receives the same human password that authenticates the host-admin UI. Compose secrets isolate files between services, not between processes in one service, so the agent can read a credential that is sufficient to log into a subsequently running host-admin server. Loopback binding limits immediate reachability, but it does not make the credential appropriate to expose to the agent.
2. The container UI intentionally runs without the host `OP_HOME`, yet the shared server code still resolves a default `~/.openpalm` beneath the assistant's mounted home. Some routes special-case container mode while assistant-settings routes and startup migrations do not. This creates a shadow control-plane home and makes persona/AKM settings operate on the wrong files.
3. “One UI build everywhere” bundles host-management server routes and `@openpalm/lib` into the assistant artifact, even though capability checks make those routes unavailable. This is not the same as one frontend: the browser client can stay shared while the privileged host backend and minimal served gateway are built separately.
4. The assistant is a small process supervisor in disguise: one entrypoint owns OpenCode, the UI, supercronic, and a sync loop. UI health is folded into assistant health, so a UI failure can block Guardian even when OpenCode is healthy. Host-side `UiSupervisor` is named and documented as a supervisor but only handles initial spawn/readiness; it does not restart a child that dies later.
5. Lifecycle serialization has two gaps. The install lock has an ABA race because a handle contains no ownership token and release unlinks by pathname alone. Separately, ordinary UI launch overwrites managed assets and runs migrations without taking that lock or making a safety snapshot.
6. The PWA is correctly implemented as an installable online client, not an offline assistant. However, its most natural remote use—opening the assistant-hosted UI from a phone over plain LAN HTTP—is not a secure context, so it cannot be installed and connection credentials fall back to plaintext browser storage.

The recommended target is:

- a small immutable `assistant-core` image containing the OpenCode harness, a functional AKM installation, scheduling enabled by default, and only their required runtime utilities;
- one `assistant-standard` image that extends core with the bundled local embedding runtime/model, Bun, Python, uv, notification support, and the common development/operator tools expected in the normal OpenPalm experience;
- no additional first-party assistant flavors initially, and no agent harnesses beyond OpenCode in either official image;
- one host-only admin web server package, backed by `@openpalm/lib`, embedded and launched by both the CLI and Electron;
- `openpalm admin` opening that server in the user's normal browser, so no Electron installation is required for the complete admin experience;
- Electron loading the same loopback endpoint in `BrowserWindow` and adding only native integrations through its preload bridge;
- a separately deployed, opt-in `ui-gateway` service containing the shared frontend plus only authentication, `/oc`, and explicitly selected user-facing proxy/settings APIs;
- distinct optional web-client and host-admin credentials;
- a declarative assistant preset/image reference and capability manifest, selected during setup and recorded in `state/stack.env`.

This preserves one admin implementation, one frontend component codebase, and a Compose-first stack. It does not require a resident host daemon or Electron for browser administration.

## Current architecture

The authoritative documentation describes one always-on assistant container and a host-only control plane ([core principles](../technical/core-principles.md#security-invariants), [architecture overview](../technical/architecture.md#runtime-topology)). The implementation is:

```text
Host
├── openpalm CLI ────────────────┐
├── openpalm admin server ───────┼── @openpalm/lib ── docker compose
└── Electron ── admin server ────┘

Compose
├── assistant (always on)
│   ├── OpenCode :4096
│   ├── @openpalm/ui adapter-node :3000
│   ├── OpenCode workspace proxy :3820
│   ├── supercronic
│   └── periodic `akm task sync`
├── guardian (profile-gated ingress)
└── optional services/addons

Browser/PWA ── OpenPalm UI ── same-origin /oc ── OpenCode
Remote connection ─────────────────────────────── OpenCode/Guardian directly
```

The assistant process layout is visible in its [README](../../containers/assistant/README.md#runtime-processes), [entrypoint](../../containers/assistant/entrypoint.sh#L750), and [Compose definition](../../packages/skeleton/system/stack/core.compose.yml#L35). The host UI and Electron use the same SvelteKit adapter-node output; the CLI embeds that build and the skeleton as archives ([embedded assets](../../packages/cli/src/lib/embedded-assets.ts#L1)), while Electron packages them as `extraResources` ([electron-builder configuration](../../packages/electron/electron-builder.yml#L15)).

### Client and management surface comparison

| Surface | Authority | Strength | Current limitation | Recommended role |
|---|---:|---|---|---|
| Electron | Host admin; primary client | Native lifecycle, tray, notifications, microphone permissions, updater, and a controlled preload bridge | Host-admin server code is currently also part of the universal/container UI build; post-start child death is not recovered | Launch/adopt the shared host-admin server and wrap its loopback URL |
| `openpalm` CLI | Host admin; primary automation and non-Electron surface | Direct Compose/file commands plus the ability to launch browser administration | The embedded admin build is currently the same universal build shipped into the assistant | Package the same host-admin server as Electron; `openpalm admin` opens it in a browser |
| Host-admin server | Host admin; shared local endpoint | One implementation gives Electron and CLI-only users identical setup/admin behavior | Privileged and non-privileged routes are packaged together today | Dedicated host-only artifact, loopback-only, backed by `@openpalm/lib` |
| Assistant-hosted UI | Non-admin | Always available with the stack; same-origin OpenCode proxy | Shares the agent's service, UID, secrets, image, and health domain | Remove; replace with opt-in `ui-gateway` sidecar |
| Web/PWA | Non-admin optional client | Useful for remote/mobile access from a stable HTTPS origin | Online-only; plain LAN HTTP is not installable or encrypted-at-rest | Secondary remote client over HTTPS, off by default |

Electron should be treated as the product's primary client while still deliberately wrapping the same host-admin endpoint available to a CLI-only user. “Electron-first” is a distribution and native-integration decision, not a reason to fork the admin application or require Electron for stack management. Replacing Electron with Tauri or another system-webview shell may eventually reduce desktop package size, but it would not change this shared-server contract.

### Correct product and transport split

The local admin application should have one HTTP contract and two launchers:

| Consumer | Admin experience | Native/direct additions |
|---|---|---|
| Electron | Loads the shared host-admin server's loopback URL in `BrowserWindow` | Updater, notifications, tray, launch-at-login, microphone, and file dialogs through guarded preload IPC |
| CLI-only user | `openpalm admin` launches the same server and opens the URL in the system browser | Normal CLI subcommands call `@openpalm/lib` directly |
| Optional remote browser/PWA | Uses the separate non-admin `ui-gateway` | No host control |

The clean reusable unit is a dedicated host-only server package—conceptually `@openpalm/host-admin`—containing the admin web application and thin HTTP handlers over `@openpalm/lib`. Both CLI and Electron embed the same compiled build and use one shared launcher/supervisor library. Electron's preload remains limited to genuinely native features. The existing preload already demonstrates that pattern for updater, notification, restart, launch-at-login, and microphone functions ([preload bridge](../../packages/electron/src/preload.ts#L1)).

The launcher contract should cover port selection, canonical `OP_HOME` identity, authentication bootstrap, readiness, compatible-version checks, adoption of an existing instance, restart/teardown, and browser/window opening. An Electron instance may reuse a server started by the CLI only when the probe proves it serves the same canonical `OP_HOME` and a compatible admin contract—not merely because `/api/runtime` says `admin=true`. Exactly one launcher should own each child process; an attaching client must not kill it. If the owner exits or the server dies, attached clients should detect the failed health probe and either start their own compatible embedded build or show an explicit recovery action. The instance record should include a nonce, PID, canonical home, endpoint, contract version, and build version so adoption and cleanup cannot affect a replacement process.

Setup and all host APIs remain ordinary routes on this local host-admin endpoint. That gives Electron and CLI-only installations identical behavior and test coverage. The optional `ui-gateway` can reuse non-privileged components and schemas, but its build omits setup, migrations, Docker, backups, secrets administration, and `/api/host/*` entirely.

## What should be retained

- **Host-only Docker authority.** The design explicitly keeps the Docker socket out of containers and invokes the engine from the host using argument arrays rather than a shell ([Docker integration](../../packages/lib/src/control-plane/docker.ts#L1)). This is the right primary boundary.
- **Compose and files remain the operator-facing model.** `OP_HOME`, complete Compose files, a user overlay, and explicit environment records are debuggable without proprietary infrastructure.
- **Shared control-plane library.** The CLI and admin routes importing `@openpalm/lib` is the correct direction and should remain mandatory ([control-plane rules](../technical/core-principles.md#shared-control-plane-library-openpalmlib)).
- **Same-origin `/oc`.** The local browser never needs the OpenCode password, avoids CORS/mixed-content failures, and can use one session boundary.
- **Browser-owned remote connections.** This makes the same frontend useful in browser, desktop shell, and PWA modes without making the host a credential broker for every remote assistant.
- **Immutable, pinned release artifacts.** Removing boot-time installs was a meaningful improvement. Customization should use exact build-time images, not restore arbitrary package installation during container startup.
- **Network segmentation and profile-gated Guardian.** Per-service network membership and narrow secret grants are strong defaults even though one secret grant should be split, as described below.

## Findings

### F1 — High: the assistant can read the host-admin login password

The assistant receives `ui_login_password` as a service-level Compose secret ([environment and rationale](../../packages/skeleton/system/stack/core.compose.yml#L117), [secret grant](../../packages/skeleton/system/stack/core.compose.yml#L247), [secret source](../../packages/skeleton/system/stack/core.compose.yml#L332)). The entrypoint reads the file and injects the plaintext into the UI child ([entrypoint](../../containers/assistant/entrypoint.sh#L240)). The same application password is used by the host UI's session code ([session store](../../packages/ui/src/lib/server/session-store.ts#L84)), while `OP_ENABLE_ADMIN=1` or `OP_INSIDE_ELECTRON=1` adds host capabilities ([feature gate](../../packages/ui/src/lib/server/features.ts#L27)).

This protects the file from unrelated containers, but not from OpenCode or tools running in the assistant service. They run as the same service user and can read `/run/secrets/ui_login_password` directly. The password is therefore an agent-readable credential that can authenticate to an admin-capable server whenever one is running.

The default loopback-only admin listener means this is not an immediate container-to-admin network path. It still violates least privilege and turns later topology changes, local browser exposure, prompt-driven exfiltration, or custom networking into privilege-escalation opportunities. It also contradicts the documented claim that the assistant has no host-admin credential or admin credential ([architecture](../technical/architecture.md#runtime-topology), [assistant README](../../containers/assistant/README.md#secret-boundary)).

**Recommendation:** generate separate secrets with separate purposes:

- `op_served_ui_login_password`, granted only to the `ui-gateway` service;
- `op_host_admin_login_password`, readable only by the shared host-admin server used by both CLI and Electron.

Moving the optional web UI to its own service prevents the agent from reading even the served-UI password. The host-admin credential remains host-only. Electron can either use the same login flow as a browser or receive a narrowly scoped one-time session bootstrap from its main process; either way, it reaches the same admin server and API. On migration, rotate the host-admin password because existing installations must assume the former shared value may already have been exposed inside the assistant.

### F2 — High: the container UI creates a shadow control-plane home and routes settings incorrectly

The assistant UI deliberately receives no host `OP_HOME`. With `HOME=/home/opencode`, the shared resolver therefore chooses `/home/opencode/.openpalm` ([home resolver](../../packages/lib/src/control-plane/home.ts#L42)). `/home/opencode` is the host's `data/assistant` mount, while the real assistant and AKM config are separate mounts at `/home/opencode/.config/opencode` and `/etc/akm` ([mounts](../../packages/skeleton/system/stack/core.compose.yml#L205)).

The code already recognizes this mismatch and special-cases container mode for the login password and voice state ([session special case](../../packages/ui/src/lib/server/session-store.ts#L100), [voice explanation](../../packages/ui/src/lib/server/features.ts#L85)). Other shared-server paths do not:

- `assistant-settings:read/write` is advertised to every UI process ([base capabilities](../../packages/ui/src/lib/server/features.ts#L36));
- the persona API reads and writes `getState().configDir/assistant/persona.md` ([persona route](../../packages/ui/src/routes/api/assistant/persona/+server.ts#L38));
- the AKM settings API uses the same `state.configDir` ([AKM route](../../packages/ui/src/routes/api/assistant/akm/+server.ts#L225));
- `getState()` derives that directory from the default home ([state construction](../../packages/lib/src/control-plane/lifecycle.ts#L60));
- every SvelteKit server process runs home migrations at module startup ([hooks](../../packages/ui/src/hooks.server.ts#L50)).

In assistant-container mode these operations target a nested, agent-writable shadow tree under `data/assistant/.openpalm`, not the files mounted at the documented runtime paths. The result is both functional drift (“save” can succeed against the wrong file) and an unnecessary control-plane-shaped directory inside agent data.

**Recommendation:** do not make a container pretend it has a host control-plane home.

- As an immediate fix, remove `assistant-settings:*` from container runtime capabilities unless every route has an explicit, correct backend.
- Give user-facing settings APIs typed resource roots such as `OP_ASSISTANT_CONFIG_DIR` and `AKM_CONFIG_DIR`; never derive them from `OP_HOME` in served mode.
- Do not run host home migrations in a served/container gateway. Only the host lifecycle operation should migrate the host home.
- In the target sidecar, mount only the exact settings files/directories it is authorized to manage, or route changes through a narrow authenticated assistant-settings service. Do not mount all of `OP_HOME`.

### F3 — Medium: one frontend has become one oversized server trust domain

The package contains browser routes, authentication, assistant settings, `/oc`, setup, and all `/api/host/*` control-plane routes in one SvelteKit server ([route contract](../../packages/ui/README.md#route-contract)). Production builds inline every SSR dependency because all artifacts ship without `node_modules` ([Vite config](../../packages/ui/vite.config.ts#L59)). The resulting server artifact is then baked into the assistant image ([Dockerfile](../../containers/assistant/Dockerfile#L274)).

Server-side capability checks correctly prevent the intended container process from enabling host routes. The assistant also has no Docker socket or Docker client path by default. This is therefore primarily a least-privilege, auditability, size, and release-coupling flaw—not proof that `/api/host/*` is currently callable from the assistant UI.

The design conflates these two useful goals:

- one shared browser application and design system;
- one server artifact containing every privilege level.

Only the first is necessary.

The host APIs do execute on the host today when Electron or `openpalm admin` launches the adapter-node process; they are not currently executing with admin capability inside the assistant container. The design problem is their ownership and packaging: the privileged API implementation is expressed as SvelteKit UI routes and therefore ships in the container artifact too.

**Recommendation:** split the universal build into two products while keeping one local admin implementation:

1. Extract a dedicated host-admin server package containing the admin frontend, setup flow, authentication, and thin HTTP routes over `@openpalm/lib`.
2. Embed that exact server build in both the CLI and Electron artifacts.
3. Put its launch/adopt/readiness/supervision behavior in one shared library used by `openpalm admin` and Electron.
4. Keep ordinary CLI commands as direct `@openpalm/lib` consumers; launching browser admin is an additional CLI surface, not a prerequisite for CLI operations.
5. Build `ui-gateway` separately with non-admin client assets, session auth, `/oc`, workspace/voice proxies if enabled, and narrowly implemented assistant-settings APIs—but no host control.

Share frontend components and schemas between host-admin and gateway builds. Do not ship Docker lifecycle modules or host route handlers in the gateway image. Admin capability should be structural—the host-admin artifact has it and the gateway artifact does not—not an environment mode that activates privileged routes in an otherwise universal server bundle.

### F4 — High: UI and scheduler failures are coupled to assistant health without robust supervision

The assistant entrypoint backgrounds the UI supervisor loop, supercronic, and a periodic AKM sync loop, then `exec`s OpenCode as the main process ([boot sequence](../../containers/assistant/entrypoint.sh#L750)). Tini reaps child processes, but it is not a service supervisor. The code checks supercronic once after one second; a later exit is neither restarted nor reflected in container health. The UI has a custom capped restart loop, and persistent failure deliberately makes the combined assistant healthcheck fail ([UI supervisor](../../containers/assistant/entrypoint.sh#L258), [healthcheck](../../packages/skeleton/system/stack/core.compose.yml#L251)). Guardian and portal services depend on assistant `service_healthy`, so loss of the convenience UI can block or degrade ingress even if OpenCode itself is healthy.

This creates four distinct responsibilities and three listeners in the only core container. It also creates documentation drift: `hooks.server.ts` says the scheduler is a dedicated sidecar ([comment](../../packages/ui/src/hooks.server.ts#L149)), while the authoritative principles and entrypoint place it in the assistant.

**Recommendation:** separate failure domains without making core scheduling optional.

- Assistant health should mean OpenCode/AKM core readiness, not optional UI availability.
- Run `ui-gateway` as a separate service with its own restart policy and healthcheck.
- Keep AKM task synchronization and the scheduler in `assistant-core`, enabled by default. Supervise them explicitly, expose their degraded state, and test recovery after either process fails; they are core assistant functions, not optional sidecars.
- Avoid publishing the raw OpenCode port by default when all supported local clients use `/oc`; keep direct publication an explicit advanced-access toggle.
- Reassess whether the extra root-level OpenCode workspace listener is worth a third port. If OpenCode cannot support a path base, a dedicated subdomain/reverse-proxy origin or simply opening the direct advanced URL is cleaner than another listener tied to the UI process.

### F5 — Medium: `UiSupervisor` does not supervise after readiness

The shared `UiSupervisor` state machine implements `adopt()` and initial `start()`/readiness only ([implementation](../../packages/lib/src/control-plane/ui-supervisor.ts#L228)). There is no post-readiness child-exit monitor, restart policy, or backoff. The CLI calls `supervisor.start()` and then installs only shutdown handlers ([CLI launcher](../../packages/cli/src/lib/ui-server.ts#L507)). Electron uses `adopt()` as a handle holder and clears it when the child exits, leaving the desktop app/tray without a UI server ([Electron launcher](../../packages/electron/src/main.ts#L452), [exit handler](../../packages/electron/src/main.ts#L710)). Meanwhile the assistant entrypoint says its custom restart loop mirrors host supervisor semantics ([entrypoint comment](../../containers/assistant/entrypoint.sh#L258)); it does not.

Because both supported admin launchers intentionally host the same local server, supervision is part of their shared contract rather than something to remove from Electron. A real shared supervisor should own:

- child-exit observation after readiness;
- capped exponential restart with a healthy-uptime reset;
- stopping/restarting state to distinguish intentional shutdown;
- callbacks for CLI exit, Electron dialog/reload, and structured status;
- one identity/readiness contract for both launchers.

If automatic restart is not desired, the launcher should at least terminate or show a persistent actionable failure when the child dies.

### F6 — High: the install lock has ownership and stale-takeover races

The lock file contains only PID and timestamp, while the returned handle contains only the path ([lock format](../../packages/lib/src/control-plane/install-lock.ts#L1), [handle](../../packages/lib/src/control-plane/install-lock.ts#L29)). Stale recovery reads the file and later unlinks the pathname ([acquire](../../packages/lib/src/control-plane/install-lock.ts#L102)); release always unlinks that pathname without verifying ownership ([release](../../packages/lib/src/control-plane/install-lock.ts#L246)).

Two concrete ABA cases follow:

1. An operator force-removes A's live lock; B acquires it; A finishes and deletes B's lock; C can now enter concurrently with B.
2. Two processes both observe an old stale lock. One removes and replaces it; the other then removes the replacement because stale observation and unlink are not one atomic ownership operation.

The process-name/project collision checks and broad use of the lifecycle lock are otherwise good host-management defenses. This lock detail undermines the “only one orchestrator” invariant precisely during recovery and concurrency edge cases.

**Recommendation:** add an unguessable nonce and holder identity to the record and handle. Release must re-read and unlink only when the nonce still matches. For stale takeover, atomically rename the observed lock to a unique tombstone before retrying `O_EXCL`, or use a proven cross-platform advisory-lock implementation. PID should be diagnostic, not the ownership token.

### F7 — High: ordinary launch mutates shared state outside the lifecycle transaction

`applyHomeAssets()` explicitly permits a plain UI launch to overwrite the managed `system/` tree and reconcile AKM database journal state without a snapshot ([lifecycle](../../packages/lib/src/control-plane/lifecycle.ts#L162)). The CLI does this before spawning its UI child ([CLI spawn](../../packages/cli/src/lib/ui-server.ts#L172)); Electron does the same ([Electron seed](../../packages/electron/src/main.ts#L362)). The UI child then runs home migrations on module load ([hooks](../../packages/ui/src/hooks.server.ts#L50)). None of these launch paths owns the lifecycle lock shown later in `lifecycle.ts`, and the code acknowledges that no snapshot/rollback safety net exists.

An install/update/admin apply can therefore race a CLI, Electron, dev server, or another UI server launch against the same `OP_HOME`. The launch path can also mutate files merely because the user opened a client, contrary to comments elsewhere that serving is read-only ([UI state](../../packages/ui/src/lib/server/state.ts#L11)).

**Recommendation:** make launch read-only.

- Materialize an artifact's private UI files atomically in its own cache/data directory if needed.
- Detect managed-home/schema mismatch and show “Apply update” rather than silently writing.
- Run managed-tree refresh and migrations as one explicit host lifecycle transaction under the same ownership-safe lock, with the existing backup/snapshot policy.
- If seamless desktop updates require automatic apply, acquire the same lock before the UI child starts, report contention, and use the normal transactional lifecycle operation. Do not run migrations at module import time.

### F8 — Medium: the PWA and default LAN-hosted UI do not form a complete supported path

The service worker intentionally caches only static assets and leaves navigation, API, SSE, voice, auth, and cross-origin assistant traffic network-only ([service worker](../../packages/ui/src/service-worker.ts#L1)). That is a sensible security choice, but it makes the PWA an installed online client rather than an offline app.

Browsers only offer installation from a secure context. The implementation correctly detects that `http://192.168.x.x:3800` cannot be installed ([PWA state](../../packages/ui/src/lib/pwa-install-state.svelte.ts#L94)). The same insecure origin lacks SubtleCrypto, so saved remote Basic credentials deliberately fall back to plaintext IndexedDB records ([connection secret store](../../packages/ui/src/lib/connections/secrets.ts#L65)). A standalone PWA also strips host capabilities even if installed from an admin server ([runtime capabilities](../../packages/ui/src/lib/runtime-context.svelte.ts#L22)), which is a good safety choice.

**Recommendation:** define the PWA product promise narrowly and support its origin:

- call it an installable online client, not an offline assistant;
- make a stable HTTPS origin the supported remote/PWA route (for example, an operator-managed reverse proxy or the existing remote tunnel path);
- provide an explicit setup check for HTTPS origin, host allowlist, proxy headers, and remote endpoint CORS/pairing;
- warn and preferably refuse to persist reusable connection passwords on insecure non-loopback origins instead of normalizing plaintext storage as an ordinary mode;
- keep host management out of standalone PWA mode.

### F9 — Medium: artifact completeness creates release coupling that blocks clean image customization

The current rule requires the CLI, Electron, and every first-party container to carry the exact UI and skeleton they use, with no compatibility negotiation ([artifact policy](../technical/core-principles.md#artifact-completeness-and-updates)). In practice:

- the assistant rebuilds when the UI changes ([Dockerfile](../../containers/assistant/Dockerfile#L262));
- the CLI binary embeds UI and skeleton archives ([embedded assets](../../packages/cli/src/lib/embedded-assets.ts#L1));
- Electron packages both trees ([builder config](../../packages/electron/electron-builder.yml#L15));
- documentation states there is no compatibility contract because versions move together.

This is coherent for a monolithic release, but it conflicts with user-selectable assistant bases, independent optional web deployment, and derived images. A custom assistant pin can already outlive host assets, so the absence of an explicit contract does not actually prevent version skew; it makes skew unvalidated. In the intended design, Electron and the CLI should both package the same host-admin server build; the CLI also packages the managed skeleton it needs. Neither should be required to embed the separate container-served `ui-gateway`, and the assistant image should embed neither UI build.

**Recommendation:** keep artifacts self-contained but add a small, explicit compatibility contract:

- stack contract version (mounts, ports, health endpoints, UID behavior);
- OpenCode/AKM protocol and minimum versions;
- optional feature/capability list;
- UI gateway protocol version;
- immutable image digest/reference used for the deployment.

The host should validate this manifest before `compose up`. Compatibility does not require runtime downloading or a package resolver.

## Smaller and user-configurable assistant images

### Why the current image is not a minimal base

The Dockerfile has already removed roughly 1.4 GB of optional harnesses and gcloud from the default image ([Dockerfile history](../../containers/assistant/Dockerfile#L13)), which was the right move. It still combines:

- Node plus Bun and uv runtimes;
- OpenCode and AKM package trees;
- `@huggingface/transformers`, native ONNX runtime, and a roughly 128 MB local model ([model bundle](../../containers/assistant/Dockerfile#L23));
- Python plus an Apprise virtual environment;
- Git, GitHub CLI, curl, jq, SQLite, unzip, bash, and support libraries;
- supercronic;
- the complete SvelteKit server build and bundled server dependencies.

The repository documents the baked tools tree as multi-hundred-megabyte and previously had a roughly 3.5 GB install layer ([tool build](../../containers/assistant/Dockerfile#L55), [runtime tree](../../containers/assistant/Dockerfile#L248)). Docker was unavailable in the review environment, so this review does **not** claim a measured current compressed/uncompressed image size. CI should record per-platform sizes before choosing cuts. The UI is architecturally misplaced, but the model/native runtime and package trees are likely more important size targets than client assets alone.

### Recommended two-image model

| Image/preset | Contents | Intended user |
|---|---|---|
| `assistant-core` | OpenCode as the only agent harness; AKM CLI, migrations, health, task sync, and an enabled scheduler; Node/runtime libraries, tini, certificates, and only the shell/VCS/utilities required for those functions and the mount/health contract. It supports a configured embedding provider but does not bake the heavier local model/runtime. | Smallest operational OpenPalm assistant and base for custom images |
| `assistant-standard` | Everything in core plus the default local embedding runtime/model, Bun, Python 3, uv, Apprise/notification support, GitHub CLI, SQLite tooling, and the normal development/operator conveniences | Default batteries-included OpenPalm experience |

Publish only these two images initially. Both contain AKM and scheduling, and both contain only the OpenCode agent harness. Standard is a development-tool superset of core, not a multi-harness image. If a utility is genuinely required for OpenCode, AKM, scheduling, health, or the core entrypoint, it belongs in core even if it is also useful interactively; otherwise it belongs in standard. Core must report a missing embedding configuration as an explicit capability/configuration state, while standard preserves out-of-the-box local embeddings.

Additional official flavors can be introduced later if real usage justifies their maintenance cost. Until then, advanced users can derive an immutable custom image from core or standard with exact-pinned additions. Compose still deploys exactly one assistant image, and it should never install declared packages during boot.

The existing on-demand tool mechanism installs exact-pinned harnesses into `/opt/persistent` ([optional-tool skill](../../packages/skeleton/system/skills/install-optional-tool/SKILL.md#how-it-works)), and the docs already support user-derived images through `custom.compose.yml` ([persistent tools guide](../operations/persistent-assistant-tools.md#system-packages)). These are useful escape hatches, but neither is a complete product-level preset system:

- the mutable volume is not represented in `stack.env`, cannot be reproduced from an `OP_HOME` backup, and can silently outlive the base that created it;
- the custom-image workflow requires users to hand-maintain a Dockerfile and overlay without host validation of the resulting runtime contract.

Keep `/opt/persistent` for ad hoc user tooling, but use a custom derived image for reproducible additions. Do not make optional harness bundles part of `assistant-standard`; Codex, Claude Code, Copilot, Pi, or any future harness remains an explicit user customization unless a later product decision adds another official image.

### Declarative selection and validation

Add one authoritative assistant selection to `state/stack.env`, preferably a complete immutable reference such as:

```dotenv
OP_ASSISTANT_IMAGE=ghcr.io/openpalm/assistant-standard@sha256:...
OP_ASSISTANT_PRESET=standard
```

The complete image reference avoids forcing custom registries into the current `namespace + fixed repository + tag` shape. The setup wizard should offer exactly `core` and `standard` as first-party choices, plus an advanced “existing compatible image” escape hatch rather than presenting custom images as another supported flavor. The CLI can generate a small user-owned build directory/lock file for that advanced path without changing managed Compose.

Each image should include OCI labels and a machine-readable manifest such as `/usr/local/share/openpalm/image-capabilities.json`:

```json
{
  "stackContract": 1,
  "imageProfile": "standard",
  "opencode": "pinned-version",
  "akm": "pinned-version",
  "features": ["akm", "local-embedding", "scheduler", "bun", "python", "notify"],
  "harnesses": ["opencode"],
  "uiServer": false
}
```

Before deployment, the host control plane should inspect the image and verify the contract, architecture, expected UID/mount behavior, health endpoint, and required features. Presence should come from the manifest, not `command -v` probes after startup.

### UI selection

UI hosting should be orthogonal to the assistant image:

```dotenv
OP_WEB_UI_MODE=none   # none | gateway
OP_UI_IMAGE=ghcr.io/openpalm/ui-gateway@sha256:...
```

- `none` should be the normal default for the **container-served** UI: no UI container. Electron launches the shared host-admin server for its window; a CLI-only user launches that same server with `openpalm admin` when browser administration is wanted.
- `gateway` is an explicit secondary-web-client choice: Compose runs the non-admin UI sidecar and can expose it to loopback/LAN/tunnel according to existing access controls.
- The host-admin server is a host process and therefore not a Compose UI mode. Both launchers bind it to loopback.

This directly answers the user-choice requirement without multiplying assistant images merely to add or remove UI files.

## Recommended target topology

```text
Shared local administration
  Electron ── launch/adopt ──┐
                             ├── host-admin server on loopback
  openpalm admin ────────────┘     ├── shared admin frontend + setup
                                   ├── /api/host/*
                                   ├── /oc data proxy
                                   └── @openpalm/lib ── Compose/files
  ordinary CLI commands ──────────────────────┘ (direct lib calls)

                                               ┌── Electron BrowserWindow
  host-admin loopback URL ─────────────────────┤
                                               └── normal system browser

  host-admin /oc ──────────────────────────────┐
                                               ▼
                                    assistant-core or assistant-standard
                                      ├── OpenCode
                                      ├── AKM
                                      └── declared optional features

Optional web experience
  Browser / installed PWA
        │ HTTPS or loopback HTTP
        ▼
  ui-gateway (non-admin)
    ├── shared frontend build
    ├── its own login secret
    ├── /oc + selected user-facing proxies
    └── narrow settings mounts/API
        │ assistant_net ───────────────────────┘

```

Guardian and portal/addon network boundaries can remain as they are. The gateway joins only `assistant_net`; no container joins the host control plane and no Docker socket is introduced.

## Host-management recommendations

1. **Make the host-admin server a first-class shared package.** Electron and `openpalm admin` embed and launch the same compiled server, routes, setup flow, and frontend.
2. **Make Electron the primary interactive launcher.** It wraps the shared loopback endpoint and adds only native features through its constrained preload bridge.
3. **Keep the CLI equally authoritative.** `openpalm admin` gives CLI-only installations the identical browser experience, while every lifecycle operation also remains callable as a direct CLI command.
4. **Keep `@openpalm/lib` as the only lifecycle implementation.** Host-admin HTTP routes and direct CLI commands are thin consumers of the same functions.
5. **Keep host admin out of containers.** The host-admin build is not present in `ui-gateway` or the assistant image. The optional web/PWA gateway is structurally non-admin.
6. **Do not add a mandatory daemon.** The shared server is launched by Electron or `openpalm admin`; it can be adopted when already running and exits according to the owning launcher/session policy.
7. **Separate authentication by authority.** Optional served-web login, host-admin login, OpenCode upstream, and Guardian principals are different boundaries. Electron may bootstrap a session, but it still uses the host-admin server and never shares its credential with the assistant.
8. **Make lifecycle mutation explicit and transactional.** Lock, backup, migrate, validate, write, compose, health-check, and rollback should be one host operation. Merely starting the shared admin server should not mutate `OP_HOME`.
9. **Repair the lock before adding more managers.** Add nonce ownership and safe stale takeover, then ensure every state-changing CLI/API path uses it. Read-only status/log operations can remain lock-free.
10. **Implement the shared launcher/supervisor contract.** Verify canonical `OP_HOME`, contract version, ownership, child exit, restart, and teardown consistently for CLI and Electron.
11. **Add protocol/capability discovery.** The host should validate selected assistant/UI images and show incompatible custom pins before changing running containers.

## Prioritized implementation plan

### P0 — security and correctness

1. Split served-web and host-admin passwords. Keep the host-admin credential in the shared host process used by CLI/Electron, and rotate it during migration.
2. Stop advertising assistant-settings capabilities in container mode until routes use explicit, correct resource roots.
3. Prevent `runHomeMigrations()` from running in the assistant/container UI process.
4. Add lock nonces and ownership-checked release/stale takeover.
5. Put startup asset refresh and migrations under the lifecycle lock and snapshot, or make launch read-only.

### P1 — boundary cleanup

1. Extract a dedicated host-admin server build from the universal SvelteKit artifact, with thin routes over `@openpalm/lib`.
2. Embed that exact build in both CLI and Electron releases and move all launch/adopt/readiness/supervision behavior into one shared launcher.
3. Have Electron wrap the shared loopback URL; keep preload IPC for native-only functions. Have `openpalm admin` open the same URL in the system browser.
4. Strengthen the reuse probe to verify canonical `OP_HOME`, admin contract version, and build compatibility before either launcher adopts an existing server.
5. Extract the opt-in `ui-gateway` as a separate non-admin service and health domain, with no host API code.
6. Limit assistant health to assistant-core readiness.
7. Resolve the extra workspace listener/port as a deliberate supported interface rather than an incidental container UI responsibility.

### P2 — image productization

1. Measure current amd64/arm64 image size by layer and package with CI artifacts.
2. Build and test `assistant-core` and `assistant-standard` stages/images.
3. Keep AKM, task sync, and the scheduler functional and enabled in core; put the bundled local embedder/model, Bun, Python/uv, Apprise, and general development/operator tooling in standard.
4. Add `OP_ASSISTANT_IMAGE`, preset metadata, OCI labels, and a capability manifest.
5. Add a two-choice core/standard setup selection plus pre-deploy compatibility validation and an advanced custom-image escape hatch.
6. Establish HTTPS/PWA setup as an explicit secondary remote-client path.

## Verification gates for the redesign

- The assistant container cannot read the host-admin secret, even with arbitrary shell access.
- No assistant/gateway process can resolve or mutate a shadow `OP_HOME`.
- `ui-gateway` contains no `/api/host/*` handlers or Docker control-plane implementation.
- For a given OpenPalm release, Electron and `openpalm admin` serve the byte-identical host-admin build and pass the same route/behavior suite; cross-release adoption is allowed only by the declared compatibility contract.
- A CLI-only installation can complete setup and use every browser admin tool without Electron installed.
- Electron can launch or safely adopt that same server, load it in `BrowserWindow`, and layer native-only functions through guarded preload IPC.
- OpenCode remains healthy and Guardian can start when the optional UI is absent or unhealthy.
- Killing the shared host-admin child after readiness produces bounded recovery or an explicit terminal failure in both launchers.
- Concurrent lifecycle tests cover force-unlock/reacquire/release and two-process stale takeover.
- Opening CLI/Electron/PWA clients performs no managed-home writes.
- Both assistant images pass the same mount, arbitrary-UID, OpenCode health, AKM migration, scheduled-task execution, and capability-manifest contract tests; standard additionally passes offline local-embedding/search tests, while core tests configured-provider and explicit-unconfigured behavior.
- Neither official image contains an agent harness other than OpenCode.
- CI publishes compressed and unpacked image size plus per-layer deltas for core and standard on each architecture.
- PWA tests cover HTTPS installability, insecure-origin refusal/warning for stored passwords, network loss, and cross-origin pairing/CORS errors.

## Bottom line

OpenPalm does not need a wholesale rewrite. Its central choices—Compose, host-only orchestration, a shared library, a primary native desktop client, and an equivalent CLI-hosted browser admin—are good. The problem is that “one UI” and “one assistant container” have been extended into one universal server, shared secrets, shared state resolution, and shared health. Making the host-admin server a dedicated artifact shared by CLI and Electron, while making the container web/PWA gateway genuinely optional and structurally non-admin, yields a smaller and safer assistant without creating two admin implementations.
