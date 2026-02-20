import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Track temp directories created by downloadAssets so they can be cleaned up. */
const tempDirs: string[] = [];

/** Remove all temp directories created during asset downloads. */
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
  // Check relative to CWD
  const cwdAssets = join(process.cwd(), "assets");
  const composeFile = join(cwdAssets, "state/docker-compose.yml");
  const envFile = join(cwdAssets, "config/system.env");

  try {
    const composeExists = await Bun.file(composeFile).exists();
    const envExists = await Bun.file(envFile).exists();
    if (composeExists && envExists) {
      return cwdAssets;
    }
  } catch {
    // ignore
  }

  // Check relative to binary (Bun.main is the entry point path)
  const binDir = join(Bun.main, "..");
  const binAssets = join(binDir, "assets");
  const binComposeFile = join(binAssets, "state/docker-compose.yml");
  const binEnvFile = join(binAssets, "config/system.env");

  try {
    const composeExists = await Bun.file(binComposeFile).exists();
    const envExists = await Bun.file(binEnvFile).exists();
    if (composeExists && envExists) {
      return binAssets;
    }
  } catch {
    // ignore
  }

  return null;
}

export async function downloadAssets(
  ref: string,
  owner: string = "itlackey",
  repo: string = "openpalm"
): Promise<string> {
  // Try heads first, then tags
  let url = `https://github.com/${owner}/${repo}/archive/refs/heads/${ref}.tar.gz`;
  let response = await fetch(url);

  if (response.status === 404) {
    url = `https://github.com/${owner}/${repo}/archive/refs/tags/${ref}.tar.gz`;
    response = await fetch(url);
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download assets from ${url}: ${response.status} ${response.statusText}`
    );
  }

  // Create temp directory for extraction
  const tempDir = await mkdtemp(join(tmpdir(), "openpalm-"));
  tempDirs.push(tempDir);
  const tarballPath = join(tempDir, "archive.tar.gz");

  // Write tarball to temp file
  const tarballData = await response.arrayBuffer();
  await Bun.write(tarballPath, tarballData);

  // Extract tarball
  const extractProc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", tempDir], {
    stdout: "pipe",
    stderr: "pipe",
  });

  await extractProc.exited;

  if (extractProc.exitCode !== 0) {
    const stderr = await new Response(extractProc.stderr).text();
    throw new Error(`Failed to extract tarball: ${stderr}`);
  }

  // GitHub creates a directory named {repo}-{ref} when extracting
  const extractedDir = join(tempDir, `${repo}-${ref}`);
  const assetsDir = join(extractedDir, "assets");

  // Verify assets directory exists
  const assetsExists = await Bun.file(join(assetsDir, "state/docker-compose.yml")).exists();
  if (!assetsExists) {
    throw new Error(`Assets directory not found in downloaded archive at ${assetsDir}`);
  }

  return assetsDir;
}

export async function resolveAssets(ref?: string): Promise<string> {
  const localAssets = await findLocalAssets();
  if (localAssets !== null) {
    return localAssets;
  }

  return await downloadAssets(ref ?? "main");
}

export async function seedFile(src: string, dst: string): Promise<void> {
  const dstExists = await Bun.file(dst).exists();
  if (!dstExists) {
    await Bun.write(dst, Bun.file(src));
  }
}

export async function seedConfigFiles(
  assetsDir: string,
  configHome: string
): Promise<void> {
  // Seed Caddyfile
  await seedFile(
    join(assetsDir, "state/caddy/Caddyfile"),
    join(configHome, "caddy/Caddyfile")
  );

  // Seed channel env files (skip if channels directory doesn't exist in assets)
  const channelsDir = join(assetsDir, "config/channels");
  try {
    const channelFiles = await readdir(channelsDir);
    for (const file of channelFiles) {
      if (file.endsWith(".env")) {
        await seedFile(
          join(channelsDir, file),
          join(configHome, "channels", file)
        );
      }
    }
  } catch {
    // channels directory may not exist in downloaded assets — skip
  }

  // Seed secrets.env
  await seedFile(
    join(assetsDir, "config/secrets.env"),
    join(configHome, "secrets.env")
  );

  // Seed user.env
  await seedFile(
    join(assetsDir, "config/user.env"),
    join(configHome, "user.env")
  );

  // Seed scoped secret env files
  const gatewaySecretsDir = join(assetsDir, "config/secrets/gateway");
  try {
    const gatewayFiles = await readdir(gatewaySecretsDir);
    for (const file of gatewayFiles) {
      if (file.endsWith(".env")) {
        await seedFile(
          join(gatewaySecretsDir, file),
          join(configHome, "secrets", "gateway", file)
        );
      }
    }
  } catch {
    // optional in older assets
  }

  const channelSecretsDir = join(assetsDir, "config/secrets/channels");
  try {
    const channelSecretFiles = await readdir(channelSecretsDir);
    for (const file of channelSecretFiles) {
      if (file.endsWith(".env")) {
        await seedFile(
          join(channelSecretsDir, file),
          join(configHome, "secrets", "channels", file)
        );
      }
    }
  } catch {
    // optional in older assets
  }
}
