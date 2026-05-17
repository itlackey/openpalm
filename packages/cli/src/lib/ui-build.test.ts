import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We cannot import the real embedded tarball in tests (it's a binary Bun import),
// so we test the extraction logic with a synthetic helper that uses the same
// Bun.spawnSync + tar approach without the embedded constant.

async function extractTar(tarBytes: Uint8Array, destDir: string): Promise<void> {
  const tarPath = join(tmpdir(), `test-tar-${Date.now()}.tar.gz`);
  writeFileSync(tarPath, tarBytes);
  const result = Bun.spawnSync(["tar", "-xzf", tarPath, "-C", destDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

async function makeTar(srcDir: string): Promise<Uint8Array> {
  const tarPath = join(tmpdir(), `test-tar-src-${Date.now()}.tar.gz`);
  const result = Bun.spawnSync(["tar", "-czf", tarPath, "-C", srcDir, "."], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new Uint8Array(await Bun.file(tarPath).arrayBuffer());
}

describe("admin-build extraction", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "op-admin-build-test-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("extracts tarball and produces index.js", async () => {
    // Create a minimal "build" directory to tar up
    const srcDir = join(tmpBase, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.js"), "// mock admin build\n");
    writeFileSync(join(srcDir, "handler.js"), "export const handler = () => {};\n");

    const tarBytes = await makeTar(srcDir);
    const destDir = join(tmpBase, "dest");
    mkdirSync(destDir, { recursive: true });

    await extractTar(tarBytes, destDir);

    expect(existsSync(join(destDir, "index.js"))).toBe(true);
    expect(existsSync(join(destDir, "handler.js"))).toBe(true);
  });

  it("reports error on invalid tarball", async () => {
    const destDir = join(tmpBase, "dest2");
    mkdirSync(destDir, { recursive: true });

    const garbage = new Uint8Array([0, 1, 2, 3, 4]);
    await expect(extractTar(garbage, destDir)).rejects.toThrow();
  });
});
