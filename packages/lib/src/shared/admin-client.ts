export type AdminCommandResponse<T = unknown> = {
  ok?: boolean;
  data?: T;
  error?: string;
  code?: string;
};

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

  async command<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<AdminCommandResponse<T>> {
    const response = await fetch(`${this.baseUrl}/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": this.token,
      },
      body: JSON.stringify({ type, payload }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const bodyText = await response.text();
    let body: AdminCommandResponse<T>;
    if (bodyText.length === 0) {
      if (!response.ok) throw new Error(`http_${response.status}: ${response.statusText}`);
      body = { ok: response.ok } as AdminCommandResponse<T>;
    } else {
      try {
        body = JSON.parse(bodyText) as AdminCommandResponse<T>;
      } catch {
        throw new Error("invalid_admin_api_response");
      }
    }
    if (!response.ok || body.ok === false) {
      const code = body.code ?? `http_${response.status}`;
      const message = body.error ?? response.statusText ?? "admin_request_failed";
      throw new Error(`${code}: ${message}`);
    }
    return body;
  }
}
