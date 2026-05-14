import { parse as dotenvParse } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';

export function parseEnvContent(content: string): Record<string, string> {
  return dotenvParse(content);
}

export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    return dotenvParse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function quoteEnvValue(value: string): string {
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
