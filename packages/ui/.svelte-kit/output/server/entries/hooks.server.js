import { v as verifyAdminToken } from "../chunks/auth.js";
import { e as ensureInitialized, a as getSetupManager } from "../chunks/init.js";
function isPrivateOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname.startsWith("10.") || hostname.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
function computeAllowedOrigin(scope, requestOrigin) {
  if (!requestOrigin) return "";
  if (scope === "public") return requestOrigin;
  if (scope === "lan") {
    if (isPrivateOrigin(requestOrigin)) return requestOrigin;
    return "http://localhost";
  }
  if (requestOrigin.includes("localhost") || requestOrigin.includes("127.0.0.1")) {
    return requestOrigin;
  }
  return "http://localhost";
}
const handle = async ({ event, resolve: resolveEvent }) => {
  await ensureInitialized();
  const setupManager = await getSetupManager();
  const { accessScope } = setupManager.getState();
  const requestOrigin = event.request.headers.get("origin") ?? "";
  const allowedOrigin = computeAllowedOrigin(accessScope ?? "host", requestOrigin);
  if (event.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...allowedOrigin ? { "access-control-allow-origin": allowedOrigin } : {},
        "access-control-allow-headers": "content-type, x-admin-token, x-request-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        vary: "Origin"
      }
    });
  }
  const token = event.request.headers.get("x-admin-token") ?? "";
  event.locals.authenticated = verifyAdminToken(token);
  const response = await resolveEvent(event);
  if (allowedOrigin) {
    response.headers.set("access-control-allow-origin", allowedOrigin);
  }
  response.headers.set(
    "access-control-allow-headers",
    "content-type, x-admin-token, x-request-id"
  );
  response.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  response.headers.append("vary", "Origin");
  return response;
};
export {
  handle
};
