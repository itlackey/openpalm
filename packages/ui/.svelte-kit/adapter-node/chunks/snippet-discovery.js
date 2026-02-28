import { D as DEFAULT_SNIPPET_SOURCES } from "./snippet-types.js";
import { a as parseYamlDocument } from "./index.js";
const cache = /* @__PURE__ */ new Map();
const CACHE_TTL_MS = 15 * 60 * 1e3;
function getCached(sourceId) {
  const entry = cache.get(sourceId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(sourceId);
    return null;
  }
  return entry.snippets;
}
function setCache(sourceId, snippets) {
  cache.set(sourceId, { snippets, fetchedAt: Date.now() });
}
async function fetchIndexUrl(source) {
  if (!source.target) return [];
  const cached = getCached(source.id);
  if (cached) return cached;
  try {
    const response = await fetch(source.target, {
      headers: { Accept: "application/yaml, application/json, text/yaml, text/plain" },
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) return [];
    const text = await response.text();
    const entries = parseYamlDocument(text);
    if (!Array.isArray(entries)) return [];
    const resolved = [];
    for (const entry of entries) {
      if (isSnippetDef(entry)) {
        resolved.push(resolveSnippet(entry, source));
      }
    }
    setCache(source.id, resolved);
    return resolved;
  } catch {
    return [];
  }
}
const SNIPPET_FILENAMES = ["openpalm-snippet.yaml", "openpalm-snippet.yml"];
async function fetchGitHubTopic(source) {
  const cached = getCached(source.id);
  if (cached) return cached;
  const topic = source.target;
  if (!topic) return [];
  try {
    const searchUrl = `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=updated&per_page=50`;
    const searchResponse = await fetch(searchUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "OpenPalm-Snippet-Discovery"
      },
      signal: AbortSignal.timeout(15e3)
    });
    if (!searchResponse.ok) return [];
    const searchData = await searchResponse.json();
    if (!searchData.items?.length) return [];
    const snippets = [];
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
async function fetchRepoSnippet(fullName, branch, source) {
  for (const filename of SNIPPET_FILENAMES) {
    try {
      const url = `https://raw.githubusercontent.com/${fullName}/${branch}/${filename}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5e3)
      });
      if (!response.ok) continue;
      const text = await response.text();
      let parsed;
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
function resolveSnippet(def, source, sourceIdOverride) {
  return {
    ...def,
    trust: source.trust,
    sourceId: sourceIdOverride ?? source.id,
    sourceName: source.name
  };
}
const VALID_KINDS = /* @__PURE__ */ new Set(["channel", "service", "automation"]);
function isSnippetDef(value) {
  if (typeof value !== "object" || value === null) return false;
  const obj = value;
  if (typeof obj.kind !== "string" || !VALID_KINDS.has(obj.kind)) return false;
  if (typeof obj.name !== "string") return false;
  if (!Array.isArray(obj.env)) return false;
  return true;
}
async function discoverFromSource(source) {
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
async function discoverAllSnippets(sources = DEFAULT_SNIPPET_SOURCES) {
  const results = await Promise.allSettled(
    sources.filter((s) => s.enabled).map((s) => discoverFromSource(s))
  );
  const snippets = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      snippets.push(...result.value);
    }
  }
  const trustOrder = { official: 0, curated: 1, community: 2 };
  const seen = /* @__PURE__ */ new Map();
  for (const snippet of snippets) {
    const key = `${snippet.kind}:${snippet.name}`;
    const existing = seen.get(key);
    if (!existing || trustOrder[snippet.trust] < trustOrder[existing.trust]) {
      seen.set(key, snippet);
    }
  }
  return Array.from(seen.values());
}
export {
  discoverAllSnippets as d
};
