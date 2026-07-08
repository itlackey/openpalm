import type { APIRequestContext, BrowserContext } from '@playwright/test';

function extractSessionCookie(setCookie: string | undefined): string {
  if (!setCookie) throw new Error('Login response did not include Set-Cookie');
  const match = setCookie.match(/(?:^|,\s*)op_session=([^;]+)/);
  if (!match) throw new Error(`Could not parse op_session from Set-Cookie: ${setCookie}`);
  return match[1];
}

export async function loginAndGetSessionCookie(
  request: APIRequestContext,
  adminUrl: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${adminUrl}/api/auth/login`, {
    data: { password },
  });
  if (!res.ok()) {
    throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
  }
  return extractSessionCookie(res.headers()['set-cookie']);
}

export async function loginHeaders(
  request: APIRequestContext,
  adminUrl: string,
  password: string,
): Promise<Record<string, string>> {
  const cookie = await loginAndGetSessionCookie(request, adminUrl, password);
  return {
    cookie: `op_session=${cookie}`,
    'x-requested-by': 'e2e-test',
    'x-request-id': crypto.randomUUID(),
    'content-type': 'application/json',
  };
}

export async function loginBrowserContext(
  request: APIRequestContext,
  context: BrowserContext,
  adminUrl: string,
  password: string,
): Promise<void> {
  const cookie = await loginAndGetSessionCookie(request, adminUrl, password);
  const url = new URL(adminUrl);
  await context.addCookies([
    {
      name: 'op_session',
      value: cookie,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
