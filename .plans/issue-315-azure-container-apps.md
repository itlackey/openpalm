# Issue #315: Azure Container Apps Deployment with Key Vault Integration

## Scope

Add a documented Azure Container Apps (ACA) deployment path for OpenPalm that runs the core runtime path (`channel -> guardian -> assistant -> memory`) without the self-hosted Admin control plane. The target output for this issue is primarily deployment automation and documentation: Azure deployment scripts, ACA app definitions or generated YAML, Key Vault-backed secret wiring, operator docs, and release-note updates.

## Dependency summary

- Roadmap position: independent parallel track in v0.10.0, explicitly described as additive with no required core product changes (`.github/roadmap/0.10.0/README.md:128`).
- Architectural constraints still apply: guardian-only ingress, assistant isolation, host-or-admin orchestration model replaced here by Azure operator automation, and file-assembly/no-template-rendering rules where repo-managed files are involved (`docs/technical/core-principles.md:21`, `docs/technical/core-principles.md:30`, `docs/technical/core-principles.md:193`).
- Existing runtime already supports the needed separation: admin tool calls fail closed to error JSON when Admin is absent (`packages/admin-tools/opencode/tools/lib.ts:1`).
- ACA docs should target the 0.10.0 self-hosted filesystem contract (`~/.openpalm/`, vault boundary, data/logs split) and explicitly describe where the cloud deployment intentionally diverges rather than repeating older XDG-era assumptions (`assets/docker-compose.yml:9`, `docs/technical/environment-and-mounts.md:144`).

## Planning position on repo changes

- Expected primary work: deploy/docs only.
- Repo code changes should not be required for the first implementation if the current container images run correctly on ACA with env-var overrides.
- Acceptable repo changes, only if validation proves they are necessary:
  - small deployment-facing image fixes such as probe compatibility or startup path corrections;
  - documentation references to the new Azure path;
  - no Admin control-plane feature work, no new cloud control plane, no ACA-specific branching in core runtime logic unless a concrete runtime incompatibility is found.

## Out of scope

The following are intentionally out of scope for #315 and should not be smuggled in as part of this work:

- Running the existing Admin container or recreating its Docker-socket-based control plane inside ACA.
- Reworking `@openpalm/lib`, CLI lifecycle, or Admin APIs to manage ACA resources.
- Unifying self-hosted secret resolution with ACA into a new shared Azure secret backend for 0.10.0.
- Scheduler/automation parity in ACA beyond documenting alternatives.
- Full IaC coverage for every enterprise Azure topology (private networking, hub-spoke, policy packs, Terraform module ecosystem).
- General cloud-hosting abstraction for AWS/GCP/Kubernetes.

## Implementation breakdown

### 1. Deployment script and command structure

- Add `deploy/azure/deploy-aca.sh` as the operator entrypoint described in the issue and roadmap.
- Implement explicit subcommands: `setup`, `deploy`, `all`, `add-channel`, `status`, and `teardown`.
- Keep the script idempotent where practical: safe re-runs for resource group, storage account, file shares, managed identity, Key Vault, and ACA environment creation.
- Use `az` CLI with argument arrays and generated YAML files where needed; avoid ad hoc shell interpolation for secrets or multi-line resource blobs.
- Create per-service ACA definitions for `memory`, `assistant`, `guardian`, and `channel-chat`, deployed in dependency order so service FQDNs can be injected into downstream apps.
- Standardize script outputs around operator-visible values: resource group, ACA environment, app names, ingress URL, Key Vault name, storage account, and mounted share names.

### 2. Infrastructure definitions

- Choose one implementation style and document it in the script/README:
  - preferred: checked-in ACA YAML definitions under `deploy/azure/apps/` plus `az containerapp create/update --yaml`;
  - acceptable alternative: Bicep templates under `deploy/azure/infra/` invoked by the shell script.
- Provision these Azure resources:
  - resource group;
  - ACA environment;
  - storage account;
  - Azure Files shares for config/data/work;
  - Azure Container Registry dependency inputs or documented assumption that images are public/pre-pushed;
  - Key Vault;
  - user-assigned managed identity.
- Define container sizing, min/max replicas, ingress mode, probes, revision mode, and volume mounts for each app.
- Preserve network intent from core principles even though ACA is not LAN-first: `channel-chat` external, `guardian` internal, `assistant` internal, `memory` internal.
- Explicitly document the cloud deviation that ACA public ingress is internet-routable by default and is not equivalent to the self-hosted LAN-first posture.

### 3. Secrets and Key Vault integration

- Create Key Vault before deploying apps; do not use inline ACA secrets as an intermediate step.
- Store all generated and operator-supplied secrets in Key Vault first:
  - assistant token or admin-facing token equivalent needed by guardian/assistant wiring;
  - memory auth token;
  - `CHANNEL_CHAT_SECRET` and future per-channel HMAC secrets;
  - LLM provider secrets such as `OPENAI_API_KEY`.
- Create a user-assigned managed identity and grant it `Key Vault Secrets User` access scoped to the vault.
- Attach the managed identity to each ACA app and reference secrets through `keyVaultUrl`/identity references.
- Ensure token scoping matches current architecture guidance:
  - assistant should not receive a broad admin token if an assistant-scoped token exists for the path being used;
  - guardian should receive only the secrets it needs for message forwarding/auth;
  - memory should receive only memory auth and model-provider secrets it consumes.
- Document the deliberate two-path secret model:
  - self-hosted path uses env files and shared control-plane logic;
  - ACA path uses native Azure Key Vault references.

### 4. Filesystem and mount mapping

- Translate the self-hosted `~/.openpalm/` mount model into ACA-compatible Azure Files mounts.
- Implement and document the minimum viable share layout for ACA:
  - `openpalm-data` for durable service data;
  - `openpalm-config` for operator-managed config/extensions;
  - `openpalm-work` for assistant workspace.
- Seed required directory structure onto the shares during `setup` so containers do not rely on Admin bootstrap helpers.
- Seed the memory default config file expected by the memory service if it is not already present (`packages/lib/src/control-plane/memory-config.ts:224`).
- Document the intentional deviation that the self-hosted `config/`, `vault/`, `data/`, and `logs/` separation is partly re-expressed through Azure Files plus Key Vault, and explain the operational implications for backups, secret rotation, and disposability.

### 5. Channel add flow

- Implement `deploy-aca.sh add-channel <name> <package> <port>` as the ACA analogue of file-drop channel installation.
- Reuse the existing registry/channel shape conceptually:
  - one app per channel;
  - one `CHANNEL_<NAME>_SECRET` HMAC secret;
  - `GUARDIAN_URL` targeting the internal guardian endpoint;
  - `CHANNEL_PACKAGE` identifying the channel package when the unified `channel` image is used (`registry/channels/chat.yml:1`).
- The add-channel flow should:
  - generate or accept the channel secret;
  - write the secret to Key Vault;
  - deploy a new ACA app for the channel with correct env vars, mounts, probes, and scaling;
  - optionally expose ingress only when the channel requires a public endpoint.
- Make the management divergence explicit in docs: self-hosted channel install remains Admin/CLI/file-drop based, while ACA uses the deployment script.

### 6. Documentation

- Add `deploy/azure/README.md` covering prerequisites, Azure roles, required CLIs, naming inputs, costs, image assumptions, deploy flow, operations, and teardown.
- Document the runtime topology without Admin and explain that assistant admin tools will return connection-error JSON instead of managing the stack.
- Add an architecture note in the Azure README covering:
  - guardian-only ingress still applies;
  - ACA ingress replaces Caddy for exposed endpoints;
  - no Docker socket or Admin orchestration exists in this deployment mode;
  - cloud exposure differs from LAN-first self-hosted defaults;
  - Key Vault replaces the self-hosted vault mount path for deployed secrets, while Azure Files approximates the durable `data/` and operator-managed config surfaces.
- Add troubleshooting notes for common failures: Key Vault access denied, ACA revision startup failures, volume mount issues, missing health probe endpoints, and stale internal FQDN wiring.
- Update user-facing repo docs to reference Azure as an alternative deployment target rather than the primary path.

### 7. Validation and testing

- Validate the shell script with `shellcheck` if available and at minimum run `bash -n`.
- Smoke-test the full operator path in a real Azure subscription:
  - `setup`;
  - `deploy`;
  - send a request through `channel-chat`;
  - verify guardian accepts signed traffic;
  - verify assistant can answer without Admin;
  - verify memory persistence survives a revision restart;
  - `add-channel` for at least one additional channel package;
  - `teardown` cleanup.
- Confirm secrets never appear in checked-in YAML, script logs, or `az containerapp show` output as literal values.
- Confirm each app uses only the env vars and secrets it actually needs.
- Capture a short operator verification checklist in the Azure README for future regression testing.

### 8. Release and project documentation updates

- Add an `Unreleased` changelog entry describing Azure Container Apps deployment support and its non-self-hosted scope (`CHANGELOG.md:8`).
- Add a concise Azure deployment reference in the root README deployment/docs section (`README.md:109`).
- If release notes are otherwise maintained from roadmap docs, add a note that ACA is a parallel deployment target with no Admin UI.

## Acceptance criteria

- `deploy/azure/deploy-aca.sh` exists and documents/implements the supported subcommands.
- The deployment path provisions ACA, Azure Files, Key Vault, and managed identity without storing runtime secrets inline in repo files.
- The deployed stack successfully runs `channel-chat -> guardian -> assistant -> memory` without the Admin container.
- `guardian` is internal-only and exposed channels route through it, not directly to the assistant.
- At least one `add-channel` flow is documented and validated for a registry-style channel package.
- Azure docs clearly state the differences from self-hosted OpenPalm, especially lack of Admin UI/control plane and the storage/secret-model deviation from the `~/.openpalm/` self-hosted contract.
- Repo documentation updates make it clear this is an additional deployment target, not a replacement for Docker Compose self-hosting.
- No unrelated core runtime changes are introduced.

## Risks and watchouts

- Public exposure mismatch: ACA ingress is not LAN-first by default, so docs must not imply self-hosted security posture.
- Secret leakage risk: using `az containerapp secret set` with raw values, temporary files, or echoed commands could expose secrets in history or resource inspection.
- Token scope drift: reusing `ADMIN_TOKEN` semantics in ACA could overprivilege the assistant path.
- Mount-model mismatch: current code/docs assume local XDG directories and staged artifacts; ACA storage must be treated as a documented deployment exception.
- Operational divergence: ACA becomes a permanent shell-script/operator experience for channel management, not Admin/UI management.
- Cost and quota surprises: ACA environment, Azure Files, and Key Vault all add recurring cost and region/service constraints.

## Relevant files

- `.github/roadmap/0.10.0/README.md:128` - roadmap entry for #315, including additive/no-core-change expectation.
- `docs/technical/core-principles.md:21` - security invariants that the ACA deployment must preserve conceptually.
- `docs/technical/core-principles.md:30` - file-assembly and shared-control-plane rules; useful for defining what ACA does not reuse.
- `docs/technical/core-principles.md:193` - operational model for adding components and apply behavior in the self-hosted path.
- `assets/docker-compose.yml:14` - current service inventory, env vars, ports, and mount expectations to translate into ACA definitions.
- `docs/technical/environment-and-mounts.md:144` - current staged env-file model that ACA intentionally diverges from.
- `packages/lib/src/control-plane/paths.ts:1` - current XDG directory assumptions that should remain untouched for this issue.
- `packages/lib/src/control-plane/memory-config.ts:224` - expected memory config file location that ACA setup may need to seed.
- `packages/admin-tools/opencode/tools/lib.ts:1` - proof that assistant admin calls already fail gracefully when Admin is absent.
- `core/guardian/src/server.ts:27` - guardian env vars for assistant URL, audit path, and channel secret loading.
- `registry/channels/chat.yml:1` - reference shape for channel deployment inputs and env vars.
- `docs/how-it-works.md:116` - baseline message flow that ACA must preserve.
- `docs/how-it-works.md:269` - self-hosted channel add flow to contrast with ACA's script-based flow.
- `README.md:109` - docs index area likely needing an Azure deployment link.
- `CHANGELOG.md:8` - `Unreleased` section for release-note coverage.

## Suggested deliverables

- `deploy/azure/deploy-aca.sh`
- `deploy/azure/README.md`
- `deploy/azure/apps/*.yaml` or `deploy/azure/infra/*.bicep` (pick one pattern and keep it consistent)
- `README.md` update
- `CHANGELOG.md` update
