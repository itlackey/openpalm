// Friendly error mapping for the setup wizard.
// Maps raw API/network/Docker errors to user-actionable text.

export interface FriendlyErrorLink {
  label: string;
  href: string;
}

export interface FriendlyErrorView {
  title: string;
  body: string;
  hint?: string;
  links?: FriendlyErrorLink[];
  /** Original raw error preserved for the "Technical details" disclosure. */
  raw: string;
}

export type FriendlyErrorContext =
  | "provider-verify"
  | "model-fetch"
  | "setup-complete"
  | "deploy"
  | "deploy-poll"
  | "system-check"
  | "channel"
  | "generic";

const DOCKER_LINK: FriendlyErrorLink = {
  label: "Docker setup",
  href: "https://docs.docker.com/get-docker/",
};

function rawText(raw: unknown): string {
  if (!raw) return "";
  if (raw instanceof Error) return raw.message;
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

export function friendlyError(raw: unknown, context: FriendlyErrorContext = "generic"): FriendlyErrorView {
  const text = rawText(raw);
  const lower = text.toLowerCase();

  // Auth — 401/403/unauthorized
  if (/\b(401|403|unauthorized|forbidden|invalid.?api.?key)\b/i.test(text)) {
    return {
      title: "API key rejected",
      body: "The provider rejected the API key.",
      hint: "Double-check the key and that it has access to the model you selected. Most providers show the key in their dashboard.",
      raw: text,
    };
  }

  // Unreachable host
  if (/\b(ENOTFOUND|ECONNREFUSED|getaddrinfo|EAI_AGAIN|EHOSTUNREACH)\b/i.test(text)) {
    return {
      title: "Couldn't reach the host",
      body: text,
      hint: "Confirm the URL is correct and the service is online. For local providers (Ollama, LM Studio) make sure the server is running on this machine.",
      raw: text,
    };
  }

  // Timeout
  if (/(timeout|timed out|AbortError|ETIMEDOUT)/i.test(text)) {
    return {
      title: "Request timed out",
      body: "The provider didn't respond in time.",
      hint: "It may be slow or temporarily down. Try again in a moment.",
      raw: text,
    };
  }

  // Docker / compose
  if (lower.includes("docker") || lower.includes("compose") || lower.includes("daemon")) {
    return {
      title: "Docker isn't available",
      body: "OpenPalm needs Docker (with Compose v2) installed and running.",
      hint: "Start Docker Desktop (macOS/Windows) or the docker daemon (Linux), then retry.",
      links: [DOCKER_LINK],
      raw: text,
    };
  }

  // Port conflict
  if (/EADDRINUSE/i.test(text) || /port.*in.?use/i.test(lower)) {
    return {
      title: "A required port is already in use",
      body: text,
      hint: "Another program is using one of OpenPalm's default ports (3800, 3880, or 8180). Quit the other process or set a custom port in stack.env.",
      raw: text,
    };
  }

  // Filesystem permissions
  if (/EACCES|EPERM|permission denied/i.test(text)) {
    return {
      title: "Permission denied",
      body: text,
      hint: "OpenPalm couldn't write to its data directory. Check that ~/.openpalm/ is writable by your user.",
      raw: text,
    };
  }

  // Context-specific defaults
  switch (context) {
    case "provider-verify":
    case "model-fetch":
      return {
        title: "Couldn't connect to the provider",
        body: text || "Verification failed.",
        hint: "Check the API key and base URL, then click Verify again.",
        raw: text,
      };
    case "setup-complete":
      return {
        title: "Setup couldn't finish",
        body: text || "Writing configuration failed.",
        hint: "Check the technical details below, then retry. If the issue persists, the admin dashboard logs may help.",
        raw: text,
      };
    case "deploy":
    case "deploy-poll":
      return {
        title: "Deployment ran into a problem",
        body: text || "One or more services failed to start.",
        hint: "Image pulls can take several minutes on first install. Retry to attempt again; check Docker logs if it keeps failing.",
        raw: text,
      };
    case "system-check":
      return {
        title: "System check failed",
        body: text || "A required dependency is missing.",
        hint: "Resolve the failing check above, then click Retry.",
        raw: text,
      };
    case "channel":
      return {
        title: "Channel credential issue",
        body: text || "A required field is missing or invalid.",
        hint: "Confirm the bot token and other required fields are correct.",
        raw: text,
      };
    default:
      return {
        title: "Something went wrong",
        body: text || "An unexpected error occurred.",
        hint: "Try again. If the problem persists, check the admin dashboard logs.",
        raw: text,
      };
  }
}
