import { expect, test as base, type BrowserContext } from '@playwright/test';

const AMBIENT_DISCOVERY_PORTS = new Set(['3810', '3830']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isAmbientDiscoveryUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) && AMBIENT_DISCOVERY_PORTS.has(url.port);
}

export async function blockAmbientLocalDiscovery(context: BrowserContext): Promise<void> {
  await context.route(isAmbientDiscoveryUrl, (route) => route.abort('connectionrefused'));
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await blockAmbientLocalDiscovery(context);
    await use(context);
  },
});

export { expect };
