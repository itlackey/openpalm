/**
 * OpenCode REST API client — thin wrapper over @openpalm/lib.
 *
 * Configures the shared client with the admin's OpenCode URL and
 * re-exports the same function names so existing admin routes are unchanged.
 */
import { createOpenCodeClient } from '@openpalm/lib';

const OPENCODE_BASE_URL = process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL ?? "http://localhost:4096";
const client = createOpenCodeClient({ baseUrl: OPENCODE_BASE_URL });

export const proxyToOpenCode = client.proxy;
export const getOpenCodeProviders = client.getProviders;
export const getOpenCodeProviderAuth = client.getProviderAuth;
export const setProviderApiKey = client.setProviderApiKey;
export const startProviderOAuth = client.startProviderOAuth;
export const completeProviderOAuth = client.completeProviderOAuth;
export const getOpenCodeConfig = client.getConfig;

export type { OpenCodeProvider, ProxyResult } from '@openpalm/lib';
