import { parse as dotenvParse } from 'dotenv';
import { readFileSync, existsSync, copyFileSync } from 'node:fs';

export function parseEnvContent(content: string): Record<string, string> {
  return dotenvParse(content);
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    return dotenvParse(readFileSync(filePath, 'utf-8'));
  } catch {
    // File is unreadable or malformed — back it up before returning empty so
    // the next write doesn't silently discard all existing values.
    try { copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch { /* best-effort */ }
    return {};
  }
}

/**
 * Resolve `${VAR}` and `${VAR:-default}` patterns in a string against the
 * provided variable map. Unknown vars without a default expand to an empty
 * string — mirrors compose's variable substitution semantics.
 */
export function expandEnvVars(input: string, vars: Record<string, string>): string {
  return input.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, name, def) => vars[name] ?? def ?? '');
}

export function quoteEnvValue(value: string): string {
  if (value.length === 0) return '';
  const needsQuoting = /[#"'\\\n\r$]/.test(value) || value !== value.trim();
  if (!needsQuoting) return value;

  if (!value.includes("'")) return `'${value}'`;

  const escaped = value.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/**
 * Remove a key from .env content. Comments above the line and the
 * surrounding blank-line structure are preserved exactly as written so
 * round-tripping the file through this helper is non-destructive.
 * If the key is absent the input is returned unchanged.
 */
export function removeEnvKey(content: string, key: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    let testLine = line.trim();
    if (testLine.startsWith('export ')) testLine = testLine.slice(7).trimStart();
    const eq = testLine.indexOf('=');
    if (eq > 0 && testLine.slice(0, eq).trim() === key) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  // If we matched, drop a trailing blank line that the deletion left behind so
  // the file does not accumulate empty lines on repeated edits.
  if (removed && out.length > 1 && out[out.length - 1] === '' && out[out.length - 2] === '') {
    out.pop();
  }
  return out.join('\n');
}

/**
 * Upserts a key=value pair in env file content. If the key exists, replaces the line;
 * otherwise appends a new line.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const escapedKey = key.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&');
  const pattern = new RegExp(`^((?:export\\s+)?)${escapedKey}=.*$`, 'm');
  if (pattern.test(content)) {
    // Preserve the `export ` prefix if the original line had one
    return content.replace(pattern, `$1${key}=${value}`);
  }

  const line = `${key}=${value}`;
  const suffix = content.endsWith('\n') || content.length === 0 ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

/** Addon name shape (matches the former stack.yml validation). */
export const ADDON_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Parse the `OP_ENABLED_ADDONS` stack.env value (comma-separated) into a
 * validated, de-duplicated, sorted list of addon ids. Replaces the former
 * stack.yml `addons[]` array as the authoritative enabled-addon record.
 */
export function parseEnabledAddons(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value.split(',').map((v) => v.trim()).filter((v) => ADDON_NAME_RE.test(v)),
  )].sort();
}

export const RELEASE_TAG_REGEX = /^v?\d+\.\d+\.\d+(?:[-+](?:[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/**
 * Normalizes a repository ref to an image tag. Returns null for non-release refs.
 * E.g. "0.9.0" → "v0.9.0", "v0.9.0" → "v0.9.0", "main" → null.
 */
export function resolveRequestedImageTag(repoRef: string): string | null {
  const trimmed = repoRef.trim();
  if (!trimmed || trimmed === 'main') return null;
  if (!RELEASE_TAG_REGEX.test(trimmed)) return null;
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/**
 * Reconciles the OP_IMAGE_TAG value in stack.env content.
 */
export function reconcileStackEnvImageTag(
  content: string,
  repoRef: string,
  explicitImageTag?: string,
): string {
  const desiredImageTag = explicitImageTag || resolveRequestedImageTag(repoRef);
  if (!desiredImageTag) return content;
  return upsertEnvValue(content, 'OP_IMAGE_TAG', desiredImageTag);
}

export function mergeEnvContent(
  content: string,
  updates: Record<string, string>,
  options: { uncomment?: boolean; sectionHeader?: string } = {}
): string {
  const lines = content.split('\n');
  const remaining = new Map(Object.entries(updates));

  for (let i = 0; i < lines.length; i++) {
    let testLine = lines[i].trim();
    if (options.uncomment) {
      testLine = testLine.replace(/^#\s*/, '').trim();
    }
    // Strip `export ` prefix so we can match the key name
    const hadExport = testLine.startsWith('export ');
    if (hadExport) {
      testLine = testLine.slice(7).trimStart();
    }
    const eq = testLine.indexOf('=');
    if (eq <= 0) continue;
    const key = testLine.slice(0, eq).trim();
    if (remaining.has(key)) {
      // Preserve the export prefix if the original line had one
      const prefix = hadExport ? 'export ' : '';
      lines[i] = `${prefix}${key}=${quoteEnvValue(remaining.get(key)!)}`;
      remaining.delete(key);
    }
  }

  if (remaining.size > 0) {
    if (lines.length === 0 || lines[lines.length - 1] !== '') {
      lines.push('');
    }
    if (options.sectionHeader) {
      lines.push(options.sectionHeader);
    }
    for (const [key, value] of remaining) {
      lines.push(`${key}=${quoteEnvValue(value)}`);
    }
  }

  return lines.join('\n');
}
