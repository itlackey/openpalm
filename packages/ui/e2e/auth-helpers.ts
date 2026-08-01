import type { APIRequestContext, BrowserContext } from '@playwright/test';

export type SessionCookie = { name: 'op_session' | 'op_session_assistant'; value: string };

export function extractSessionCookie(setCookie: string | undefined): SessionCookie {
  if (!setCookie) throw new Error('Login response did not include Set-Cookie');
  const match = setCookie.match(/(?:^|,\s*)(op_session|op_session_assistant)=([^;]+)/);
  if (!match) throw new Error(`Could not parse session cookie from Set-Cookie: ${setCookie}`);
  const [, name, value] = match;
  if ((name !== 'op_session' && name !== 'op_session_assistant') || !value) {
    throw new Error(`Could not parse session cookie from Set-Cookie: ${setCookie}`);
  }
  return { name, value };
}

export async function loginAndGetSessionCookie(
  request: APIRequestContext,
  adminUrl: string,
  password: string,
): Promise<SessionCookie> {
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
    cookie: `${cookie.name}=${cookie.value}`,
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
      name: cookie.name,
      value: cookie.value,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
