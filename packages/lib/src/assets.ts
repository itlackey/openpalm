import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

export async function cleanupTempAssets(): Promise<void> {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tempDirs.length = 0;
}

export async function findLocalAssets(): Promise<string | null> {
  const cwdAssets = join(process.cwd(), "assets");
  const composeFile = join(cwdAssets, "state/docker-compose.yml");
  const envFile = join(cwdAssets, "config/system.env");
  try {
    if (await Bun.file(composeFile).exists() && await Bun.file(envFile).exists()) return cwdAssets;
  } catch {}

  const binDir = join(Bun.main, "..");
  const binAssets = join(binDir, "assets");
  const binComposeFile = join(binAssets, "state/docker-compose.yml");
  const binEnvFile = join(binAssets, "config/system.env");
  try {
    if (await Bun.file(binComposeFile).exists() && await Bun.file(binEnvFile).exists()) return binAssets;
  } catch {}

  return null;
}

export async function downloadAssets(ref: string, owner = "itlackey", repo = "openpalm"): Promise<string> {
  let url = `https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.tar.gz`;
  let response = await fetch(url);
  if (response.status === 404) {
    url = `https://github.com/${owner}/${repo}/archive/refs/tags/${ref}.tar.gz`;
    response = await fetch(url);
  }
  if (!response.ok) throw new Error(`Failed to download assets from ${url}: ${response.status} ${response.statusText}`);

  const tempDir = await mkdtemp(join(tmpdir(), "openpalm-"));
  tempDirs.push(tempDir);
  const tarballPath = join(tempDir, "archive.tar.gz");
  await Bun.write(tarballPath, await response.arrayBuffer());

  const extractProc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", tempDir], { stdout: "pipe", stderr: "pipe" });
  await extractProc.exited;
  if (extractProc.exitCode !== 0) throw new Error(`Failed to extract tarball: ${await new Response(extractProc.stderr).text()}`);

  const assetsDir = join(tempDir, `${repo}-${ref}`, "assets");
  if (!await Bun.file(join(assetsDir, "state/docker-compose.yml")).exists()) {
    throw new Error(`Assets directory not found in downloaded archive at ${assetsDir}`);
  }
  return assetsDir;
}

export async function resolveAssets(ref?: string): Promise<string> {
  const localAssets = await findLocalAssets();
  if (localAssets !== null) return localAssets;
  return downloadAssets(ref ?? "main");
}

export async function seedFile(src: string, dst: string): Promise<void> {
  if (!await Bun.file(dst).exists()) await Bun.write(dst, Bun.file(src));
}

export async function seedConfigFiles(assetsDir: string, configHome: string): Promise<void> {
  await seedFile(join(assetsDir, "config/secrets.env"), join(configHome, "secrets.env"));
  await seedFile(join(assetsDir, "config/stack-spec.json"), join(configHome, "stack-spec.json"));
}
