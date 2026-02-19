// ── Gallery item types ──────────────────────────────────────────────

export type GalleryCategory = "plugin" | "skill" | "command" | "agent" | "tool" | "channel" | "service";
export type RiskLevel = "lowest" | "low" | "medium" | "medium-high" | "highest";

export type GalleryItem = {
  id: string;
  name: string;
  description: string;
  category: GalleryCategory;
  risk: RiskLevel;
  author?: string;
  version?: string;
  source: string;
  tags?: string[];
  permissions?: string[];
  securityNotes?: string;
  installAction?: "plugin" | "skill-file" | "command-file" | "agent-file" | "tool-file" | "compose-service";
  installTarget: string; // npm package, skill file path, or compose service name
  docUrl?: string;
  builtIn?: boolean;
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
    description: "Built-in security plugin that blocks secrets from leaking to memory and logs all tool calls. Ships by default as part of OpenPalm's defense-in-depth.",
    category: "plugin",
    risk: "highest",
    author: "OpenPalm",
    version: "built-in",
    source: "plugins/policy-and-telemetry.ts",
    tags: ["security", "audit", "built-in"],
    permissions: ["Monitors tool activity"],
    securityNotes: "Rated 'highest' because plugins CAN observe and modify all tool calls — but this specific plugin is read-only and protective. It blocks secrets from reaching memory and logs tool usage for audit. It cannot modify assistant responses.",
    installAction: "plugin",
    installTarget: "plugins/policy-and-telemetry.ts"
  },

  // ── Skills ────────────────────────────────────────────────────────
  {
    id: "skill-memory",
    name: "Memory Policy",
    description: "Governs memory storage and recall behavior for the assistant",
    category: "skill",
    risk: "lowest",
    author: "OpenPalm",
    version: "built-in",
    source: "skills/memory/SKILL.md",
    tags: ["memory", "behavior", "built-in"],
    permissions: ["No tool access — influences reasoning only"],
    securityNotes: "Pure markdown behavior file. Cannot execute code or access external resources.",
    installAction: "skill-file",
    installTarget: "skills/memory/SKILL.md",
    builtIn: true,
  },

  // ── Commands ──────────────────────────────────────────────────────
  {
    id: "command-health",
    name: "Health Check Command",
    description: "Slash command that reports the health status of all connected services.",
    category: "command" as GalleryCategory,
    risk: "low" as RiskLevel,
    author: "OpenPalm",
    version: "1.0.0",
    source: "bundled",
    tags: ["health", "status", "monitoring"],
    permissions: ["None — sends a predefined prompt"],
    securityNotes: "Triggers a prompt; cannot execute code or access external services.",
    installAction: "command-file",
    installTarget: "commands/health.md",
    builtIn: true,
  },

  // ── Agents ────────────────────────────────────────────────────────
  {
    id: "agent-channel-intake",
    name: "Channel Intake Agent",
    description: "Restricted agent that validates inbound channel messages for safety and correctness. Has zero tool access.",
    category: "agent" as GalleryCategory,
    risk: "medium" as RiskLevel,
    author: "OpenPalm",
    version: "1.0.0",
    source: "bundled",
    tags: ["security", "gateway", "validation"],
    permissions: ["Controls tool access policy (denies all tools)"],
    securityNotes: "Has no tool access. Can only reason about incoming text. Cannot make network requests, read files, or execute code.",
    installAction: "agent-file",
    installTarget: "agents/channel-intake.md",
    builtIn: true,
  },

  // ── Custom Tools ──────────────────────────────────────────────────
  {
    id: "tool-health-check",
    name: "Health Check Tool",
    description: "Custom tool that checks the health of configured services and returns structured status data.",
    category: "tool" as GalleryCategory,
    risk: "medium-high" as RiskLevel,
    author: "OpenPalm",
    version: "1.0.0",
    source: "bundled",
    tags: ["health", "monitoring", "services"],
    permissions: ["Network access to internal services", "Can execute health check scripts"],
    securityNotes: "Executes code to probe service endpoints. Only checks services on the internal Docker network.",
    installAction: "tool-file",
    installTarget: "tools/health-check.ts",
    builtIn: true,
  },

  // ── Channels ──────────────────────────────────────────────────────
  {
    id: "container-channel-chat",
    name: "Chat Channel",
    description: "HTTP-based chat adapter. Accepts JSON messages and routes them securely to your assistant. Ideal for web chat widgets and custom frontends.",
    category: "channel",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/chat",
    tags: ["channel", "http", "chat"],
    permissions: ["Internal network only", "Messages are cryptographically verified"],
    securityNotes: "Simple message relay with built-in security. All messages are verified and filtered before reaching your assistant.",
    installAction: "compose-service",
    installTarget: "channel-chat"
  },
  {
    id: "container-channel-discord",
    name: "Discord Channel",
    description: "Discord bot adapter supporting slash commands and webhook-based message forwarding. All messages are verified and filtered for security.",
    category: "channel",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/discord",
    tags: ["channel", "discord", "bot"],
    permissions: ["Connects to Discord API", "Messages are cryptographically verified", "Requires a Discord bot token"],
    securityNotes: "Requires a Discord bot token. All messages are verified and filtered before reaching your assistant.",
    installAction: "compose-service",
    installTarget: "channel-discord",
    docUrl: "https://discord.com/developers/docs"
  },
  {
    id: "container-channel-voice",
    name: "Voice Channel",
    description: "Voice/speech-to-text adapter. Accepts transcribed text and routes it securely to your assistant. WebSocket streaming endpoint planned.",
    category: "channel",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/voice",
    tags: ["channel", "voice", "stt"],
    permissions: ["Internal network only", "Messages are cryptographically verified"],
    securityNotes: "Accepts transcribed text only. No direct microphone access. All input is verified and rate-limited.",
    installAction: "compose-service",
    installTarget: "channel-voice"
  },
  {
    id: "container-channel-telegram",
    name: "Telegram Channel",
    description: "Telegram bot adapter. Receives webhook updates from Telegram's Bot API and forwards text messages securely to your assistant.",
    category: "channel",
    risk: "medium",
    author: "OpenPalm",
    version: "1.0.0",
    source: "channels/telegram",
    tags: ["channel", "telegram", "bot"],
    permissions: ["Connects to Telegram API", "Messages are cryptographically verified", "Requires a Telegram bot token"],
    securityNotes: "Requires a Telegram bot token. Webhook requests are verified. All messages are filtered before reaching your assistant.",
    installAction: "compose-service",
    installTarget: "channel-telegram",
    docUrl: "https://core.telegram.org/bots/api"
  },
  {
    id: "container-n8n",
    name: "n8n Workflow Automation",
    description: "Self-hosted workflow automation tool. Connect OpenPalm to hundreds of services via visual workflows. Runs as a separate service with API access.",
    category: "service",
    risk: "medium-high",
    author: "n8n.io",
    version: "latest",
    source: "docker.io/n8nio/n8n",
    tags: ["automation", "workflows", "integration"],
    permissions: ["Connects to external services", "Persistent storage", "May require additional credentials"],
    securityNotes: "High risk: n8n can make network requests and execute code in workflows. Restrict access to your local network. Review workflows before enabling external connections.",
    installAction: "compose-service",
    installTarget: "n8n"
  },
  {
    id: "container-ollama",
    name: "Ollama (Local LLM)",
    description: "Run local LLM models alongside OpenCode. Useful for offline inference, private data processing, or cost reduction on simple tasks.",
    category: "service",
    risk: "medium",
    author: "Ollama",
    version: "latest",
    source: "docker.io/ollama/ollama",
    tags: ["llm", "local", "inference"],
    permissions: ["GPU access (optional)", "Persistent model storage", "Internal network only"],
    securityNotes: "Runs on internal network only. No external API access by default. Model downloads require temporary outbound access. Large disk footprint.",
    installAction: "compose-service",
    installTarget: "ollama"
  },
  {
    id: "container-searxng",
    name: "SearXNG (Private Search)",
    description: "Privacy-respecting metasearch engine. Provides web search capabilities to the assistant without sending queries to commercial search APIs.",
    category: "service",
    risk: "medium",
    author: "SearXNG",
    version: "latest",
    source: "docker.io/searxng/searxng",
    tags: ["search", "privacy", "web"],
    permissions: ["Connects to search engines", "No persistent storage needed"],
    securityNotes: "Searches the web on behalf of your assistant. Restricted to internal network. Does not store search history by default.",
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
    item.tags?.some((t) => t.includes(q)) ||
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
  "https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/registry/index.json";

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
      item.tags?.some((t) => t.toLowerCase().includes(q)) ||
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
    case "lowest": return { label: "Lowest Risk", color: "#8e8e93", description: "Text-only behavioral directive. Cannot execute code or access tools." };
    case "low": return { label: "Low Risk", color: "#34c759", description: "Sends a predefined prompt. No code execution." };
    case "medium": return { label: "Medium Risk", color: "#ff9500", description: "Can control which tools the assistant has access to." };
    case "medium-high": return { label: "Medium-High Risk", color: "#ff6b35", description: "Can execute code, make network requests, and interact with services." };
    case "highest": return { label: "Highest Risk", color: "#ff3b30", description: "Can observe and modify all tool calls and assistant behavior." };
  }
}
