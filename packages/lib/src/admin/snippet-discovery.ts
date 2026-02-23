/**
 * Snippet discovery service.
 *
 * Discovers community snippets from multiple sources:
 * - Built-in snippets (shipped with the release)
 * - Curated index (fetched from the main repo via raw URL)
 * - GitHub topic discovery (repos tagged with openpalm-channel, etc.)
 *
 * Each discovered snippet is tagged with a trust tier so the UI can
 * show provenance indicators.
 */

import type {
  ResolvedSnippet,
  SnippetDef,
  SnippetKind,
  SnippetSource,
  SnippetTrust,
} from "../shared/snippet-types.ts";
import { SNIPPET_TOPICS, DEFAULT_SNIPPET_SOURCES } from "../shared/snippet-types.ts";
import { parseYamlDocument } from "../shared/yaml.ts";

// ── Cache ────────────────────────────────────────────────────────────

type CacheEntry = {
  snippets: ResolvedSnippet[];
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCached(sourceId: string): ResolvedSnippet[] | null {
  const entry = cache.get(sourceId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(sourceId);
    return null;
  }
  return entry.snippets;
}

function setCache(sourceId: string, snippets: ResolvedSnippet[]): void {
  cache.set(sourceId, { snippets, fetchedAt: Date.now() });
}

// ── Index URL fetching ───────────────────────────────────────────────

async function fetchIndexUrl(source: SnippetSource): Promise<ResolvedSnippet[]> {
  if (!source.target) return [];

  const cached = getCached(source.id);
  if (cached) return cached;

  try {
    const response = await fetch(source.target, {
      headers: { Accept: "application/yaml, application/json, text/yaml, text/plain" },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return [];

    const text = await response.text();
    // The index may be YAML or JSON — parseYamlDocument handles both.
    const entries = parseYamlDocument(text);
    if (!Array.isArray(entries)) return [];

    const resolved = entries.map((entry) => resolveSnippet(entry, source));
    setCache(source.id, resolved);
    return resolved;
  } catch {
    return [];
  }
}

// ── GitHub topic discovery ───────────────────────────────────────────

/** Expected file at repo root for snippet discovery. */
const SNIPPET_FILENAMES = ["openpalm-snippet.yaml", "openpalm-snippet.yml"];

async function fetchGitHubTopic(source: SnippetSource): Promise<ResolvedSnippet[]> {
  const cached = getCached(source.id);
  if (cached) return cached;

  const topic = source.target;
  if (!topic) return [];

  try {
    // Search for repos with the given topic
    const searchUrl = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=updated&per_page=50`;
    const searchResponse = await fetch(searchUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "OpenPalm-Snippet-Discovery",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!searchResponse.ok) return [];

    const searchData = (await searchResponse.json()) as {
      items?: Array<{ full_name: string; default_branch: string; topics?: string[] }>;
    };

    if (!searchData.items?.length) return [];

    const snippets: ResolvedSnippet[] = [];

    // Fetch snippet YAML from each discovered repo
    for (const repo of searchData.items.slice(0, 20)) {
      const snippet = await fetchRepoSnippet(repo.full_name, repo.default_branch, source);
      if (snippet) snippets.push(snippet);
    }

    setCache(source.id, snippets);
    return snippets;
  } catch {
    return [];
  }
}

async function fetchRepoSnippet(
  fullName: string,
  branch: string,
  source: SnippetSource,
): Promise<ResolvedSnippet | null> {
  for (const filename of SNIPPET_FILENAMES) {
    try {
      const url = `https://raw.githubusercontent.com/${fullName}/${branch}/${filename}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) continue;

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = parseYamlDocument(text);
      } catch {
        continue;
      }

      if (isSnippetDef(parsed)) {
        return resolveSnippet(parsed, source, `github:${fullName}`);
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveSnippet(
  def: SnippetDef,
  source: SnippetSource,
  sourceIdOverride?: string,
): ResolvedSnippet {
  return {
    ...def,
    trust: source.trust,
    sourceId: sourceIdOverride ?? source.id,
    sourceName: source.name,
  };
}

const VALID_KINDS = new Set(["channel", "service", "automation"]);

function isSnippetDef(value: unknown): value is SnippetDef {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.apiVersion !== "string") return false;
  if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) return false;
  if (typeof obj.metadata !== "object" || obj.metadata === null) return false;
  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.id !== "string" || typeof meta.name !== "string") return false;
  if (!Array.isArray(obj.env)) return false;
  return true;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Discover snippets from a single source.
 */
export async function discoverFromSource(source: SnippetSource): Promise<ResolvedSnippet[]> {
  if (!source.enabled) return [];

  switch (source.type) {
    case "index-url":
      return fetchIndexUrl(source);
    case "github-topic":
      return fetchGitHubTopic(source);
    default:
      return [];
  }
}

/**
 * Discover snippets from all configured sources.
 * Returns a flat array of resolved snippets with trust information.
 */
export async function discoverAllSnippets(
  sources: SnippetSource[] = DEFAULT_SNIPPET_SOURCES,
): Promise<ResolvedSnippet[]> {
  const results = await Promise.allSettled(
    sources.filter((s) => s.enabled).map((s) => discoverFromSource(s)),
  );

  const snippets: ResolvedSnippet[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      snippets.push(...result.value);
    }
  }

  // Deduplicate by metadata.id, preferring higher trust tiers
  const trustOrder: Record<SnippetTrust, number> = { official: 0, curated: 1, community: 2 };
  const seen = new Map<string, ResolvedSnippet>();

  for (const snippet of snippets) {
    const existing = seen.get(snippet.metadata.id);
    if (!existing || trustOrder[snippet.trust] < trustOrder[existing.trust]) {
      seen.set(snippet.metadata.id, snippet);
    }
  }

  return Array.from(seen.values());
}

/**
 * Discover snippets filtered by kind.
 */
export async function discoverSnippetsByKind(
  kind: SnippetKind,
  sources?: SnippetSource[],
): Promise<ResolvedSnippet[]> {
  const all = await discoverAllSnippets(sources);
  return all.filter((s) => s.kind === kind);
}

/**
 * Clear the discovery cache (e.g., when the user manually refreshes).
 */
export function clearDiscoveryCache(): void {
  cache.clear();
}

/**
 * Get the GitHub topic for a given snippet kind.
 */
export function getTopicForKind(kind: SnippetKind): string {
  return SNIPPET_TOPICS[kind];
}
