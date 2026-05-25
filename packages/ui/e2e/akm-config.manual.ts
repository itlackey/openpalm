/**
 * AKM Configuration — MANUAL smoke script (NOT an automated test).
 *
 * Renamed from `.pw.ts` to `.manual.ts`. Requires a live dev stack +
 * standalone UI listening on ADMIN_URL. See e2e/README.md.
 *
 * Tests the /admin/akm GET and PATCH routes end-to-end:
 * - Auth enforcement
 * - Config read (GET returns current state)
 * - Config write (PATCH updates fields and persists to OP_HOME/config/akm/config.json)
 * - LLM profile CRUD
 * - Features tree (improve / index / search)
 * - Reflect cooldowns
 * - Validation (bad inputs rejected)
 * - Merge safety (existing fields survive a partial PATCH)
 *
 * Run with:
 *   RUN_DOCKER_STACK_TESTS=1 OP_UI_LOGIN_PASSWORD=dev-admin-token bun run ui:test:e2e
 */

import { expect, test } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const ADMIN_URL = process.env.ADMIN_URL ?? "http://127.0.0.1:9100";
const OP_HOME = process.env.OP_HOME ?? resolve(REPO_ROOT, ".dev");
const AKM_CONFIG_PATH = resolve(OP_HOME, "config/akm/config.json");

// Phase 2: x-admin-token header fallback removed; auth flows via op_session cookie.
function adminHeaders(): Record<string, string> {
  const secret = process.env.OP_UI_LOGIN_PASSWORD ?? "";
  return {
    cookie: `op_session=${secret}`,
    "x-requested-by": "test",
    "x-request-id": crypto.randomUUID(),
    "content-type": "application/json",
  };
}

function readConfigFile(): Record<string, unknown> {
  if (!existsSync(AKM_CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(AKM_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
}

// ── Test suite ───────────────────────────────────────────────────────────────

test.describe("AKM Config API", () => {
  const SKIP = !process.env.RUN_DOCKER_STACK_TESTS;
  test.skip(!!SKIP, "Requires RUN_DOCKER_STACK_TESTS=1 and running admin process");

  // ── Auth ───────────────────────────────────────────────────────────────────

  test("GET /admin/akm requires auth", async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/akm`, {
      headers: { "x-request-id": crypto.randomUUID() },
    });
    expect(res.status()).toBe(401);
  });

  test("PATCH /admin/akm requires auth", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: { "x-request-id": crypto.randomUUID(), "content-type": "application/json" },
      data: { semanticSearchMode: "off" },
    });
    expect(res.status()).toBe(401);
  });

  // ── GET ─────────────────────────────────────────────────────────────────────

  test("GET /admin/akm returns config object", async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/akm`, { headers: adminHeaders() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("config");
    expect(typeof body.config).toBe("object");
  });

  test("GET /admin/akm config matches disk file", async ({ request }) => {
    const res = await request.get(`${ADMIN_URL}/admin/akm`, { headers: adminHeaders() });
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as { config: Record<string, unknown> };
    const onDisk = readConfigFile();
    // Key scalar fields should match
    if (onDisk.semanticSearchMode !== undefined) {
      expect(body.config.semanticSearchMode).toBe(onDisk.semanticSearchMode);
    }
    if (onDisk.archiveRetentionDays !== undefined) {
      expect(body.config.archiveRetentionDays).toBe(onDisk.archiveRetentionDays);
    }
  });

  // ── Behavior fields ─────────────────────────────────────────────────────────

  test("PATCH updates semanticSearchMode and persists to disk", async ({ request }) => {
    const before = readConfigFile().semanticSearchMode;
    const newMode = before === "off" ? "auto" : "off";

    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { semanticSearchMode: newMode },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json() as { ok: boolean; config: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.config.semanticSearchMode).toBe(newMode);

    const onDisk = readConfigFile();
    expect(onDisk.semanticSearchMode).toBe(newMode);

    // Restore
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { semanticSearchMode: before ?? "auto" },
    });
  });

  test("PATCH updates archiveRetentionDays and persists to disk", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { archiveRetentionDays: 45 },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    expect(onDisk.archiveRetentionDays).toBe(45);
  });

  test("PATCH updates output.format and output.detail", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { output: { format: "yaml", detail: "full" } },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const output = onDisk.output as Record<string, unknown>;
    expect(output.format).toBe("yaml");
    expect(output.detail).toBe("full");

    // Restore
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { output: { format: "json", detail: "brief" } },
    });
  });

  test("PATCH updates stashInheritance", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { stashInheritance: "replace" },
    });
    expect(res.ok()).toBeTruthy();
    expect((readConfigFile()).stashInheritance).toBe("replace");

    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { stashInheritance: "merge" },
    });
  });

  // ── Merge safety ────────────────────────────────────────────────────────────

  test("PATCH preserves unrelated fields when updating one field", async ({ request }) => {
    // Set a known value for embedding first
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { embedding: { endpoint: "https://api.openai.com/v1/embeddings", model: "text-embedding-3-small", dimension: 1536 } },
    });

    // Now PATCH only semanticSearchMode
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { semanticSearchMode: "auto" },
    });

    const onDisk = readConfigFile();
    // embedding should still be present
    expect(onDisk).toHaveProperty("embedding");
    const emb = onDisk.embedding as Record<string, unknown>;
    expect(emb.model).toBe("text-embedding-3-small");
    expect(emb.dimension).toBe(1536);
  });

  // ── LLM Profiles ───────────────────────────────────────────────────────────

  test("PATCH writes LLM profile to profiles.llm", async ({ request }) => {
    const profileName = "test-e2e-profile";
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        profiles: {
          llm: {
            [profileName]: {
              endpoint: "https://api.openai.com/v1/chat/completions",
              model: "gpt-4o-mini",
              temperature: 0.5,
            },
          },
          agent: {},
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const profiles = onDisk.profiles as Record<string, unknown>;
    const llmProfiles = profiles.llm as Record<string, unknown>;
    expect(llmProfiles).toHaveProperty(profileName);
    const profile = llmProfiles[profileName] as Record<string, unknown>;
    expect(profile.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(profile.model).toBe("gpt-4o-mini");
    expect(profile.temperature).toBe(0.5);

    // Cleanup
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { profiles: { llm: {}, agent: {} } },
    });
  });

  test("PATCH supports multiple LLM profiles simultaneously", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        profiles: {
          llm: {
            fast: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
            thorough: { endpoint: "https://api.openai.com/v1/chat/completions", model: "gpt-4o" },
          },
          agent: {},
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const llmProfiles = (onDisk.profiles as Record<string, unknown>).llm as Record<string, unknown>;
    expect(llmProfiles).toHaveProperty("fast");
    expect(llmProfiles).toHaveProperty("thorough");
    expect((llmProfiles.thorough as Record<string, unknown>).model).toBe("gpt-4o");
  });

  test("PATCH writes agent profile with platform", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        profiles: {
          llm: {},
          agent: {
            "test-agent": { platform: "opencode", bin: "opencode" },
          },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const agentProfiles = (onDisk.profiles as Record<string, unknown>).agent as Record<string, unknown>;
    expect(agentProfiles).toHaveProperty("test-agent");
    expect((agentProfiles["test-agent"] as Record<string, unknown>).platform).toBe("opencode");

    // Cleanup
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { profiles: { llm: {}, agent: {} } },
    });
  });

  // ── Features tree ───────────────────────────────────────────────────────────

  test("PATCH writes features.improve operation as boolean", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        features: {
          improve: { memory_consolidation: true, validation: false },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const featImprove = (onDisk.features as Record<string, unknown>)?.improve as Record<string, unknown>;
    expect(featImprove.memory_consolidation).toBe(true);
    expect(featImprove.validation).toBe(false);
  });

  test("PATCH writes features.improve operation as ProcessEntry with mode", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        features: {
          improve: {
            reflect: { enabled: true, mode: "llm", timeoutMs: 30000 },
          },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const reflect = ((onDisk.features as Record<string, unknown>)?.improve as Record<string, unknown>)?.reflect as Record<string, unknown>;
    expect(reflect.enabled).toBe(true);
    expect(reflect.mode).toBe("llm");
    expect(reflect.timeoutMs).toBe(30000);
  });

  test("PATCH writes all three features sections", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        features: {
          improve: { distill: true },
          index: { metadata_enhance: true },
          search: { curate_rerank: false },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const features = onDisk.features as Record<string, unknown>;
    expect((features.improve as Record<string, unknown>).distill).toBe(true);
    expect((features.index as Record<string, unknown>).metadata_enhance).toBe(true);
    expect((features.search as Record<string, unknown>).curate_rerank).toBe(false);
  });

  test("PATCH features merge preserves sibling operations", async ({ request }) => {
    // Set two operations
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { features: { improve: { reflect: true, distill: true } } },
    });

    // Update only one
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { features: { improve: { distill: false } } },
    });

    const onDisk = readConfigFile();
    const featImprove = (onDisk.features as Record<string, unknown>).improve as Record<string, unknown>;
    expect(featImprove.reflect).toBe(true);   // unchanged
    expect(featImprove.distill).toBe(false);  // updated
  });

  // ── Reflect cooldowns ───────────────────────────────────────────────────────

  test("PATCH writes reflectCooldownByType for specific asset types", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        improve: {
          reflectCooldownByType: { memory: 3, lesson: 14, knowledge: 45 },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const cooldown = (onDisk.improve as Record<string, unknown>)?.reflectCooldownByType as Record<string, number>;
    expect(cooldown.memory).toBe(3);
    expect(cooldown.lesson).toBe(14);
    expect(cooldown.knowledge).toBe(45);
  });

  test("PATCH utilityDecay values persist to disk", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        improve: {
          utilityDecay: { halfLifeDays: 20, feedbackStabilityBoost: 2.0 },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const decay = (onDisk.improve as Record<string, unknown>)?.utilityDecay as Record<string, number>;
    expect(decay.halfLifeDays).toBe(20);
    expect(decay.feedbackStabilityBoost).toBe(2.0);

    // Restore
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { improve: { utilityDecay: { halfLifeDays: 30, feedbackStabilityBoost: 1.5 } } },
    });
  });

  // ── Embedding ───────────────────────────────────────────────────────────────

  test("PATCH updates embedding connection and persists all fields", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        embedding: {
          endpoint: "http://localhost:11434/api/embeddings",
          model: "nomic-embed-text",
          provider: "ollama",
          dimension: 768,
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const emb = onDisk.embedding as Record<string, unknown>;
    expect(emb.endpoint).toBe("http://localhost:11434/api/embeddings");
    expect(emb.model).toBe("nomic-embed-text");
    expect(emb.provider).toBe("ollama");
    expect(emb.dimension).toBe(768);

    // Restore original
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        embedding: {
          endpoint: "https://api.openai.com/v1/embeddings",
          model: "text-embedding-3-small",
          provider: "openai",
          dimension: 1536,
        },
      },
    });
  });

  // ── Search ──────────────────────────────────────────────────────────────────

  test("PATCH updates search.minScore and graphBoost settings", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        search: {
          minScore: 0.25,
          graphBoost: {
            directBoostPerEntity: 0.3,
            maxHops: 2,
            confidenceMode: "multiply",
          },
        },
      },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const search = onDisk.search as Record<string, unknown>;
    expect(search.minScore).toBe(0.25);
    const gb = search.graphBoost as Record<string, unknown>;
    expect(gb.directBoostPerEntity).toBe(0.3);
    expect(gb.maxHops).toBe(2);
    expect(gb.confidenceMode).toBe("multiply");
  });

  // ── Feedback ────────────────────────────────────────────────────────────────

  test("PATCH updates feedback.requireReason", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { feedback: { requireReason: false } },
    });
    expect(res.ok()).toBeTruthy();
    expect((readConfigFile().feedback as Record<string, unknown>).requireReason).toBe(false);

    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { feedback: { requireReason: true } },
    });
  });

  test("PATCH updates feedback.allowedFailureModes", async ({ request }) => {
    const modes = ["incorrect", "outdated", "custom-mode"];
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { feedback: { allowedFailureModes: modes } },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const storedModes = (onDisk.feedback as Record<string, unknown>).allowedFailureModes;
    expect(storedModes).toEqual(modes);
  });

  // ── Defaults ────────────────────────────────────────────────────────────────

  test("PATCH updates defaults.improve.limit and preset", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { defaults: { improve: { limit: 50, preset: "thorough" } } },
    });
    expect(res.ok()).toBeTruthy();

    const onDisk = readConfigFile();
    const improve = (onDisk.defaults as Record<string, unknown>).improve as Record<string, unknown>;
    expect(improve.limit).toBe(50);
    expect(improve.preset).toBe("thorough");

    // Restore
    await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { defaults: { improve: { limit: 25, preset: "custom" } } },
    });
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  test("PATCH rejects invalid semanticSearchMode", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { semanticSearchMode: "invalid-mode" },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid output.format", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { output: { format: "xml" } },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid output.detail", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { output: { detail: "verbose" } },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects negative archiveRetentionDays", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { archiveRetentionDays: -1 },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid stashInheritance", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { stashInheritance: "override" },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid agent profile platform", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        profiles: { llm: {}, agent: { "bad-agent": { platform: "chatgpt" } } },
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid feature mode", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        features: { improve: { reflect: { enabled: true, mode: "http" } } },
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects negative cooldown values", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { improve: { reflectCooldownByType: { memory: -1 } } },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects invalid LLM profile temperature out of range", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: {
        profiles: {
          llm: { bad: { endpoint: "https://example.com", model: "gpt-4o", temperature: 5 } },
          agent: {},
        },
      },
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects non-integer search.graphBoost.maxHops", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { search: { graphBoost: { maxHops: 1.5 } } },
    });
    // maxHops must be a positive integer; fractional values rejected
    expect(res.status()).toBe(400);
  });

  test("PATCH rejects utilityDecay.halfLifeDays < 0.1", async ({ request }) => {
    const res = await request.patch(`${ADMIN_URL}/admin/akm`, {
      headers: adminHeaders(),
      data: { improve: { utilityDecay: { halfLifeDays: 0.05 } } },
    });
    expect(res.status()).toBe(400);
  });
});
