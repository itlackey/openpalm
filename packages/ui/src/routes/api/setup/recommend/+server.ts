import { readFileSync, existsSync } from "node:fs";
import { json } from "@sveltejs/kit";
import {
	authJsonPath,
	detectGpu,
	detectHostOpenCode,
	detectLocalProviders,
	recommendSetup,
	isSetupComplete,
	resolveStackDir,
	PROVIDER_KEY_MAP,
} from "@openpalm/lib";
import { getOpenCodeClient, getRequestId, requireAdmin } from "$lib/server/helpers.js";
import { getState } from "$lib/server/state.js";
import type { RequestHandler } from "./$types";

/** Local providers are detected separately as host providers — exclude from "cloud". */
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "model-runner", "openai-compatible"]);

/** Providers that have credentials stored in OP_HOME auth.json (API key or OAuth). */
function authJsonConnected(): string[] {
	try {
		const path = authJsonPath(getState());
		if (!existsSync(path)) return [];
		const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		return Object.keys(data ?? {});
	} catch {
		return [];
	}
}

/** Fallback: providers whose API-key env var is present in the process env. */
function envKeyConnected(): string[] {
	const out: string[] = [];
	for (const [provider, envVar] of Object.entries(PROVIDER_KEY_MAP)) {
		if (process.env[envVar]) out.push(provider);
	}
	return out;
}

/** Cloud providers = OpenCode connected[] ∪ auth.json credentials, minus locals.
 *  Falls back to env-key detection when OpenCode is unavailable. */
async function detectCloudProviders(): Promise<string[]> {
	let connected: string[] = [];
	try {
		const client = getOpenCodeClient();
		if (await client.isAvailable()) {
			const catalog = await client.proxy("/provider");
			const raw = (catalog.ok ? catalog.data : {}) as { connected?: string[] };
			connected = Array.from(new Set([...(raw.connected ?? []), ...authJsonConnected()]));
		} else {
			connected = Array.from(new Set([...authJsonConnected(), ...envKeyConnected()]));
		}
	} catch {
		connected = Array.from(new Set([...authJsonConnected(), ...envKeyConnected()]));
	}
	return connected.filter((id) => !LOCAL_PROVIDER_IDS.has(id));
}

export const GET: RequestHandler = async (event) => {
	if (isSetupComplete(resolveStackDir())) {
		const requestId = getRequestId(event);
		const authError = requireAdmin(event, requestId);
		if (authError) return authError;
	}

	const [cloudProviders, gpu, localDetections, hostOpenCode] = await Promise.all([
		detectCloudProviders(),
		detectGpu(),
		detectLocalProviders(),
		Promise.resolve(detectHostOpenCode()),
	]);

	const hostProviders = localDetections
		.filter((p) => p.available)
		.map((p) => ({ provider: p.provider, url: p.url }));

	const recommendation = recommendSetup({
		cloudProviders,
		hostProviders,
		gpu,
		hostCredentialCount: hostOpenCode.credentialCount,
	});

	return json({ ok: true, recommendation, gpu, cloudProviders, hostProviders });
};
