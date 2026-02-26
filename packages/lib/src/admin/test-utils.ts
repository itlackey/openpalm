/**
 * Test utilities for resetting OpenPalm server state to first-boot condition.
 *
 * Provides `resetServerState()` for cleaning a populated state directory and
 * `createTestDirLayout()` for scaffolding a fresh temp directory with the
 * expected directory structure.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Layout descriptor matching the directory conventions used by StackManager
 * and the E2E test harness. All paths are relative to `tmpDir`.
 */
export type ServerDirLayout = {
  dataAdmin: string;
  stateRoot: string;
  config: string;
};

const DEFAULT_LAYOUT: ServerDirLayout = {
  dataAdmin: "data/admin",
  stateRoot: "state",
  config: "config",
};

/**
 * Generated artifacts that are removed during reset.
 * Relative to stateRoot.
 */
const STATE_ARTIFACTS = [
  "docker-compose.yml",
  "docker-compose.yml.next",
  "caddy.json",
  "render-report.json",
  "system.env",
  ".env",
] as const;

/**
 * Known service subdirectories under stateRoot that contain generated .env files.
 */
const SERVICE_ENV_DIRS = [
  "gateway",
  "openmemory",
  "postgres",
  "qdrant",
  "assistant",
] as const;

/**
 * Resets the server state directory to first-boot condition.
 *
 * - Removes generated artifacts (docker-compose.yml, caddy.json, service .env files, etc.)
 * - Removes the stack spec (openpalm.yaml) and secrets.env
 * - Preserves the directory structure itself (directories are not removed)
 *
 * Callable in `beforeAll` / `beforeEach` for any test group that needs first-boot state.
 *
 * @param tmpDir - Root of the test directory tree
 * @param layout - Optional layout override (defaults match E2E conventions)
 */
export function resetServerState(
  tmpDir: string,
  layout: Partial<ServerDirLayout> = {}
): void {
  const dirs = { ...DEFAULT_LAYOUT, ...layout };

  const stateRootDir = join(tmpDir, dirs.stateRoot);
  const configDir = join(tmpDir, dirs.config);

  // 1. Remove generated state artifacts
  for (const artifact of STATE_ARTIFACTS) {
    rmSync(join(stateRootDir, artifact), { force: true });
  }

  // 2. Remove known service .env files
  for (const svcDir of SERVICE_ENV_DIRS) {
    rmSync(join(stateRootDir, svcDir, ".env"), { force: true });
  }

  // 3. Remove dynamically-generated channel/service .env files
  if (existsSync(stateRootDir)) {
    for (const entry of readdirSync(stateRootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if ((SERVICE_ENV_DIRS as readonly string[]).includes(entry.name))
        continue;
      rmSync(join(stateRootDir, entry.name, ".env"), { force: true });
    }
  }

  // 4. Remove config artifacts (stack spec and secrets)
  rmSync(join(configDir, "openpalm.yaml"), { force: true });
  rmSync(join(configDir, "secrets.env"), { force: true });
}

/**
 * Creates a fresh temp directory with the full OpenPalm directory layout,
 * seeded with empty files where required. Returns the root path.
 *
 * The caller is responsible for cleanup (e.g. in afterAll with rmSync).
 */
export function createTestDirLayout(prefix = "openpalm-test-"): string {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));

  const dataAdmin = join(tmpDir, "data", "admin");
  const stateRoot = join(tmpDir, "state");
  const configDir = join(tmpDir, "config");
  const cronDir = join(tmpDir, "cron");
  const opencodeDir = join(tmpDir, "data", "assistant", ".config", "opencode");

  for (const svc of SERVICE_ENV_DIRS) {
    mkdirSync(join(stateRoot, svc), { recursive: true });
  }
  for (const d of [dataAdmin, configDir, cronDir, opencodeDir]) {
    mkdirSync(d, { recursive: true });
  }

  // Seed empty files that services expect to exist
  writeFileSync(join(configDir, "secrets.env"), "", "utf8");
  writeFileSync(join(stateRoot, ".env"), "", "utf8");
  writeFileSync(join(stateRoot, "system.env"), "", "utf8");
  for (const svc of SERVICE_ENV_DIRS) {
    writeFileSync(join(stateRoot, svc, ".env"), "", "utf8");
  }
  writeFileSync(
    join(opencodeDir, "opencode.json"),
    '{\n  "plugin": []\n}\n',
    "utf8"
  );

  return tmpDir;
}
