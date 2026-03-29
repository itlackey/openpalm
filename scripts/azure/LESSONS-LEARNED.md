# Azure Container Apps Deployment -- Lessons Learned

Practical notes from deploying the OpenPalm stack to Azure Container Apps (ACA).

---

## 1. ACA Internal Service Discovery

Container apps in the same ACA environment **cannot** reach each other by app name alone (e.g., `http://op-assistant`). You **must** use the full internal FQDN:

```
http://<app-name>.internal.<env-default-domain>
```

The default domain is available from `managedEnvironment.properties.defaultDomain` in Bicep. Pass it to containers as an env var and build URLs from it at runtime.

## 2. AI Foundry Model Availability

Model names and SKUs vary by region. `gpt-5.4` was unavailable in `centralus` -- only `gpt-4.1` was offered. The `Standard` SKU was also missing; `GlobalStandard` worked instead.

**Always verify before deploying:**

```bash
az cognitiveservices model list -l <region> --query "[?model.name=='gpt-4.1']"
```

## 3. AI Foundry Provisioning Race

The Cognitive Services account enters an `Accepted` state during network setting changes. Any Bicep deployment that touches the account while it is transitioning fails with `AccountProvisioningStateInvalid`.

**Workaround:** Wait 30-60 seconds and retry, or skip re-deploying the AI Foundry resource when only container updates are needed.

## 4. Key Vault Lockdown vs. Deployment

When `lockDownPublicAccess=true`, Bicep sets Key Vault to `publicNetworkAccess: Disabled` and `bypass: None`. On subsequent deploys, the `deploy.ts` script cannot write secrets because it is locked out.

**Before each deploy, unlock the vault:**

```bash
az keyvault update -n <name> \
  --public-network-access Enabled \
  --bypass AzureServices \
  --default-action Allow
```

Re-lock after deployment completes if needed.

## 5. ACA Secret Refresh Requires a New Revision

Key Vault secret references in ACA are resolved **at revision creation time**. Restarting an existing revision (`az containerapp revision restart`) reuses cached secret values.

**To pick up updated Key Vault secrets, create a new revision:**

```bash
az containerapp update -n <app> -g <rg> --revision-suffix <unique-suffix>
```

## 6. SQLite on Azure Files

SQLite WAL mode does not work on Azure Files (SMB) due to file-locking limitations. Use an `EmptyDir` volume for SQLite-based workloads (OpenViking, memory) and handle backup/persistence separately.

## 7. Guardian Needs OpenCode Password

The guardian's assistant client (`@openpalm/channels-sdk/assistant-client`) sends Basic auth when `OPENCODE_SERVER_PASSWORD` is set. Even with `OPENCODE_AUTH=false` on the assistant, configure the password on the guardian for forward compatibility.

## 8. External vs. Internal Ingress and Service URLs

Apps with `external: true` ingress do **not** get an `.internal.<domain>` DNS entry. Other containers in the same environment must use the **public FQDN** (`https://<app>.politehill-xxx...`). Traffic still stays within the VNet.

Only apps with `external: false` get the internal FQDN (`http://<app>.internal.<domain>`). Use HTTPS for external FQDNs and HTTP for internal ones.

## 9. OpenViking Config File via Init Container

OpenViking requires a JSON config file at a known path. ACA does not support host volume mounts, so you cannot bind-mount a config file directly.

**Solution:** Use an init container to generate the config from env vars into an `EmptyDir` volume, then start the main container with `--config /etc/openviking/ov.conf`.

## 10. Azure OpenAI Uses Chat Completions API, Not Responses API

OpenCode's `openai` provider uses `@ai-sdk/openai` which calls the OpenAI Responses API (`/responses`). Azure OpenAI does **not** support the Responses API. You must use the `azure` provider instead (`AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` env vars, model format `azure/<deployment-name>`), which routes through `@ai-sdk/azure` and calls the correct `/openai/deployments/{name}/chat/completions` endpoint.

## 11. OpenCode Model Name vs Azure Deployment Name

OpenCode's model catalog validates model names (e.g. `gpt-4.1`). But Azure OpenAI deployments use custom names (e.g. `gpt-41`). When using the `azure` provider, you must use the **deployment name** (`azure/gpt-41`), not the model name. When using the `openai` provider (non-Azure), use the model name.

## 12. ACA Key Vault Secrets Cached Per Revision

When debugging ACA container issues, remember that every `az containerapp update --set-env-vars` creates a new revision. Old revisions with stale secrets may still be draining traffic briefly. Use `--revision-suffix` to track which revision is active and verify env vars with `az containerapp show`.

## 13. Guardian Audit Log Is the Source of Truth for Errors

The guardian only logged startup messages to stdout. Request-level errors were only in the audit file on Azure Files (`/app/audit/guardian-audit.log`). Download with `az storage file download`. This was fixed by adding `logger.error()` calls to the forward error paths.

## 14. Testing ACA Service Connectivity

Deploy a lightweight curl container (`curlimages/curl:latest`) in the same ACA environment to test internal service discovery, DNS resolution, and HTTP endpoints. This is the most reliable way to verify service-to-service connectivity when `az containerapp exec` is unavailable.

## 15. Do NOT Use AI Foundry with OpenCode's `openai` Provider

OpenCode v1.2.24's `openai` provider uses `@ai-sdk/openai` which calls the **Responses API** (`/responses`). Azure OpenAI's `/responses` endpoint requires the model parameter to match an **exact deployment name** — not a standard model name. OpenCode's model catalog validates model names against a hardcoded list, so custom deployment names like `gpt-41` are rejected with `ProviderModelNotFoundError`.

OpenCode also does not have a built-in `azure` provider. Setting `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` env vars has no effect — OpenCode ignores them.

**Working approach:** Remove all `OPENAI_*` and `AZURE_OPENAI_*` env vars. Let OpenCode use its **default built-in provider** (`opencode`/`big-pickle`). This requires no configuration and works out of the box. Wire AI Foundry to memory and OpenViking only (for embeddings and summarization), not the assistant.

## 16. ACA Revision Switchover Causes "no healthy upstream"

Every `az containerapp update` creates a new revision. During the switchover (old draining, new starting), requests may get `"no healthy upstream"` from the ACA ingress. This is transient (~30-60s) but can cause test failures if you test immediately after an update.

**Mitigation:** Always wait for the new revision to be healthy before testing. Check with `az containerapp revision list --query "[?properties.active]"` and verify health checks pass in the logs.

## 17. OpenCode Message API Is Synchronous (When Provider Works)

OpenCode's `POST /session/{id}/message` endpoint is **synchronous** — it blocks until the LLM finishes and returns the full response. It returns an empty body (`Content-Length: 0`) only when the provider is misconfigured or unavailable. If you see empty responses, the problem is the LLM provider, not the API.

## 18. Don't Fight the Framework

When deploying OpenCode to Azure, don't try to force Azure AI Foundry as the LLM provider through env var gymnastics. OpenCode has its own provider system. The correct approach is:
1. Use OpenCode's default provider for the assistant (no config needed)
2. Use AI Foundry only for services that support it natively (memory embeddings, OpenViking)
3. If you need a specific provider, check OpenCode's actual provider list (`Object.keys(s.providers)`) before configuring

## 19. ACR for Custom Images in ACA

When you need to deploy modified container images (e.g., debug builds), create an Azure Container Registry in the same resource group:

```bash
az acr create -g <rg> -n <name> --sku Basic --admin-enabled true
az acr login -n <name>
docker tag <image> <name>.azurecr.io/<repo>:<tag>
docker push <name>.azurecr.io/<repo>:<tag>
az containerapp registry set -g <rg> -n <app> --server <name>.azurecr.io --username <name> --password <key>
az containerapp update -g <rg> -n <app> --image <name>.azurecr.io/<repo>:<tag>
```
