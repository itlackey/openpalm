/**
 * Bun-only launcher for the CLI setup wizard server.
 *
 * Called from Playwright tests as a child process:
 *   bun run packages/cli/e2e/start-wizard-server.ts <port>
 *
 * Starts the wizard server on the given port with a temp config directory
 * so tests do not affect real dev state. Prints "WIZARD_READY:<port>" to
 * stdout when listening, which the Playwright test waits for.
 */
import { createSetupServer } from "../src/setup-wizard/server.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import type { CoreAssetProvider } from "@openpalm/lib";

const port = parseInt(Bun.argv[2] || "18100", 10);
const tmpBase = `/tmp/openpalm-wizard-test-${port}`;

// Create minimal directory structure so the server can start.
// API endpoints that need real files are mocked at the browser level
// by Playwright's page.route(), so these dirs just prevent crashes.
mkdirSync(`${tmpBase}/config`, { recursive: true });
mkdirSync(`${tmpBase}/data`, { recursive: true });
mkdirSync(`${tmpBase}/state/artifacts`, { recursive: true });

writeFileSync(`${tmpBase}/config/secrets.env`, "# test\n");
writeFileSync(`${tmpBase}/state/artifacts/stack.env`, "OPENPALM_SETUP_COMPLETE=false\n");

// No-op asset provider — mocked tests intercept API calls before they
// reach performSetup(), so these methods are never invoked.
const noopAssetProvider: CoreAssetProvider = {
	coreCompose: () => "",
	caddyfile: () => "",
	ollamaCompose: () => "",
	agentsMd: () => "",
	opencodeConfig: () => "",
	adminOpencodeConfig: () => "",
	secretsSchema: () => "",
	stackSchema: () => "",
	cleanupLogs: () => "",
	cleanupData: () => "",
	validateConfig: () => "",
};

// Override state/config home so the server doesn't touch real dirs.
process.env.OPENPALM_CONFIG_HOME = `${tmpBase}/config`;
process.env.OPENPALM_STATE_HOME = `${tmpBase}/state`;
process.env.OPENPALM_DATA_HOME = `${tmpBase}/data`;

const { server } = createSetupServer(port, {
	configDir: `${tmpBase}/config`,
	assetProvider: noopAssetProvider,
});

console.log(`WIZARD_READY:${port}`);

// Keep alive until killed
process.on("SIGTERM", () => {
	server.stop();
	process.exit(0);
});
process.on("SIGINT", () => {
	server.stop();
	process.exit(0);
});
