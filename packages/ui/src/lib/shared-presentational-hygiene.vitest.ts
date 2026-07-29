import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_ROOTS = ['components/common', 'components/icons', 'actions'].map((path) =>
  fileURLToPath(new URL(`./${path}/`, import.meta.url)),
);

function sourceFiles(): string[] {
  return SHARED_ROOTS.flatMap((root) => {
    if (!existsSync(root)) return [];
    return (readdirSync(root, { recursive: true }) as string[])
      .filter((rel) => /\.(svelte|ts|js)$/.test(rel))
      .map((rel) => join(root, rel));
  });
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: '$lib/api', pattern: /^\$lib\/api(\.js|\.ts)?(\/|$)/ },
  { name: '$lib/server', pattern: /^\$lib\/server(\/|$)/ },
  { name: '@openpalm/lib', pattern: /^@openpalm\/lib(\/|$)/ },
  { name: 'chat state', pattern: /chat-state|(^|\/)chat\// },
  { name: 'connections store', pattern: /endpoints-state|connections-state|connection-state/ },
  { name: 'voice state', pattern: /voice-state|(^|\/)voice\// },
];

describe('shared presentational source has no control-plane coupling', () => {
  test('shared source does not import server, control-plane, or feature state', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf-8'))) {
        for (const { name, pattern } of FORBIDDEN) {
          if (pattern.test(specifier)) offenders.push(`${file} imports ${specifier} (${name})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('shared source directories are populated', () => {
    expect(sourceFiles().length).toBeGreaterThanOrEqual(60);
  });
});
