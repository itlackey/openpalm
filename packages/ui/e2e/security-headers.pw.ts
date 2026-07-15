import { expect, test } from '@playwright/test';

test('production HTML CSP permits HTTP(S) OpenCode frames and retains its other restrictions', async ({
  request,
}) => {
  const response = await request.get('/login', { headers: { accept: 'text/html' } });
  const csp = response.headers()['content-security-policy'] ?? '';

  expect(response.status()).toBe(200);
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-src 'self' http: https:");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(response.headers()['x-frame-options']).toBe('DENY');
});
