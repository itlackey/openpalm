import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled `dist/main.js` (and, in dev/tests, `src/*.ts`) both live in a
// directory that is a sibling of `assets/`. electron-builder copies `assets/**/*`
// into the packaged app (see electron-builder.yml `files`), so the same
// `../assets/<name>` relative path resolves at runtime in dev, in tests, and
// inside the packaged app.asar.
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled `assets/` directory. */
export const assetsDir = join(__dirname, '..', 'assets');

/** Resolve a bundled asset path, or null when the asset is absent. */
export function resolveAssetPath(fileName: string): string | null {
  const assetPath = join(assetsDir, fileName);
  return existsSync(assetPath) ? assetPath : null;
}

/**
 * Read a bundled text asset (e.g. an HTML splash screen). Returns `fallback`
 * when the asset can't be read, so a missing/renamed asset degrades gracefully
 * instead of crashing app startup.
 */
export function readAssetText(fileName: string, fallback = ''): string {
  try {
    return readFileSync(join(assetsDir, fileName), 'utf-8');
  } catch {
    return fallback;
  }
}
