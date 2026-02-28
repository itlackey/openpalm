import { j as json } from "../../../../chunks/json.js";
import { a as getSetupManager } from "../../../../chunks/init.js";
import { e as readRuntimeEnv } from "../../../../chunks/env-helpers.js";
import { i as isLocalRequest } from "../../../../chunks/auth.js";
import { G as GATEWAY_URL, O as OPENPALM_ASSISTANT_URL, a as OPENMEMORY_URL } from "../../../../chunks/config.js";
async function checkServiceHealth(url, expectJson = true) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3e3) });
    if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
    if (!expectJson) return { ok: true, time: (/* @__PURE__ */ new Date()).toISOString() };
    const body = await resp.json();
    return { ok: body.ok ?? true, time: body.time };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
const GET = async ({ request }) => {
  const setupManager = await getSetupManager();
  const state = setupManager.getState();
  if (!state.completed && !isLocalRequest(request)) {
    return json(403, { error: "setup endpoints are restricted to local network access" });
  }
  const runtime = readRuntimeEnv();
  const serviceInstances = {
    openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? "",
    psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? "",
    qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? ""
  };
  const openmemoryBaseUrl = serviceInstances.openmemory || OPENMEMORY_URL;
  const [gateway, assistant, openmemory] = await Promise.all([
    checkServiceHealth(`${GATEWAY_URL}/health`),
    checkServiceHealth(`${OPENPALM_ASSISTANT_URL}/`, false),
    checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`)
  ]);
  return json(200, {
    services: {
      gateway,
      assistant,
      openmemory,
      admin: { ok: true, time: (/* @__PURE__ */ new Date()).toISOString() }
    },
    serviceInstances
  });
};
export {
  GET
};
