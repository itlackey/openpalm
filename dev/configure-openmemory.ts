#!/usr/bin/env bun
// dev/configure-openmemory.ts
// Automatically configures openmemory with Ollama (or other) models after the stack starts.
// Called by dev:up / dev:build / dev:fresh when OPENAI_BASE_URL in the openmemory state env
// points to an Ollama-compatible endpoint (contains "11434" or "ollama").
//
// Override model choices via the openmemory state env:
//   OPENMEMORY_LLM_MODEL=qwen3:4b
//   OPENMEMORY_EMBEDDER_MODEL=nomic-embed-text:latest

import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const OPENMEMORY_ENV_PATH = join(REPO_ROOT, ".dev/state/openmemory/.env");
const OPENMEMORY_URL = Bun.env.OPENMEMORY_URL ?? "http://localhost:8765";
const MAX_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

function parseEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => {
          const idx = l.indexOf("=");
          return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
        })
    );
  } catch {
    return {};
  }
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  process.stdout.write("[configure-openmemory] Waiting for openmemory");
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${OPENMEMORY_URL}/docs`);
      if (res.ok) {
        process.stdout.write(" ready\n");
        return;
      }
    } catch {
      // not up yet
    }
    process.stdout.write(".");
    await Bun.sleep(POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for openmemory to become healthy");
}

async function configure(env: Record<string, string>): Promise<void> {
  const baseUrl = env.OPENAI_BASE_URL ?? "";
  const isOllama = baseUrl.includes("11434") || baseUrl.toLowerCase().includes("ollama");

  if (!isOllama) {
    console.log("[configure-openmemory] OPENAI_BASE_URL is not an Ollama endpoint — skipping auto-configuration.");
    return;
  }

  // mem0 wants the base Ollama URL without /v1
  const ollamaBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
  const llmModel = env.OPENMEMORY_LLM_MODEL ?? "qwen3:4b";
  const embedderModel = env.OPENMEMORY_EMBEDDER_MODEL ?? "nomic-embed-text:latest";

  console.log(`[configure-openmemory] Configuring Ollama provider (${ollamaBaseUrl})`);
  console.log(`  LLM:      ${llmModel}`);
  console.log(`  Embedder: ${embedderModel}`);

  const headers = { "Content-Type": "application/json" };

  const llmRes = await fetch(`${OPENMEMORY_URL}/api/v1/config/mem0/llm`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      provider: "ollama",
      config: {
        model: llmModel,
        temperature: 0.1,
        max_tokens: 2000,
        ollama_base_url: ollamaBaseUrl,
      },
    }),
  });
  if (!llmRes.ok) {
    throw new Error(`Failed to configure LLM: ${await llmRes.text()}`);
  }
  console.log("[configure-openmemory] LLM configured ✓");

  const embedRes = await fetch(`${OPENMEMORY_URL}/api/v1/config/mem0/embedder`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      provider: "ollama",
      config: {
        model: embedderModel,
        ollama_base_url: ollamaBaseUrl,
      },
    }),
  });
  if (!embedRes.ok) {
    throw new Error(`Failed to configure embedder: ${await embedRes.text()}`);
  }
  console.log("[configure-openmemory] Embedder configured ✓");
}

const env = parseEnvFile(OPENMEMORY_ENV_PATH);
await waitForHealth();
await configure(env);
