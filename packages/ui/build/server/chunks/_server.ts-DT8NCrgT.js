import { u as unauthorizedJson, j as json } from './json-juD_ypql.js';
import { O as OPENPALM_ASSISTANT_URL } from './config-B06wMz0z.js';
import './index-CoD1IJuy.js';
import './shared-server-DaWdgxVh.js';

const SAFE_FORWARD_HEADERS = ["content-type", "accept", "content-length"];
function buildSafeHeaders(original) {
  const safe = new Headers();
  for (const name of SAFE_FORWARD_HEADERS) {
    const value = original.get(name);
    if (value) safe.set(name, value);
  }
  return safe;
}
const handler = async ({ params, url, request, locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const subpath = params.path ? `/${params.path}` : "/";
  const target = `${OPENPALM_ASSISTANT_URL}${subpath}${url.search}`;
  try {
    const proxyResp = await fetch(target, {
      method: request.method,
      headers: buildSafeHeaders(request.headers),
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : void 0,
      signal: AbortSignal.timeout(3e5),
      // 5 minutes for AI responses
      // @ts-expect-error duplex needed for streaming body
      duplex: "half"
    });
    return new Response(proxyResp.body, {
      status: proxyResp.status,
      headers: proxyResp.headers
    });
  } catch {
    return json(502, { error: "assistant_unavailable" });
  }
};
const GET = handler;
const POST = handler;
const PUT = handler;
const DELETE = handler;
const PATCH = handler;

export { DELETE, GET, PATCH, POST, PUT };
//# sourceMappingURL=_server.ts-DT8NCrgT.js.map
