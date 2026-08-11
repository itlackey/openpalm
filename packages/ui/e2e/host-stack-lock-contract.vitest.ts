import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(
  new URL('../src/routes/api/host/stack/+server.ts', import.meta.url),
  'utf8',
);

describe('host stack access apply lock contract', () => {
  test('passes the outer admin update lock into applyAccessToggles', () => {
    expect(routeSource).toMatch(
      /withAdminUpdateLock\(state,\s*requestId,\s*async \(lock\) => \{[\s\S]*?applyAccessToggles\([\s\S]*?\{ lock \}\s*\)/,
    );
  });
});
