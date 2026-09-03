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
 * dotenv quoting, for env files only this app and akm read — today exactly one:
 * `knowledge/env/user.env`, which holds user-set values (provider keys, owner
 * info, occasionally a pasted multi-line key). Compose never reads it, so its
 * values are not bound by {@link quoteComposeEnvValue}'s narrower grammar.
 */
export function quoteEnvValue(value: string): string {
  if (value.length === 0) return '';
  const needsQuoting = /[#"'\\\n\r$]/.test(value) || value !== value.trim();
  if (!needsQuoting) return value;

  if (!value.includes("'")) return `'${value}'`;

  const escaped = value.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

/** A value no shape of the compose-safe grammar can hold (#628). */
export class UnrepresentableEnvValueError extends Error {
  constructor(readonly key: string, readonly reason: string) {
    super(`Cannot store ${key} in a Compose env file: ${reason}`);
    this.name = 'UnrepresentableEnvValueError';
  }
}

/**
 * Render a value for an env file DOCKER COMPOSE reads — `state/stack.env` and
 * its legacy variants. TWO shapes, and only two: bare, or single-quoted (#628).
 *
 * The third shape {@link quoteEnvValue} still uses — double-quoted with
 * backslash escapes — is not merely awkward for a non-JS consumer here. dotenv
 * and `docker compose --env-file` DISAGREE about it. Written for a Windows
 * path, this app read `C:\\Users\\op\\` back while Compose read
 * `C:\Users\op\`: the same bytes, two different values, no error from
 * either. A file compose reads may not contain a shape they read differently.
 *
 * What survives is what dotenv, Compose and `bash source` agree on, and the
 * reader side is now one sentence long: if the value starts and ends with a
 * single quote, drop those two characters; otherwise take it literally.
 *
 * A value neither shape can hold is REFUSED, naming the key. Compose parses
 * --env-file whole-file, so one unrepresentable value written silently takes
 * down every compose command on that home — a loud refusal at the write is the
 * cheap end of that trade. Nothing in a real OP_HOME is affected: every value
 * across the installs surveyed for #628 is bare.
 */
export function quoteComposeEnvValue(value: string, key = 'value'): string {
  if (value.length === 0) return '';
  const needsQuoting = /[#"'\\\n\r$]/.test(value) || value !== value.trim();
  if (!needsQuoting) return value;

  // A line break ends the record for both readers; no shape holds one.
  if (/[\n\r]/.test(value)) {
    throw new UnrepresentableEnvValueError(key, 'the value contains a line break');
  }
  // Compose answers `KEY='...\'` with "unterminated quoted value" — and it
  // fails the WHOLE file, not the line. Verified against docker compose.
  if (/\\$/.test(value)) {
    throw new UnrepresentableEnvValueError(
      key,
      'the value ends with a backslash, which docker compose reads as an escaped quote and then rejects the entire env file',
    );
  }
  // The quote character itself has no escape inside a single-quoted value that
  // both readers agree on.
  if (value.includes("'")) {
    throw new UnrepresentableEnvValueError(key, "the value contains a single quote (')");
  }
  return `'${value}'`;
}

/**
 * The reader half of {@link quoteComposeEnvValue}'s grammar, for a non-JS
 * consumer to mirror in two lines. Kept beside the writer so the pair cannot
 * drift, and asserted against real `docker compose` in env-grammar-parity.
 */
export function unquoteComposeEnvValue(raw: string): string {
  return raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw;
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
 * Validates a repository ref and returns it verbatim as an image tag, or null
 * for non-release refs. Pass-through (not normalized): an explicit pin is
 * honored exactly as typed so a user can still pin a legacy `v`-tagged image
 * that predates the 0.12.41 bare-tag cutover (e.g. "v0.12.40"). Bare input
 * stays bare ("0.9.0" → "0.9.0"); "main" → null. The platform's own default
 * tag never flows through here — it is `PLATFORM_VERSION`, which is always bare.
 */
export function resolveRequestedImageTag(repoRef: string): string | null {
  const trimmed = repoRef.trim();
  if (!trimmed || trimmed === 'main') return null;
  if (!RELEASE_TAG_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * Upsert keys into env-file content, preserving comments and layout.
 *
 * A key that appears more than once is written to its LAST occurrence and the
 * earlier ones are deleted (#628). It used to write the FIRST and leave the
 * rest — while dotenv, `docker compose --env-file` and `bash source` all take
 * the last. So on a file with a duplicated key the app's write was read back as
 * the stale value, with nothing reporting a problem: `K=first / K=second`,
 * write `K=NEW`, and every reader still says `second`. Verified against both
 * readers before and after.
 */
export function mergeEnvContent(
  content: string,
  updates: Record<string, string>,
  options: { uncomment?: boolean; sectionHeader?: string } = {}
): string {
  const lines = content.split('\n');
  const remaining = new Map(Object.entries(updates));

  /** Index of each key's occurrences, in file order. */
  const seen = new Map<string, number[]>();
  const prefixes = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    let testLine = lines[i].trim();
    if (options.uncomment) {
      testLine = testLine.replace(/^#\s*/, '').trim();
    }
    const hadExport = testLine.startsWith('export ');
    if (hadExport) {
      testLine = testLine.slice(7).trimStart();
    }
    const eq = testLine.indexOf('=');
    if (eq <= 0) continue;
    const key = testLine.slice(0, eq).trim();
    if (!remaining.has(key)) continue;
    seen.set(key, [...(seen.get(key) ?? []), i]);
    prefixes.set(i, hadExport ? 'export ' : '');
  }

  const doomed = new Set<number>();
  for (const [key, indices] of seen) {
    const target = indices[indices.length - 1];
    const value = remaining.get(key) as string;
    lines[target] = `${prefixes.get(target) ?? ''}${key}=${quoteComposeEnvValue(value, key)}`;
    // The shadowed earlier copies go: leaving them would keep a value in the
    // file that no reader uses and that a later hand-edit could resurrect.
    for (const index of indices.slice(0, -1)) doomed.add(index);
    remaining.delete(key);
  }
  const kept = doomed.size > 0 ? lines.filter((_line, index) => !doomed.has(index)) : lines;

  if (remaining.size > 0) {
    if (kept.length === 0 || kept[kept.length - 1] !== '') {
      kept.push('');
    }
    if (options.sectionHeader) {
      kept.push(options.sectionHeader);
    }
    for (const [key, value] of remaining) {
      kept.push(`${key}=${quoteComposeEnvValue(value, key)}`);
    }
  }

  return kept.join('\n');
}
