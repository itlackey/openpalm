import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedConfigFiles } from "@openpalm/lib/assets.ts";

// Track temp directories for cleanup
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "assets-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("seedConfigFiles", () => {
  it("seeds openpalm.yaml and secrets.env from embedded templates", async () => {
    const configHome = await createTempDir();

    await seedConfigFiles(configHome);

    const yamlContent = await readFile(join(configHome, "openpalm.yaml"), "utf-8");
    expect(yamlContent).toContain("version:");
    expect(yamlContent).toContain("channels:");
    const secretsContent = await readFile(join(configHome, "secrets.env"), "utf-8");
    expect(secretsContent).toContain("ANTHROPIC_API_KEY");
  });

  it("does not overwrite existing config files", async () => {
    const configHome = await createTempDir();
    const originalYaml = "version: 3\ncustom: true\n";
    const originalSecrets = "MY_SECRET=keep-this\n";

    await writeFile(join(configHome, "openpalm.yaml"), originalYaml);
    await writeFile(join(configHome, "secrets.env"), originalSecrets);

    await seedConfigFiles(configHome);

    expect(await readFile(join(configHome, "openpalm.yaml"), "utf-8")).toBe(originalYaml);
    expect(await readFile(join(configHome, "secrets.env"), "utf-8")).toBe(originalSecrets);
  });

  it("creates files that do not exist without requiring network", async () => {
    const configHome = await createTempDir();

    // Should not throw — all templates are embedded
    await seedConfigFiles(configHome);

    const yamlExists = await Bun.file(join(configHome, "openpalm.yaml")).exists();
    const secretsExists = await Bun.file(join(configHome, "secrets.env")).exists();
    expect(yamlExists).toBe(true);
    expect(secretsExists).toBe(true);
  });
});
