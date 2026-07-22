import { createHash } from 'node:crypto';
import { expect, test } from './fixtures.js';

test('production HTML CSP permits HTTP(S) OpenCode frames and retains its other restrictions', async ({
  request,
}) => {
  const response = await request.get('/login', { headers: { accept: 'text/html' } });
  const csp = response.headers()['content-security-policy'] ?? '';
  const html = await response.text();
  const favicon = await request.get('/logo-128.png');

  expect(response.status()).toBe(200);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-src 'self' http: https:");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(response.headers()['x-frame-options']).toBe('DENY');
  expect(html).toContain('<link rel="icon" type="image/png" href="/logo-128.png"');
  expect(favicon.status()).toBe(200);

  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const script = match[1];
    if (!script.trim()) continue;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(csp).toContain(`'sha256-${hash}'`);
  }
});
