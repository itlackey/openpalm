import { u as unauthorizedJson, j as json } from "../../../chunks/json.js";
import { a as getSetupManager, g as getStackManager, b as allChannelServiceNames, k as knownServices } from "../../../chunks/init.js";
import { i as isLocalRequest } from "../../../chunks/auth.js";
import { s as setRuntimeBindScope, u as updateDataEnv, r as readDataEnv, a as updateRuntimeEnv, b as updateSecretsEnv, v as validateSecretsRawContent, w as writeSecretsRaw, c as readSecretsEnv } from "../../../chunks/env-helpers.js";
import { a as applySmallModelToOpencodeConfig } from "../../../chunks/opencode-config.js";
import { c as completeSetupCommandResponse } from "../../../chunks/setup-completion-response.js";
import { p as parseStackSpec } from "../../../chunks/stack-spec.js";
import { s as sanitizeEnvScalar } from "../../../chunks/runtime-env.js";
import { a as applyStack } from "../../../chunks/stack-apply-engine.js";
import { composeAction, composePull, composeLogsValidateTail, composeLogs, composeList, composePs } from "../../../chunks/compose-runner.js";
import { syncAutomations, triggerAutomation } from "../../../chunks/automations.js";
import { p as parse } from "../../../chunks/index.js";
import { randomUUID } from "node:crypto";
import { R as RUNTIME_ENV_PATH, S as SECRETS_ENV_PATH } from "../../../chunks/config.js";
if (typeof globalThis.Bun === "undefined") {
  globalThis.Bun = {
    env: typeof process !== "undefined" ? process.env : {},
    spawn() {
      throw new Error("Bun.spawn not available in Node");
    },
    spawnSync() {
      throw new Error("Bun.spawnSync not available in Node");
    }
  };
}
async function upsertEnvVar(path, key, value) {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    await Bun.write(path, `${key}=${value}
`);
    return;
  }
  const content = await file.text();
  const lines = content.split("\n");
  let found = false;
  const newLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      newLines.push(`${key}=${value}`);
      found = true;
    } else {
      newLines.push(line);
    }
  }
  if (!found) {
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === "") {
      newLines.pop();
    }
    newLines.push(`${key}=${value}`);
    newLines.push("");
  }
  await Bun.write(path, newLines.join("\n"));
}
async function normalizeSelectedChannels(value) {
  if (!Array.isArray(value)) return [];
  const validServices = new Set(await allChannelServiceNames());
  const selected = [];
  for (const service of value) {
    if (typeof service !== "string") continue;
    if (!validServices.has(service)) continue;
    if (selected.includes(service)) continue;
    selected.push(service);
  }
  return selected;
}
function getConfiguredOpenmemoryProvider() {
  const secrets = readSecretsEnv();
  return {
    openaiBaseUrl: secrets.OPENAI_BASE_URL ?? "",
    openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
  };
}
async function getConfiguredSmallModel() {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  const secrets = readSecretsEnv();
  return {
    endpoint: state.smallModel.endpoint,
    modelId: state.smallModel.modelId,
    apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
  };
}
const POST = async ({ locals, request }) => {
  const body = await request.json();
  const payload = body.payload ?? {};
  const type = body.type ?? "";
  const setupManager = await getSetupManager();
  const setupState = setupManager.getState();
  const setupCommand = type.startsWith("setup.");
  const localSetupRequest = setupCommand && !setupState.completed && isLocalRequest(request);
  if (!locals.authenticated && !localSetupRequest) return unauthorizedJson();
  if (!locals.authenticated && setupCommand && !isLocalRequest(request)) {
    return json(403, { ok: false, error: "setup endpoints are restricted to local network access" });
  }
  const stackManager = await getStackManager();
  try {
    if (type === "stack.render")
      return json(200, { ok: true, data: stackManager.renderPreview() });
    if (type === "stack.spec.set") {
      const spec = parseStackSpec(payload.spec);
      const missing = stackManager.validateReferencedSecrets(spec);
      if (missing.length > 0)
        return json(400, {
          ok: false,
          error: "missing secret references",
          code: "missing_secret_references",
          details: missing
        });
      try {
        return json(200, { ok: true, data: stackManager.setSpec(spec) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(400, { ok: false, error: message, code: message });
      }
    }
    if (type === "stack.apply") {
      const result = await applyStack(stackManager, { apply: true });
      return json(200, { ok: true, data: result });
    }
    if (type === "stack.catalog.item") {
      const action = payload.action === "install" || payload.action === "uninstall" || payload.action === "configure" || payload.action === "add_instance" ? payload.action : "";
      const itemType = payload.itemType === "channel" || payload.itemType === "service" ? payload.itemType : "";
      const name = sanitizeEnvScalar(payload.name);
      if (!action || !itemType || !name) {
        return json(400, {
          ok: false,
          error: "invalid_catalog_item_payload",
          code: "invalid_catalog_item_payload"
        });
      }
      const item = stackManager.mutateStackCatalogItem({
        action,
        type: itemType,
        name,
        templateName: payload.templateName,
        supportsMultipleInstances: payload.supportsMultipleInstances,
        displayName: payload.displayName,
        description: payload.description,
        fields: payload.fields,
        image: payload.image,
        containerPort: payload.containerPort,
        rewritePath: payload.rewritePath,
        sharedSecretEnv: payload.sharedSecretEnv,
        volumes: payload.volumes,
        dependsOn: payload.dependsOn,
        exposure: payload.exposure,
        config: payload.config
      });
      return json(200, { ok: true, data: { item } });
    }
    if (type === "setup.step") {
      const step = sanitizeEnvScalar(payload.step);
      const validSteps = [
        "welcome",
        "profile",
        "accessScope",
        "serviceInstances",
        "healthCheck",
        "security",
        "channels"
      ];
      if (!validSteps.includes(step))
        return json(400, { ok: false, error: "invalid_step", code: "invalid_step" });
      const state = setupManager.completeStep(
        step
      );
      return json(200, { ok: true, data: state });
    }
    if (type === "setup.access_scope") {
      const scope = payload.scope;
      if (scope !== "host" && scope !== "lan" && scope !== "public")
        return json(400, { ok: false, error: "invalid_scope", code: "invalid_scope" });
      stackManager.setAccessScope(scope);
      await setRuntimeBindScope(scope);
      return json(200, { ok: true, data: setupManager.setAccessScope(scope) });
    }
    if (type === "setup.profile") {
      const name = sanitizeEnvScalar(payload.name);
      const email = sanitizeEnvScalar(payload.email);
      const password = typeof payload.password === "string" ? payload.password.trim() : "";
      await updateDataEnv({
        OPENPALM_PROFILE_NAME: name || void 0,
        OPENPALM_PROFILE_EMAIL: email || void 0
      });
      if (password.length >= 8) {
        await upsertEnvVar(RUNTIME_ENV_PATH, "ADMIN_TOKEN", password);
      }
      const state = setupManager.setProfile({ name, email });
      stackManager.renderArtifacts();
      const dataEnv = readDataEnv();
      return json(200, {
        ok: true,
        data: {
          state,
          profile: {
            name: dataEnv.OPENPALM_PROFILE_NAME ?? state.profile.name,
            email: dataEnv.OPENPALM_PROFILE_EMAIL ?? state.profile.email
          }
        }
      });
    }
    if (type === "setup.service_instances") {
      const openmemory = sanitizeEnvScalar(payload.openmemory);
      const psql = sanitizeEnvScalar(payload.psql);
      const qdrant = sanitizeEnvScalar(payload.qdrant);
      const openaiBaseUrl = sanitizeEnvScalar(payload.openaiBaseUrl);
      const openaiApiKey = sanitizeEnvScalar(payload.openaiApiKey);
      const anthropicApiKey = sanitizeEnvScalar(payload.anthropicApiKey);
      const smallModelEndpoint = sanitizeEnvScalar(payload.smallModelEndpoint);
      const smallModelApiKey = sanitizeEnvScalar(payload.smallModelApiKey);
      const smallModelId = sanitizeEnvScalar(payload.smallModelId);
      updateRuntimeEnv({
        OPENMEMORY_URL: openmemory || void 0,
        OPENMEMORY_POSTGRES_URL: psql || void 0,
        OPENMEMORY_QDRANT_URL: qdrant || void 0
      });
      const secretEntries = {
        OPENAI_BASE_URL: openaiBaseUrl || void 0
      };
      if (openaiApiKey.length > 0) secretEntries.OPENAI_API_KEY = openaiApiKey;
      if (anthropicApiKey.length > 0) secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
      if (smallModelApiKey.length > 0)
        secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
      await updateSecretsEnv(secretEntries);
      const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });
      if (smallModelId) {
        setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
        applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
      }
      return json(200, {
        ok: true,
        data: {
          state,
          openmemoryProvider: getConfiguredOpenmemoryProvider(),
          smallModelProvider: await getConfiguredSmallModel()
        }
      });
    }
    if (type === "setup.channels") {
      const channels = await normalizeSelectedChannels(payload.channels);
      await updateRuntimeEnv({
        OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(",") : void 0
      });
      const channelConfigs = payload.channelConfigs;
      if (channelConfigs && typeof channelConfigs === "object") {
        const validServices = new Set(await allChannelServiceNames());
        for (const [service, values] of Object.entries(
          channelConfigs
        )) {
          if (!validServices.has(service) || typeof values !== "object" || values === null)
            continue;
          const channelName = service.replace(/^channel-/, "");
          stackManager.setChannelConfig(channelName, values);
        }
      }
      const spec = stackManager.getSpec();
      for (const channelName of stackManager.listChannelNames()) {
        const service = `channel-${channelName}`;
        spec.channels[channelName].enabled = channels.includes(service);
      }
      stackManager.setSpec(spec);
      return json(200, { ok: true, data: setupManager.setEnabledChannels(channels) });
    }
    if (type === "setup.complete") {
      return json(
        200,
        await completeSetupCommandResponse(setupManager, stackManager, SECRETS_ENV_PATH)
      );
    }
    if (type === "setup.retry_core") {
      const { setCoreReadinessPhase, applyReadinessResult } = await import("../../../chunks/core-readiness-state.js");
      const { ensureCoreServicesReady } = await import("../../../chunks/core-readiness.js");
      const { SetupStartupServices } = await import("../../../chunks/compose-runner.js");
      setCoreReadinessPhase("checking");
      try {
        const result = await ensureCoreServicesReady({
          targetServices: SetupStartupServices,
          maxAttempts: 6,
          pollIntervalMs: 2e3
        });
        const snapshot = applyReadinessResult(result);
        return json(200, { ok: true, data: snapshot });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setCoreReadinessPhase("failed");
        return json(500, { ok: false, error: message, code: "readiness_check_failed" });
      }
    }
    if (type === "channel.configure") {
      const channel = sanitizeEnvScalar(payload.channel);
      const exposure = typeof payload.exposure === "string" ? payload.exposure : "";
      if (!channel)
        return json(400, {
          ok: false,
          error: "invalid_channel",
          code: "invalid_channel"
        });
      if (exposure === "host" || exposure === "lan" || exposure === "public")
        stackManager.setChannelAccess(channel, exposure);
      if (payload.config !== void 0 && typeof payload.config === "object" && payload.config !== null) {
        const config = {};
        for (const [k, v] of Object.entries(payload.config)) {
          if (typeof v === "string") config[k] = v;
        }
        stackManager.setChannelConfig(channel, config);
      }
      return json(200, {
        ok: true,
        data: {
          channel,
          exposure: stackManager.getChannelAccess(channel),
          config: stackManager.getChannelConfig(channel)
        }
      });
    }
    if (type === "secret.upsert") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const value = typeof payload.value === "string" ? payload.value : "";
      if (!name)
        return json(400, {
          ok: false,
          error: "name is required",
          code: "invalid_payload"
        });
      return json(200, { ok: true, data: { name: stackManager.upsertSecret(name, value) } });
    }
    if (type === "secret.delete") {
      const name = typeof payload.name === "string" ? payload.name : "";
      if (!name)
        return json(400, {
          ok: false,
          error: "name is required",
          code: "invalid_payload"
        });
      return json(200, {
        ok: true,
        data: { name: stackManager.deleteSecret(name) }
      });
    }
    if (type === "secret.set_admin_password") {
      const password = typeof payload.password === "string" ? payload.password.trim() : "";
      if (password.length < 8) {
        return json(400, { ok: false, error: "Password must be at least 8 characters.", code: "invalid_password" });
      }
      await upsertEnvVar(RUNTIME_ENV_PATH, "ADMIN_TOKEN", password);
      await composeAction("restart", "admin");
      return json(200, { ok: true });
    }
    if (type === "secret.raw.set") {
      const content = typeof payload.content === "string" ? payload.content : "";
      const validationError = validateSecretsRawContent(content);
      if (validationError)
        return json(400, {
          ok: false,
          error: validationError,
          code: "invalid_secrets_content"
        });
      writeSecretsRaw(content);
      stackManager.renderArtifacts();
      return json(200, { ok: true, data: { updated: true } });
    }
    if (type === "automation.upsert") {
      const name = typeof payload.name === "string" ? payload.name : "";
      const schedule = typeof payload.schedule === "string" ? payload.schedule : "";
      const script = typeof payload.script === "string" ? payload.script : "";
      if (!name || !schedule || !script)
        return json(400, {
          ok: false,
          error: "name, schedule, and script are required",
          code: "invalid_payload"
        });
      const id = typeof payload.id === "string" ? payload.id : randomUUID();
      const enabled = typeof payload.enabled === "boolean" ? payload.enabled : true;
      const automation = stackManager.upsertAutomation({
        id,
        name,
        schedule,
        enabled,
        script
      });
      syncAutomations(stackManager.listAutomations());
      return json(200, { ok: true, data: automation });
    }
    if (type === "automation.delete") {
      const id = typeof payload.id === "string" ? payload.id : "";
      if (!id)
        return json(400, { ok: false, error: "id is required", code: "invalid_payload" });
      try {
        const removed = stackManager.deleteAutomation(id);
        syncAutomations(stackManager.listAutomations());
        return json(200, { ok: true, data: { removed } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "cannot_delete_core_automation")
          return json(400, { ok: false, error: message, code: message });
        throw error;
      }
    }
    if (type === "snippet.import") {
      const yamlStr = typeof payload.yaml === "string" ? payload.yaml : "";
      const section = typeof payload.section === "string" ? payload.section : "";
      if (!yamlStr)
        return json(400, {
          ok: false,
          error: "yaml is required",
          code: "invalid_payload"
        });
      if (section !== "channel" && section !== "service" && section !== "automation") {
        return json(400, {
          ok: false,
          error: "section must be 'channel', 'service', or 'automation'",
          code: "invalid_payload"
        });
      }
      const parsed = parse(yamlStr);
      const spec = stackManager.getSpec();
      if (section === "channel") {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return json(400, {
            ok: false,
            error: "channel snippet must be a YAML object",
            code: "invalid_snippet"
          });
        }
        for (const [name, value] of Object.entries(
          parsed
        )) {
          if (typeof value !== "object" || value === null || !value.image) {
            return json(400, {
              ok: false,
              error: `invalid_snippet: channel '${name}' must have an 'image' field`,
              code: "invalid_snippet"
            });
          }
          spec.channels[name] = value;
        }
      } else if (section === "service") {
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return json(400, {
            ok: false,
            error: "service snippet must be a YAML object",
            code: "invalid_snippet"
          });
        }
        for (const [name, value] of Object.entries(
          parsed
        )) {
          if (typeof value !== "object" || value === null || !value.image) {
            return json(400, {
              ok: false,
              error: `invalid_snippet: service '${name}' must have an 'image' field`,
              code: "invalid_snippet"
            });
          }
          spec.services[name] = value;
        }
      } else {
        const items = Array.isArray(parsed) ? parsed : [parsed];
        const nextAutomations = [];
        for (const item of items) {
          if (typeof item !== "object" || item === null) {
            return json(400, {
              ok: false,
              error: "invalid_snippet: automation must be an object",
              code: "invalid_snippet"
            });
          }
          const candidate = item;
          const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : randomUUID();
          const name = typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : "Imported automation";
          const schedule = typeof candidate.schedule === "string" ? candidate.schedule.trim() : "";
          const script = typeof candidate.script === "string" ? candidate.script.trim() : typeof candidate.prompt === "string" ? candidate.prompt.trim() : "";
          const enabled = typeof candidate.enabled === "boolean" ? candidate.enabled : true;
          if (!schedule || !script) {
            return json(400, {
              ok: false,
              error: "invalid_snippet: automation must have 'schedule' and 'script' (or 'prompt') fields",
              code: "invalid_snippet"
            });
          }
          const automation = { id, name, schedule, script, enabled };
          if (typeof candidate.description === "string" && candidate.description.trim()) {
            automation.description = candidate.description.trim();
          }
          nextAutomations.push(automation);
        }
        spec.automations.push(...nextAutomations);
      }
      try {
        const validated = stackManager.setSpec(spec);
        return json(200, { ok: true, data: { spec: validated } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(400, { ok: false, error: message, code: message });
      }
    }
    if (type === "automation.trigger") {
      const id = sanitizeEnvScalar(payload.id);
      if (!id)
        return json(400, { ok: false, error: "id_required", code: "id_required" });
      if (!stackManager.getAutomation(id))
        return json(404, {
          ok: false,
          error: "automation_not_found",
          code: "automation_not_found"
        });
      const result = await triggerAutomation(id);
      return json(200, { ok: true, data: { id, ...result } });
    }
    if (type === "service.restart") {
      const service = sanitizeEnvScalar(payload.service);
      if (!(await knownServices()).has(service))
        return json(400, {
          ok: false,
          error: "service_not_allowed",
          code: "service_not_allowed"
        });
      const result = await composeAction("restart", service);
      if (!result.ok) throw new Error(result.stderr || "service_restart_failed");
      return json(200, { ok: true, data: { service } });
    }
    if (type === "service.stop") {
      const service = sanitizeEnvScalar(payload.service);
      if (!(await knownServices()).has(service))
        return json(400, {
          ok: false,
          error: "service_not_allowed",
          code: "service_not_allowed"
        });
      const result = await composeAction("stop", service);
      if (!result.ok) throw new Error(result.stderr || "service_stop_failed");
      return json(200, { ok: true, data: { service } });
    }
    if (type === "service.up") {
      const service = sanitizeEnvScalar(payload.service);
      if (!(await knownServices()).has(service))
        return json(400, {
          ok: false,
          error: "service_not_allowed",
          code: "service_not_allowed"
        });
      const result = await composeAction("up", service);
      if (!result.ok) throw new Error(result.stderr || "service_up_failed");
      return json(200, { ok: true, data: { service } });
    }
    if (type === "service.update") {
      const service = sanitizeEnvScalar(payload.service);
      if (!(await knownServices()).has(service))
        return json(400, {
          ok: false,
          error: "service_not_allowed",
          code: "service_not_allowed"
        });
      const pullResult = await composePull(service);
      if (!pullResult.ok) throw new Error(pullResult.stderr || "service_pull_failed");
      const result = await composeAction("up", service);
      if (!result.ok) throw new Error(result.stderr || "service_up_failed");
      return json(200, { ok: true, data: { service } });
    }
    if (type === "service.logs") {
      const service = sanitizeEnvScalar(payload.service);
      if (payload.tail !== void 0 && typeof payload.tail !== "number")
        return json(400, { ok: false, error: "invalid_tail", code: "invalid_tail" });
      const tail = typeof payload.tail === "number" ? payload.tail : 200;
      if (!(await knownServices()).has(service))
        return json(400, {
          ok: false,
          error: "service_not_allowed",
          code: "service_not_allowed"
        });
      if (!composeLogsValidateTail(tail))
        return json(400, { ok: false, error: "invalid_tail", code: "invalid_tail" });
      const result = await composeLogs(service, tail);
      if (!result.ok) throw new Error(result.stderr || "service_logs_failed");
      return json(200, { ok: true, data: { service, tail, logs: result.stdout } });
    }
    if (type === "service.status") {
      const result = await composeList();
      if (!result.ok) throw new Error(result.stderr || "service_status_failed");
      let services = result.stdout;
      try {
        services = JSON.parse(result.stdout);
      } catch {
        services = result.stdout;
      }
      return json(200, { ok: true, data: { services } });
    }
    if (type === "service.drift") {
      const result = await composePs();
      if (!result.ok) return json(500, { ok: false, error: result.stderr });
      return json(200, { ok: true, data: { services: result.services } });
    }
    return json(400, { ok: false, error: "unknown_command", code: "unknown_command" });
  } catch (error) {
    return json(400, { ok: false, error: String(error), code: "command_failed" });
  }
};
export {
  POST
};
