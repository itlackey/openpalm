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

const port = parseInt(Bun.argv[2] || "18100", 10);
const tmpBase = `/tmp/openpalm-wizard-test-${port}`;

// Create minimal directory structure so the server can start.
// API endpoints that need real files are mocked at the browser level
// by Playwright's page.route(), so these dirs just prevent crashes.
mkdirSync(`${tmpBase}/config`, { recursive: true });
mkdirSync(`${tmpBase}/config/automations`, { recursive: true });
mkdirSync(`${tmpBase}/data`, { recursive: true });
mkdirSync(`${tmpBase}/data/assistant`, { recursive: true });
mkdirSync(`${tmpBase}/stack`, { recursive: true });
mkdirSync(`${tmpBase}/vault/stack`, { recursive: true });
mkdirSync(`${tmpBase}/vault/user`, { recursive: true });

writeFileSync(`${tmpBase}/vault/stack/stack.env`, "OP_SETUP_COMPLETE=false\n");
writeFileSync(`${tmpBase}/vault/user/user.env`, "# test\n");

// Seed minimal asset files so performSetup() can read them if invoked
writeFileSync(`${tmpBase}/stack/core.compose.yml`, "services:\n  admin:\n    image: admin:latest\n");
writeFileSync(`${tmpBase}/data/assistant/opencode.jsonc`, '{"$schema":"https://opencode.ai/config.json"}\n');
writeFileSync(`${tmpBase}/data/assistant/AGENTS.md`, "# Agents\n");
writeFileSync(`${tmpBase}/vault/user/user.env.schema`, "OP_ADMIN_TOKEN=string\n");
writeFileSync(`${tmpBase}/vault/stack/stack.env.schema`, "OP_IMAGE_TAG=string\n");
writeFileSync(`${tmpBase}/config/automations/cleanup-logs.yml`, "name: cleanup-logs\nschedule: daily\n");
writeFileSync(`${tmpBase}/config/automations/cleanup-data.yml`, "name: cleanup-data\nschedule: weekly\n");
writeFileSync(`${tmpBase}/config/automations/validate-config.yml`, "name: validate-config\nschedule: hourly\n");

// Override state/config home so the server doesn't touch real dirs.
process.env.OP_HOME = tmpBase;

const { server } = createSetupServer(port, {
	configDir: `${tmpBase}/config`,
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
