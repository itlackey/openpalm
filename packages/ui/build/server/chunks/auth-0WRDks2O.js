import { createHmac, timingSafeEqual } from 'node:crypto';
import { A as ADMIN_TOKEN, D as DEFAULT_INSECURE_TOKEN } from './config-B06wMz0z.js';

const TOKEN_HMAC_KEY = "openpalm-token-compare";
function hmacCompare(a, b) {
  const hmacA = createHmac("sha256", TOKEN_HMAC_KEY).update(a).digest();
  const hmacB = createHmac("sha256", TOKEN_HMAC_KEY).update(b).digest();
  return timingSafeEqual(hmacA, hmacB);
}
function verifyAdminToken(token) {
  if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) return false;
  if (!ADMIN_TOKEN) return false;
  return hmacCompare(token, ADMIN_TOKEN);
}
function isLocalRequest(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? "127.0.0.1";
  const localPatterns = [
    "127.0.0.1",
    "::1",
    "10.",
    "172.16.",
    "172.17.",
    "172.18.",
    "172.19.",
    "172.20.",
    "172.21.",
    "172.22.",
    "172.23.",
    "172.24.",
    "172.25.",
    "172.26.",
    "172.27.",
    "172.28.",
    "172.29.",
    "172.30.",
    "172.31.",
    "192.168."
  ];
  return localPatterns.some((p) => ip.startsWith(p));
}

export { isLocalRequest as i, verifyAdminToken as v };
//# sourceMappingURL=auth-0WRDks2O.js.map
