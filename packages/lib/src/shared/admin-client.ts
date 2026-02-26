export type AdminClientOptions = {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
};
const DEFAULT_ADMIN_TIMEOUT_MS = 15000;

type EnvMap = Record<string, string | undefined>;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  // Internal compose DNS names used by OpenPalm core services.
  if (hostname === "localhost" || hostname === "admin" || hostname === "gateway") return true;
  if (hostname.startsWith("127.")) return true;
  if (hostname.startsWith("10.")) return true;
  if (hostname.startsWith("192.168.")) return true;
  if (hostname === "::1") return true;
  const match = /^172\.(\d{1,3})\./.exec(hostname);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  if (!Number.isInteger(secondOctet) || secondOctet < 0 || secondOctet > 255) return false;
  return secondOctet >= 16 && secondOctet <= 31;
}

export function resolveAdminBaseUrl(env: EnvMap): string {
  const baseUrl =
    env.OPENPALM_ADMIN_API_URL ??
    env.ADMIN_APP_URL ??
    env.GATEWAY_URL ??
    "http://localhost:8100";
  return trimTrailingSlash(baseUrl);
}

export function resolveAdminToken(env: EnvMap): string | undefined {
  if (env.OPENPALM_ADMIN_TOKEN && env.OPENPALM_ADMIN_TOKEN.trim().length > 0)
    return env.OPENPALM_ADMIN_TOKEN;
  if (env.ADMIN_TOKEN && env.ADMIN_TOKEN.trim().length > 0) return env.ADMIN_TOKEN;
  return undefined;
}

export function validateAdminBaseUrl(baseUrl: string, allowInsecureHttp: boolean = false): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("invalid_admin_api_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("invalid_admin_api_protocol");
  }
  if (parsed.protocol === "http:" && !allowInsecureHttp && !isPrivateOrLocalHostname(parsed.hostname)) {
    throw new Error("insecure_admin_api_url");
  }
}

export class AdminApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: AdminClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ADMIN_TIMEOUT_MS;
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-admin-token": this.token,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const parsed = text ? JSON.parse(text) : {};
      throw new Error(parsed.error ?? `http_${response.status}`);
    }
    return text ? JSON.parse(text) : ({ ok: true } as T);
  }

  async health() { return this.request("GET", "/health"); }
  async listContainers() { return this.request("GET", "/containers"); }
  async containerUp(service: string) { return this.request("POST", "/containers/up", { service }); }
  async containerStop(service: string) { return this.request("POST", "/containers/stop", { service }); }
  async containerRestart(service: string) { return this.request("POST", "/containers/restart", { service }); }
  async containerUpdate(service: string) { return this.request("POST", "/containers/update", { service }); }
  async serviceLogs(service: string, tail?: number) { return this.request("POST", "/containers/service-logs", { service, ...(tail ? { tail } : {}) }); }
  async listChannels() { return this.request("GET", "/channels"); }
  async getStackSpec() { return this.request("GET", "/stack/spec"); }
  async setStackSpec(spec: unknown) { return this.request("POST", "/stack/spec", { spec }); }
  async applyStack() { return this.request("POST", "/stack/apply"); }
}
