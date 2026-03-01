/**
 * Tests for the staged runtime contract.
 *
 * Verifies that:
 * 1. Channel .caddy files are staged split into public/ and lan/ dirs
 * 2. Malformed .caddy files are skipped with audit entry
 * 3. Channel .yml files are staged to STATE_HOME/artifacts/channels/
 * 4. Compose file list uses staged STATE_HOME paths
 * 5. Secrets.env is staged to STATE_HOME/artifacts/
 * 6. Runtime validation checks staged files, not CONFIG_HOME
 * 7. Startup auto-apply is idempotent
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  readdirSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Test helpers — create isolated temp directories ────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedConfigChannels(
  configDir: string,
  channels: { name: string; yml: string; caddy?: string }[]
): void {
  const channelsDir = join(configDir, "channels");
  mkdirSync(channelsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(channelsDir, `${ch.name}.yml`), ch.yml);
    if (ch.caddy) {
      writeFileSync(join(channelsDir, `${ch.name}.caddy`), ch.caddy);
    }
  }
}

function seedSecretsEnv(configDir: string, content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "secrets.env"), content);
}

// ── Inline staging functions (mirrors control-plane.ts logic) ──────────
// We test the staging logic directly without Vite import.meta.glob deps.

const PUBLIC_ACCESS_IMPORT = "import public_access";
const LAN_ONLY_IMPORT = "import lan_only";

function withDefaultLanOnly(rawCaddy: string): string | null {
  if (rawCaddy.includes(PUBLIC_ACCESS_IMPORT) || rawCaddy.includes(LAN_ONLY_IMPORT)) {
    return rawCaddy;
  }
  const blockStarts = [
    /(handle_path\s+[^\n{]+\{\s*\n?)/,
    /(handle\s+[^\n{]+\{\s*\n?)/,
    /(route\s+[^\n{]+\{\s*\n?)/
  ];
  for (const pattern of blockStarts) {
    if (pattern.test(rawCaddy)) {
      return rawCaddy.replace(pattern, "$1\timport lan_only\n");
    }
  }
  return null;
}

type ChannelInfo = {
  name: string;
  ymlPath: string;
  caddyPath: string | null;
};

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function discoverChannels(baseDir: string): ChannelInfo[] {
  const channelsDir = join(baseDir, "channels");
  if (!existsSync(channelsDir)) return [];
  const files = readdirSync(channelsDir);
  const ymlFiles = files.filter((f) => f.endsWith(".yml"));
  const caddyFiles = new Set(files.filter((f) => f.endsWith(".caddy")));
  return ymlFiles
    .map((ymlFile) => {
      const name = ymlFile.replace(/\.yml$/, "");
      const caddyFile = `${name}.caddy`;
      const hasCaddy = caddyFiles.has(caddyFile);
      return {
        name,
        ymlPath: join(channelsDir, ymlFile),
        caddyPath: hasCaddy ? join(channelsDir, caddyFile) : null
      };
    })
    .filter((ch) => CHANNEL_NAME_RE.test(ch.name));
}

type AuditEntry = { action: string; args: Record<string, unknown>; ok: boolean };

function stageChannelCaddyfiles(
  configDir: string,
  stateDir: string
): AuditEntry[] {
  const auditEntries: AuditEntry[] = [];
  const stagedChannelsDir = join(stateDir, "artifacts", "channels");
  const stagedPublicDir = join(stagedChannelsDir, "public");
  const stagedLanDir = join(stagedChannelsDir, "lan");
  // Only clean caddy subdirs, not the whole channels/ dir (preserves staged .yml files)
  rmSync(stagedPublicDir, { recursive: true, force: true });
  rmSync(stagedLanDir, { recursive: true, force: true });
  mkdirSync(stagedPublicDir, { recursive: true });
  mkdirSync(stagedLanDir, { recursive: true });

  const channels = discoverChannels(configDir);
  for (const ch of channels) {
    if (!ch.caddyPath) continue;
    const raw = readFileSync(ch.caddyPath, "utf-8");
    if (raw.includes(PUBLIC_ACCESS_IMPORT)) {
      writeFileSync(join(stagedPublicDir, `${ch.name}.caddy`), raw);
      continue;
    }
    const lanScoped = withDefaultLanOnly(raw);
    if (!lanScoped) {
      auditEntries.push({
        action: "channels.route.skip",
        args: { channel: ch.name, reason: "Unable to infer route block for default LAN scoping" },
        ok: false
      });
      continue;
    }
    writeFileSync(join(stagedLanDir, `${ch.name}.caddy`), lanScoped);
  }
  return auditEntries;
}

function stageChannelYmlFiles(configDir: string, stateDir: string): void {
  const stagedChannelsDir = join(stateDir, "artifacts", "channels");
  mkdirSync(stagedChannelsDir, { recursive: true });

  // Clean stale staged .yml files before re-staging
  for (const f of readdirSync(stagedChannelsDir)) {
    if (f.endsWith(".yml")) {
      rmSync(join(stagedChannelsDir, f), { force: true });
    }
  }

  const channels = discoverChannels(configDir);
  for (const ch of channels) {
    const content = readFileSync(ch.ymlPath, "utf-8");
    writeFileSync(join(stagedChannelsDir, `${ch.name}.yml`), content);
  }
}

function stageSecretsEnvFn(configDir: string, stateDir: string): void {
  const source = join(configDir, "secrets.env");
  if (!existsSync(source)) return;
  const artifactDir = join(stateDir, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "secrets.env"), readFileSync(source, "utf-8"));
}

function discoverStagedChannelYmls(stateDir: string): string[] {
  const channelsDir = join(stateDir, "artifacts", "channels");
  if (!existsSync(channelsDir)) return [];
  return readdirSync(channelsDir)
    .filter((f) => f.endsWith(".yml"))
    .map((f) => join(channelsDir, f));
}

function isValidChannel(value: string, stateDir?: string): boolean {
  if (!value || !value.trim()) return false;
  if (!CHANNEL_NAME_RE.test(value)) return false;
  if (stateDir) {
    return existsSync(join(stateDir, "artifacts", "channels", `${value}.yml`));
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────

let configDir: string;
let stateDir: string;

beforeEach(() => {
  configDir = makeTempDir();
  stateDir = makeTempDir();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Caddy staging split", () => {
  test("LAN-only channel (no explicit access) stages to lan/", () => {
    seedConfigChannels(configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n"
      }
    ]);

    stageChannelCaddyfiles(configDir, stateDir);

    const lanDir = join(stateDir, "artifacts", "channels", "lan");
    expect(existsSync(join(lanDir, "chat.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "chat.caddy"), "utf-8");
    expect(content).toContain("import lan_only");
  });

  test("public_access channel stages to public/", () => {
    seedConfigChannels(configDir, [
      {
        name: "web",
        yml: "services:\n  channel-web:\n    image: web:latest\n",
        caddy: "handle_path /web/* {\n\timport public_access\n\treverse_proxy channel-web:8080\n}\n"
      }
    ]);

    stageChannelCaddyfiles(configDir, stateDir);

    const publicDir = join(stateDir, "artifacts", "channels", "public");
    expect(existsSync(join(publicDir, "web.caddy"))).toBe(true);
  });

  test("channel with explicit lan_only stages to lan/ unchanged", () => {
    const caddyContent = "handle_path /api/* {\n\timport lan_only\n\treverse_proxy channel-api:8080\n}\n";
    seedConfigChannels(configDir, [
      {
        name: "api",
        yml: "services:\n  channel-api:\n    image: api:latest\n",
        caddy: caddyContent
      }
    ]);

    stageChannelCaddyfiles(configDir, stateDir);

    const lanDir = join(stateDir, "artifacts", "channels", "lan");
    expect(existsSync(join(lanDir, "api.caddy"))).toBe(true);
    const content = readFileSync(join(lanDir, "api.caddy"), "utf-8");
    expect(content).toBe(caddyContent);
  });
});

describe("Malformed .caddy skip", () => {
  test("unstageable caddy emits channels.route.skip audit entry", () => {
    seedConfigChannels(configDir, [
      {
        name: "broken",
        yml: "services:\n  channel-broken:\n    image: broken:latest\n",
        caddy: "# This has no handle/route block\nsome_invalid_caddy_content\n"
      }
    ]);

    const audit = stageChannelCaddyfiles(configDir, stateDir);

    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("channels.route.skip");
    expect(audit[0].args.channel).toBe("broken");
    expect(audit[0].ok).toBe(false);

    // File should NOT be staged
    expect(existsSync(join(stateDir, "artifacts", "channels", "lan", "broken.caddy"))).toBe(false);
    expect(existsSync(join(stateDir, "artifacts", "channels", "public", "broken.caddy"))).toBe(false);
  });
});

describe("Channel .yml staging", () => {
  test("yml files are staged to STATE_HOME/artifacts/channels/", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent }]);

    stageChannelYmlFiles(configDir, stateDir);

    const stagedPath = join(stateDir, "artifacts", "channels", "chat.yml");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(ymlContent);
  });

  test("multiple channels are all staged", () => {
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" }
    ]);

    stageChannelYmlFiles(configDir, stateDir);

    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(true);
  });
});

describe("Stale .yml cleanup", () => {
  test("removed channels are cleaned from staged dir on re-apply", () => {
    // First: stage two channels
    seedConfigChannels(configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" },
      { name: "discord", yml: "services:\n  channel-discord:\n    image: discord:latest\n" }
    ]);
    stageChannelYmlFiles(configDir, stateDir);
    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(true);

    // Remove discord from config
    rmSync(join(configDir, "channels", "discord.yml"));

    // Re-stage
    stageChannelYmlFiles(configDir, stateDir);

    // chat should still exist, discord should be gone
    expect(existsSync(join(stateDir, "artifacts", "channels", "chat.yml"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "channels", "discord.yml"))).toBe(false);
  });
});

describe("Compose file list uses staged paths", () => {
  test("buildComposeFileList returns STATE_HOME paths", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent }]);
    stageChannelYmlFiles(configDir, stateDir);

    const files = discoverStagedChannelYmls(stateDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain(stateDir);
    expect(files[0]).not.toContain(configDir);
    expect(files[0]).toMatch(/chat\.yml$/);
  });
});

describe("Secrets.env staging", () => {
  test("secrets.env is staged from CONFIG to STATE", () => {
    const secretsContent = "ADMIN_TOKEN=test-token\n";
    seedSecretsEnv(configDir, secretsContent);

    stageSecretsEnvFn(configDir, stateDir);

    const stagedPath = join(stateDir, "artifacts", "secrets.env");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(secretsContent);
  });

  test("missing secrets.env is a no-op (no error)", () => {
    stageSecretsEnvFn(configDir, stateDir);

    const stagedPath = join(stateDir, "artifacts", "secrets.env");
    expect(existsSync(stagedPath)).toBe(false);
  });
});

describe("Runtime validation uses staged files", () => {
  test("isValidChannel checks STATE_HOME for staged channels", () => {
    const ymlContent = "services:\n  channel-custom:\n    image: custom:latest\n";
    seedConfigChannels(configDir, [{ name: "custom", yml: ymlContent }]);
    stageChannelYmlFiles(configDir, stateDir);

    // Should find it in STATE_HOME
    expect(isValidChannel("custom", stateDir)).toBe(true);

    // Should NOT find an unstaged channel
    expect(isValidChannel("nonexistent", stateDir)).toBe(false);
  });

  test("source-only channel (not staged) is not valid at runtime", () => {
    seedConfigChannels(configDir, [
      { name: "unstaged", yml: "services:\n  channel-unstaged:\n    image: unstaged:latest\n" }
    ]);

    // NOT staged to stateDir — so runtime validation should reject
    expect(isValidChannel("unstaged", stateDir)).toBe(false);
  });
});

describe("Staging idempotence", () => {
  test("running staging twice produces identical results", () => {
    const ymlContent = "services:\n  channel-chat:\n    image: chat:latest\n";
    const caddyContent = "handle_path /chat/* {\n\treverse_proxy channel-chat:8080\n}\n";
    const secretsContent = "ADMIN_TOKEN=test\n";

    seedConfigChannels(configDir, [{ name: "chat", yml: ymlContent, caddy: caddyContent }]);
    seedSecretsEnv(configDir, secretsContent);

    // Apply order matches persistArtifacts: secrets → yml → caddy
    function applyAll(): void {
      stageSecretsEnvFn(configDir, stateDir);
      stageChannelYmlFiles(configDir, stateDir);
      stageChannelCaddyfiles(configDir, stateDir);
    }

    // First apply
    applyAll();

    const yml1 = readFileSync(join(stateDir, "artifacts", "channels", "chat.yml"), "utf-8");
    const caddy1 = readFileSync(join(stateDir, "artifacts", "channels", "lan", "chat.caddy"), "utf-8");
    const secrets1 = readFileSync(join(stateDir, "artifacts", "secrets.env"), "utf-8");

    // Second apply (idempotent)
    applyAll();

    const yml2 = readFileSync(join(stateDir, "artifacts", "channels", "chat.yml"), "utf-8");
    const caddy2 = readFileSync(join(stateDir, "artifacts", "channels", "lan", "chat.caddy"), "utf-8");
    const secrets2 = readFileSync(join(stateDir, "artifacts", "secrets.env"), "utf-8");

    expect(yml1).toBe(yml2);
    expect(caddy1).toBe(caddy2);
    expect(secrets1).toBe(secrets2);
  });
});

// ── Automation staging ─────────────────────────────────────────────────

const AUTOMATION_FILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ALLOWED_AUTOMATION_USER = "node";

function validateAutomationContent(content: string): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 7) continue;
    if (fields[5] !== ALLOWED_AUTOMATION_USER) return false;
  }
  return true;
}

function discoverAutomationFiles(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }))
    .filter((entry) => AUTOMATION_FILE_NAME_RE.test(entry.name));
}

function stageAutomationFilesFn(
  configDir: string,
  dataDir: string,
  stateDir: string
): void {
  const stagedDir = join(stateDir, "automations");
  mkdirSync(stagedDir, { recursive: true });

  // Clean stale staged automation files
  for (const f of readdirSync(stagedDir)) {
    if (!f.startsWith(".")) {
      rmSync(join(stagedDir, f), { force: true });
    }
  }

  // System automation files from DATA_HOME/automations/ first
  const systemDir = join(dataDir, "automations");
  for (const entry of discoverAutomationFiles(systemDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content)) continue;
    writeFileSync(join(stagedDir, entry.name), content);
  }

  // User automation files from CONFIG_HOME/automations/ (overrides system)
  const userDir = join(configDir, "automations");
  for (const entry of discoverAutomationFiles(userDir)) {
    const content = readFileSync(entry.path, "utf-8");
    if (!validateAutomationContent(content)) continue;
    writeFileSync(join(stagedDir, entry.name), content);
  }
}

function seedAutomationFiles(
  dir: string,
  files: { name: string; content: string }[]
): void {
  const automationsDir = join(dir, "automations");
  mkdirSync(automationsDir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(automationsDir, f.name), f.content);
  }
}

let dataDir: string;

describe("Automation file staging", () => {
  beforeEach(() => {
    dataDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("user automation files are staged to STATE_HOME/automations/", () => {
    const content = "0 2 * * * node /work/scripts/backup.sh\n";
    seedAutomationFiles(configDir, [{ name: "backup", content }]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    const stagedPath = join(stateDir, "automations", "backup");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(content);
  });

  test("system automation files are staged from DATA_HOME/automations/", () => {
    const content = "*/5 * * * * node /work/scripts/healthcheck.sh\n";
    seedAutomationFiles(dataDir, [{ name: "healthcheck", content }]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    const stagedPath = join(stateDir, "automations", "healthcheck");
    expect(existsSync(stagedPath)).toBe(true);
    expect(readFileSync(stagedPath, "utf-8")).toBe(content);
  });

  test("user automation files override system files with the same name", () => {
    const systemContent = "0 3 * * * node /work/scripts/old-backup.sh\n";
    const userContent = "0 2 * * * node /work/scripts/my-backup.sh\n";

    seedAutomationFiles(dataDir, [{ name: "backup", content: systemContent }]);
    seedAutomationFiles(configDir, [{ name: "backup", content: userContent }]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    const stagedPath = join(stateDir, "automations", "backup");
    expect(readFileSync(stagedPath, "utf-8")).toBe(userContent);
  });

  test("both system and user automation files are staged together", () => {
    seedAutomationFiles(dataDir, [
      { name: "healthcheck", content: "*/5 * * * * node /work/scripts/hc.sh\n" }
    ]);
    seedAutomationFiles(configDir, [
      { name: "backup", content: "0 2 * * * node /work/scripts/backup.sh\n" }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "healthcheck"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "backup"))).toBe(true);
  });

  test("invalid automation filenames are ignored", () => {
    const automationsDir = join(configDir, "automations");
    mkdirSync(automationsDir, { recursive: true });
    // Invalid: starts with hyphen
    writeFileSync(join(automationsDir, "-bad"), "* * * * * node /work/bad.sh\n");
    // Valid
    writeFileSync(join(automationsDir, "good"), "* * * * * node /work/good.sh\n");

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "good"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "-bad"))).toBe(false);
  });

  test("stale automation files are cleaned on re-apply", () => {
    seedAutomationFiles(configDir, [
      { name: "backup", content: "0 2 * * * node /work/backup.sh\n" },
      { name: "cleanup", content: "0 4 * * 0 node /work/cleanup.sh\n" }
    ]);
    stageAutomationFilesFn(configDir, dataDir, stateDir);
    expect(existsSync(join(stateDir, "automations", "backup"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "cleanup"))).toBe(true);

    // Remove cleanup from config
    rmSync(join(configDir, "automations", "cleanup"));
    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "backup"))).toBe(true);
    expect(existsSync(join(stateDir, "automations", "cleanup"))).toBe(false);
  });

  test("empty automation directories produce no staged files", () => {
    mkdirSync(join(configDir, "automations"), { recursive: true });
    mkdirSync(join(dataDir, "automations"), { recursive: true });

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    const automationsDir = join(stateDir, "automations");
    const files = existsSync(automationsDir)
      ? readdirSync(automationsDir).filter((f) => !f.startsWith("."))
      : [];
    expect(files.length).toBe(0);
  });

  test("staging is idempotent", () => {
    seedAutomationFiles(configDir, [
      { name: "backup", content: "0 2 * * * node /work/backup.sh\n" }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);
    const first = readFileSync(join(stateDir, "automations", "backup"), "utf-8");

    stageAutomationFilesFn(configDir, dataDir, stateDir);
    const second = readFileSync(join(stateDir, "automations", "backup"), "utf-8");

    expect(first).toBe(second);
  });

  test("automation files with non-node user field are not staged", () => {
    seedAutomationFiles(configDir, [
      { name: "bad-user", content: "0 2 * * * root /work/scripts/root-task.sh\n" }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "bad-user"))).toBe(false);
  });

  test("automation files with node user field are staged", () => {
    seedAutomationFiles(configDir, [
      { name: "good-user", content: "0 2 * * * node /work/scripts/task.sh\n" }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "good-user"))).toBe(true);
  });

  test("automation files with mixed users are not staged", () => {
    seedAutomationFiles(configDir, [
      {
        name: "mixed-users",
        content:
          "0 2 * * * node /work/scripts/ok.sh\n0 3 * * * root /work/scripts/bad.sh\n"
      }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "mixed-users"))).toBe(false);
  });

  test("comment and env-var lines are not treated as job lines", () => {
    seedAutomationFiles(configDir, [
      {
        name: "with-env",
        content: "SHELL=/bin/bash\n# daily backup\n0 2 * * * node /work/scripts/backup.sh\n"
      }
    ]);

    stageAutomationFilesFn(configDir, dataDir, stateDir);

    expect(existsSync(join(stateDir, "automations", "with-env"))).toBe(true);
  });
});
