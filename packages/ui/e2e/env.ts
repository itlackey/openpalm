/**
 * Shared E2E environment module.
 * Creates the temp directory on first import and exports the env map
 * for the adapter-node webServer process.
 *
 * Imported by both playwright.config.ts and global-teardown.ts.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '.e2e-state.json');

export const PORT = 13456;
export const ADMIN_TOKEN = 'test-token-e2e';

function createTempDir(): string {
	// Reuse existing tmp dir if state file exists (e.g. repeated config loads)
	if (existsSync(STATE_FILE)) {
		try {
			const { tmpDir } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
			if (tmpDir && existsSync(tmpDir)) return tmpDir;
		} catch {
			// fall through and create new
		}
	}

	const tmpDir = mkdtempSync(join(tmpdir(), 'openpalm-ui-e2e-'));

	const dataDir = join(tmpDir, 'data', 'admin');
	const configDir = join(tmpDir, 'config');
	const stateRoot = join(tmpDir, 'state');
	const cronDir = join(tmpDir, 'cron');
	const opencodeDir = join(tmpDir, 'data', 'assistant', '.config', 'opencode');
	const gatewayDir = join(stateRoot, 'gateway');
	const openmemoryDir = join(stateRoot, 'openmemory');
	const postgresDir = join(stateRoot, 'postgres');
	const qdrantDir = join(stateRoot, 'qdrant');
	const assistantDir = join(stateRoot, 'assistant');

	for (const d of [
		dataDir, configDir, stateRoot, cronDir, opencodeDir,
		gatewayDir, openmemoryDir,
		postgresDir, qdrantDir, assistantDir
	]) {
		mkdirSync(d, { recursive: true });
	}

	// Seed required empty files
	writeFileSync(join(configDir, 'secrets.env'), '', 'utf8');
	writeFileSync(join(stateRoot, '.env'), '', 'utf8');
	writeFileSync(join(stateRoot, 'system.env'), '', 'utf8');
	writeFileSync(join(gatewayDir, '.env'), '', 'utf8');
	writeFileSync(join(openmemoryDir, '.env'), '', 'utf8');
	writeFileSync(join(postgresDir, '.env'), '', 'utf8');
	writeFileSync(join(qdrantDir, '.env'), '', 'utf8');
	writeFileSync(join(assistantDir, '.env'), '', 'utf8');
	writeFileSync(join(opencodeDir, 'opencode.json'), '{\n  "plugin": []\n}\n', 'utf8');

	// Persist for teardown
	writeFileSync(STATE_FILE, JSON.stringify({ tmpDir }), 'utf8');

	return tmpDir;
}

const tmpDir = createTempDir();

export const TMP_DIR = tmpDir;

export function webServerEnv(): Record<string, string> {
	const configDir = join(tmpDir, 'config');
	const stateRoot = join(tmpDir, 'state');

	return {
		PORT: String(PORT),
		ORIGIN: `http://localhost:${PORT}`,
		ADMIN_TOKEN,
		DATA_DIR: join(tmpDir, 'data', 'admin'),
		OPENPALM_STATE_ROOT: stateRoot,
		OPENPALM_CONFIG_ROOT: configDir,
		OPENCODE_CONFIG_PATH: join(tmpDir, 'data', 'assistant', '.config', 'opencode', 'opencode.json'),
		SECRETS_ENV_PATH: join(configDir, 'secrets.env'),
		STACK_SPEC_PATH: join(configDir, 'openpalm.yaml'),
		RUNTIME_ENV_PATH: join(stateRoot, '.env'),
		SYSTEM_ENV_PATH: join(stateRoot, 'system.env'),
		COMPOSE_FILE_PATH: join(stateRoot, 'docker-compose.yml'),
		CADDY_JSON_PATH: join(stateRoot, 'caddy.json'),
		GATEWAY_ENV_PATH: join(stateRoot, 'gateway', '.env'),
		OPENMEMORY_ENV_PATH: join(stateRoot, 'openmemory', '.env'),
		POSTGRES_ENV_PATH: join(stateRoot, 'postgres', '.env'),
		QDRANT_ENV_PATH: join(stateRoot, 'qdrant', '.env'),
		ASSISTANT_ENV_PATH: join(stateRoot, 'assistant', '.env'),
		COMPOSE_PROJECT_PATH: stateRoot,
		OPENPALM_COMPOSE_FILE: 'docker-compose.yml',
		CRON_DIR: join(tmpDir, 'cron'),
		OPENPALM_COMPOSE_BIN: '/usr/bin/true',
	};
}
