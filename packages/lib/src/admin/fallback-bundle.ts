import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { FALLBACK_BUNDLE_CHECKSUMS } from "./fallback-bundle-checksums.ts";

export type FallbackBundlePaths = {
  composePath: string;
  caddyPath: string;
};

export type FallbackBundleValidation = { ok: boolean; errors: string[] };

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function validateFallbackBundle(paths: FallbackBundlePaths): FallbackBundleValidation {
  const errors: string[] = [];
  if (!existsSync(paths.composePath)) errors.push(`missing_compose:${paths.composePath}`);
  if (!existsSync(paths.caddyPath)) errors.push(`missing_caddy:${paths.caddyPath}`);
  if (errors.length > 0) return { ok: false, errors };

  const compose = readFileSync(paths.composePath);
  const caddy = readFileSync(paths.caddyPath);
  const composeSha = sha256(compose);
  const caddySha = sha256(caddy);
  if (composeSha !== FALLBACK_BUNDLE_CHECKSUMS.compose) errors.push("compose_checksum_mismatch");
  if (caddySha !== FALLBACK_BUNDLE_CHECKSUMS.caddy) errors.push("caddy_checksum_mismatch");
  return { ok: errors.length === 0, errors };
}
