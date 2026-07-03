export interface AllowlistRoute {
  method: string;
  template: string;
}

export interface AllowlistMatch {
  allowed: boolean;
  route?: AllowlistRoute;
  params?: Record<string, string>;
  reason?: 'invalid_encoding' | 'non_canonical_path' | 'no_route';
}

export const OC_ALLOWLIST: readonly AllowlistRoute[] = Object.freeze([
  { method: 'POST', template: '/session' },
  { method: 'GET', template: '/session' },
  { method: 'GET', template: '/session/{id}' },
  { method: 'DELETE', template: '/session/{id}' },
  { method: 'POST', template: '/session/{id}/message' },
  { method: 'POST', template: '/session/{id}/prompt_async' },
  { method: 'GET', template: '/event' },
  { method: 'POST', template: '/permission/{requestID}/reply' },
  { method: 'POST', template: '/question/{requestID}/reply' },
  { method: 'POST', template: '/question/{requestID}/reject' },
  { method: 'POST', template: '/session/{id}/abort' },
]);

const PARAM_RE = /^[A-Za-z0-9_-]+$/;

function percentDecode(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function canonicalize(path: string): string {
  if (!path.startsWith('/')) return path;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

function matchTemplate(template: string, path: string): Record<string, string> | null {
  const tSegs = template.split('/');
  const pSegs = path.split('/');
  if (tSegs.length !== pSegs.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < tSegs.length; i++) {
    const t = tSegs[i];
    const p = pSegs[i];
    if (t.startsWith('{') && t.endsWith('}')) {
      const name = t.slice(1, -1);
      if (!PARAM_RE.test(p)) return null;
      params[name] = p;
    } else if (t !== p) {
      return null;
    }
  }
  return params;
}

export function matchAllowlist(method: string, rawPath: string): AllowlistMatch {
  const decoded = percentDecode(rawPath);
  if (decoded === null) {
    return { allowed: false, reason: 'invalid_encoding' };
  }
  if (decoded !== canonicalize(decoded)) {
    return { allowed: false, reason: 'non_canonical_path' };
  }
  for (const route of OC_ALLOWLIST) {
    if (route.method !== method) continue;
    const params = matchTemplate(route.template, decoded);
    if (params) {
      return { allowed: true, route, params };
    }
  }
  return { allowed: false, reason: 'no_route' };
}
