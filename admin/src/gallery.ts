// ── Gallery item types ──────────────────────────────────────────────

export type GalleryCategory = "plugin" | "skill" | "container";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export type GalleryItem = {
  id: string;
  name: string;
  description: string;
  category: GalleryCategory;
  risk: RiskLevel;
  author: string;
  version: string;
  source: string;
  tags: string[];
  permissions: string[];
  securityNotes: string;
  installAction: "plugin" | "skill-file" | "compose-service";
  installTarget: string; // npm package, skill file path, or compose service name
  docUrl?: string;
};

// ── Curated gallery registry ────────────────────────────────────────
// This acts like LocalAI's model gallery — a curated, audited set of
// known-good extensions. Each entry has been reviewed for risk and
// includes security notes so users understand what they're installing.

const REGISTRY: GalleryItem[] = [
  // ── Plugins ───────────────────────────────────────────────────────
  {
    id: "plugin-policy-telemetry",
    name: "Policy & Telemetry",
    description: "Built-in plugin that blocks secrets from tool arguments and logs every tool call as structured JSON. Ships with OpenPalm by default.",
    category: "plugin",
    risk: "low",
    author: "OpenPalm",
    version: "built-in",
    source: "./.opencode/plugins/policy-and-telemetry.ts",
    tags: ["security", "audit", "built-in"],
    permissions: ["onToolCall hook"],
    securityNotes: "Read-only hook — inspects tool calls but cannot modify responses. Logs to stdout only.",
    installAction: "plugin",
    installTarget: "./.opencode/plugins/policy-and-telemetry.ts"
  },
  {
    id: "plugin-opencode-memory-guard",
    name: "Memory Guard",
    description: "Plugin that intercepts memory writes and applies additional PII/secret detection before data reaches OpenMemory. Adds a second layer of defense beyond the gateway's built-in checks.",
    category: "plugin",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "./.opencode/plugins/memory-guard.ts",
    tags: ["security", "memory", "pii"],
    permissions: ["onToolCall hook", "memory write interception"],
    securityNotes: "Intercepts memory_write tool calls. Cannot exfiltrate data — runs inside OpenCode sandbox with no network access.",
    installAction: "plugin",
    installTarget: "./.opencode/plugins/memory-guard.ts"
  },
  {
    id: "plugin-rate-limit-enforcer",
    name: "Rate Limit Enforcer",
    description: "Plugin-level rate limiting that tracks tool call frequency per session. Provides a second rate-limiting layer in addition to the gateway's per-user limits.",
    category: "plugin",
    risk: "low",
    author: "OpenPalm",
    version: "1.0.0",
    source: "./.opencode/plugins/rate-limit-enforcer.ts",
    tags: ["security", "rate-limiting"],
    permissions: ["onToolCall hook"],
    securityNotes: "Read-only counting — denies calls that exceed threshold but cannot modify tool behavior.",
    installAction: "plugin",
    installTarget: "./.opencode/plugins/rate-limit-enforcer.ts"
  },
  {
    id: "plugin-response-sanitizer",
    name: "Response Sanitizer",
    description: "Scans LLM responses for accidental credential leaks, internal URLs, and PII before they reach the user. Defense in depth for output safety.",
    category: "plugin",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "./.opencode/plugins/response-sanitizer.ts",
    tags: ["security", "output-safety", "pii"],
    permissions: ["onResponse hook"],
    securityNotes: "Inspects outbound responses. Can redact content but cannot make external calls.",
    installAction: "plugin",
    installTarget: "./.opencode/plugins/response-sanitizer.ts"
  },

  // ── Skills ────────────────────────────────────────────────────────
  {
    id: "skill-recall-first",
    name: "Recall First",
    description: "Standard operating procedure: always query memory for user-specific context before answering. Explains relevance and includes memory IDs in responses for trust.",
    category: "skill",
    risk: "low",
    author: "OpenPalm",
    version: "built-in",
    source: "skills/RecallFirst.SKILL.md",
    tags: ["memory", "behavior", "built-in"],
    permissions: ["Behavioral — no tool access"],
    securityNotes: "Pure behavioral SOP. No tool access, no side effects. Guides how the assistant uses existing memory tools.",
    installAction: "skill-file",
    installTarget: "skills/RecallFirst.SKILL.md"
  },
  {
    id: "skill-memory-policy",
    name: "Memory Policy",
    description: "Governs when to store data in memory: explicit-save only, redact secrets, track source and confidence. Prevents accidental data hoarding.",
    category: "skill",
    risk: "low",
    author: "OpenPalm",
    version: "built-in",
    source: "skills/MemoryPolicy.SKILL.md",
    tags: ["memory", "privacy", "built-in"],
    permissions: ["Behavioral — no tool access"],
    securityNotes: "Restricts memory writes. Pure behavioral SOP with no tool access.",
    installAction: "skill-file",
    installTarget: "skills/MemoryPolicy.SKILL.md"
  },
  {
    id: "skill-action-gating",
    name: "Action Gating",
    description: "Classifies actions into safe/medium/high risk tiers and requires explicit user approval for medium+ actions. Prevents the assistant from taking destructive actions autonomously.",
    category: "skill",
    risk: "low",
    author: "OpenPalm",
    version: "built-in",
    source: "skills/ActionGating.SKILL.md",
    tags: ["security", "approval", "built-in"],
    permissions: ["Behavioral — no tool access"],
    securityNotes: "Adds approval gates. Pure behavioral SOP — makes the assistant more cautious, never less.",
    installAction: "skill-file",
    installTarget: "skills/ActionGating.SKILL.md"
  },
  {
    id: "skill-code-review",
    name: "Code Review",
    description: "SOP for reviewing code changes: check for security issues (injection, XSS, secrets), verify test coverage, validate error handling. Useful for development-focused assistants.",
    category: "skill",
    risk: "low",
    author: "OpenPalm",
    version: "1.0.0",
    source: "skills/CodeReview.SKILL.md",
    tags: ["development", "security", "review"],
    permissions: ["Behavioral — no tool access"],
    securityNotes: "Read-only behavioral SOP. Guides analysis but cannot modify code.",
    installAction: "skill-file",
    installTarget: "skills/CodeReview.SKILL.md"
  },
  {
    id: "skill-summarize-context",
    name: "Context Summarizer",
    description: "SOP for summarizing long conversations and documents. Extracts key facts, decisions, and action items while preserving important context.",
    category: "skill",
    risk: "low",
    author: "OpenPalm",
    version: "1.0.0",
    source: "skills/SummarizeContext.SKILL.md",
    tags: ["productivity", "memory", "summarization"],
    permissions: ["Behavioral — no tool access"],
    securityNotes: "Pure behavioral SOP. No tool access or side effects.",
    installAction: "skill-file",
    installTarget: "skills/SummarizeContext.SKILL.md"
  },

  // ── Containers ────────────────────────────────────────────────────
  {
    id: "container-channel-chat",
    name: "Chat Channel",
    description: "HTTP-based chat adapter. Accepts JSON messages and routes them through the gateway for processing. Ideal for web chat widgets and custom frontends.",
    category: "container",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/chat",
    tags: ["channel", "http", "chat"],
    permissions: ["Network: outbound to gateway only", "HMAC channel signing"],
    securityNotes: "Dumb adapter — normalizes input and forwards to gateway. All auth and policy enforced by gateway. HMAC-signed payloads prevent tampering.",
    installAction: "compose-service",
    installTarget: "channel-chat"
  },
  {
    id: "container-channel-discord",
    name: "Discord Channel",
    description: "Discord bot adapter supporting slash commands and webhook-based message forwarding. Routes all messages through the gateway for defense in depth.",
    category: "container",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/discord",
    tags: ["channel", "discord", "bot"],
    permissions: ["Network: outbound to gateway + Discord API", "HMAC channel signing", "Requires DISCORD_BOT_TOKEN"],
    securityNotes: "Requires Discord bot token (stored in .env, never in container). All messages pass through gateway tool firewall before reaching OpenCode.",
    installAction: "compose-service",
    installTarget: "channel-discord",
    docUrl: "https://discord.com/developers/docs"
  },
  {
    id: "container-channel-voice",
    name: "Voice Channel",
    description: "Voice/speech-to-text adapter. Accepts transcribed text from an STT pipeline and routes through the gateway. WebSocket streaming endpoint planned.",
    category: "container",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/voice",
    tags: ["channel", "voice", "stt"],
    permissions: ["Network: outbound to gateway only", "HMAC channel signing"],
    securityNotes: "Accepts pre-transcribed text only. No direct microphone access. All input passes through gateway rate limiting and tool firewall.",
    installAction: "compose-service",
    installTarget: "channel-voice"
  },
  {
    id: "container-channel-telegram",
    name: "Telegram Channel",
    description: "Telegram bot adapter. Receives webhook updates from Telegram's Bot API and forwards text messages through the gateway.",
    category: "container",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/telegram",
    tags: ["channel", "telegram", "bot"],
    permissions: ["Network: outbound to gateway + Telegram API", "HMAC channel signing", "Requires TELEGRAM_BOT_TOKEN"],
    securityNotes: "Requires Telegram bot token (stored in .env). Validates Telegram's webhook secret header. All messages pass through gateway.",
    installAction: "compose-service",
    installTarget: "channel-telegram",
    docUrl: "https://core.telegram.org/bots/api"
  },
  {
    id: "container-n8n",
    name: "n8n Workflow Automation",
    description: "Self-hosted workflow automation tool. Connect OpenPalm to hundreds of services via visual workflows. Runs as a separate container with gateway API access.",
    category: "container",
    risk: "high",
    author: "n8n.io",
    version: "latest",
    source: "docker.io/n8nio/n8n",
    tags: ["automation", "workflows", "integration"],
    permissions: ["Network: outbound to gateway + external services", "Persistent storage", "May require additional credentials"],
    securityNotes: "HIGH RISK: n8n can make arbitrary network requests and execute code in workflows. Restrict to LAN access via Caddy. Review workflows before enabling external connections. Use credential encryption.",
    installAction: "compose-service",
    installTarget: "n8n"
  },
  {
    id: "container-ollama",
    name: "Ollama (Local LLM)",
    description: "Run local LLM models alongside OpenCode. Useful for offline inference, private data processing, or cost reduction on simple tasks.",
    category: "container",
    risk: "medium",
    author: "Ollama",
    version: "latest",
    source: "docker.io/ollama/ollama",
    tags: ["llm", "local", "inference"],
    permissions: ["GPU access (optional)", "Persistent model storage", "Network: internal only"],
    securityNotes: "Runs on internal network only. No external API access by default. Model downloads require temporary outbound access. Large disk footprint.",
    installAction: "compose-service",
    installTarget: "ollama"
  },
  {
    id: "container-searxng",
    name: "SearXNG (Private Search)",
    description: "Privacy-respecting metasearch engine. Provides web search capabilities to the assistant without sending queries to commercial search APIs.",
    category: "container",
    risk: "medium",
    author: "SearXNG",
    version: "latest",
    source: "docker.io/searxng/searxng",
    tags: ["search", "privacy", "web"],
    permissions: ["Network: outbound to search engines", "No persistent storage needed"],
    securityNotes: "Makes outbound requests to search engines on behalf of the assistant. Restrict to internal network. Does not store search history by default.",
    installAction: "compose-service",
    installTarget: "searxng"
  }
];

// ── Gallery search ──────────────────────────────────────────────────

export function searchGallery(query: string, category?: GalleryCategory): GalleryItem[] {
  const q = query.toLowerCase().trim();
  let items = REGISTRY;
  if (category) items = items.filter((i) => i.category === category);
  if (!q) return items;
  return items.filter((item) =>
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.tags.some((t) => t.includes(q)) ||
    item.id.includes(q)
  );
}

export function getGalleryItem(id: string): GalleryItem | null {
  return REGISTRY.find((i) => i.id === id) ?? null;
}

export function listGalleryCategories(): { category: GalleryCategory; count: number }[] {
  const counts: Record<string, number> = {};
  for (const item of REGISTRY) {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  }
  return Object.entries(counts).map(([category, count]) => ({ category: category as GalleryCategory, count }));
}

// ── Public community registry ────────────────────────────────────────
// Fetched at runtime from the registry/ folder in the GitHub repo.
// Admins can discover community-submitted extensions without rebuilding images.
// Set OPENPALM_REGISTRY_URL env var to override (e.g. for self-hosted forks).

const DEFAULT_REGISTRY_URL =
  process.env.OPENPALM_REGISTRY_URL ??
  "https://raw.githubusercontent.com/itlackey/openpalm/main/registry/index.json";

// Simple in-memory cache — refreshes every 10 minutes
let _registryCache: { items: GalleryItem[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000;

export async function fetchPublicRegistry(forceRefresh = false): Promise<GalleryItem[]> {
  const now = Date.now();
  if (!forceRefresh && _registryCache && now - _registryCache.fetchedAt < CACHE_TTL_MS) {
    return _registryCache.items;
  }

  try {
    const resp = await fetch(DEFAULT_REGISTRY_URL, {
      headers: { "Accept": "application/json", "User-Agent": "openpalm-admin/1.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return _registryCache?.items ?? [];
    const raw = (await resp.json()) as unknown;
    if (!Array.isArray(raw)) return _registryCache?.items ?? [];

    // Filter to only well-formed entries (must have id, name, category at minimum)
    const items = raw.filter(
      (e): e is GalleryItem =>
        e != null &&
        typeof e === "object" &&
        typeof (e as Record<string, unknown>).id === "string" &&
        typeof (e as Record<string, unknown>).name === "string" &&
        typeof (e as Record<string, unknown>).category === "string"
    );

    _registryCache = { items, fetchedAt: now };
    return items;
  } catch {
    // Network error — return stale cache or empty
    return _registryCache?.items ?? [];
  }
}

export async function getPublicRegistryItem(id: string): Promise<GalleryItem | null> {
  const items = await fetchPublicRegistry();
  return items.find((i) => i.id === id) ?? null;
}

export async function searchPublicRegistry(
  query: string,
  category?: GalleryCategory
): Promise<GalleryItem[]> {
  const all = await fetchPublicRegistry();
  const q = query.toLowerCase().trim();
  let items = all;
  if (category) items = items.filter((i) => i.category === category);
  if (!q) return items;
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.description.toLowerCase().includes(q) ||
      item.tags.some((t) => t.toLowerCase().includes(q)) ||
      item.id.toLowerCase().includes(q)
  );
}

// ── npm search (for discovering plugins not in the curated registry) ─

export async function searchNpm(query: string): Promise<Array<{ name: string; description: string; version: string; author: string }>> {
  try {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query + " opencode plugin")}&size=20`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = (await resp.json()) as { objects?: Array<{ package: { name: string; description?: string; version: string; publisher?: { username?: string } } }> };
    return (data.objects ?? []).map((o) => ({
      name: o.package.name,
      description: o.package.description ?? "",
      version: o.package.version,
      author: o.package.publisher?.username ?? "unknown"
    }));
  } catch {
    return [];
  }
}

// ── Security helpers for the UI ─────────────────────────────────────

export function getRiskBadge(risk: RiskLevel): { label: string; color: string; description: string } {
  switch (risk) {
    case "low": return { label: "Low Risk", color: "#34c759", description: "Safe to install. No network access, no side effects." };
    case "medium": return { label: "Medium Risk", color: "#ff9500", description: "Limited capabilities. Review permissions before installing." };
    case "high": return { label: "High Risk", color: "#ff3b30", description: "Significant capabilities. Review carefully before installing." };
    case "critical": return { label: "Critical Risk", color: "#af52de", description: "Maximum capability. Can execute code, access network, or modify system state. Review thoroughly." };
  }
}
