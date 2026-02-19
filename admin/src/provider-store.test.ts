import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore } from "./provider-store.ts";

describe("ProviderStore", () => {
  it("returns empty state on first boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const state = store.getState();
      expect(state.providers).toEqual([]);
      expect(state.assignments).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds a provider and returns it with an id", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const provider = store.addProvider({ name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "sk-test" });
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBe("OpenAI");
      expect(provider.url).toBe("https://api.openai.com/v1");
      expect(provider.apiKey).toBe("sk-test");
      expect(provider.createdAt).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists providers after adding multiple", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      store.addProvider({ name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "sk-1" });
      store.addProvider({ name: "Ollama", url: "http://localhost:11434/v1", apiKey: "" });
      expect(store.listProviders().length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates a provider's fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const p = store.addProvider({ name: "Test", url: "http://test", apiKey: "key" });
      const updated = store.updateProvider(p.id, { name: "Updated", url: "http://updated" });
      expect(updated?.name).toBe("Updated");
      expect(updated?.url).toBe("http://updated");
      expect(updated?.apiKey).toBe("key"); // unchanged
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when updating a non-existent provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      expect(store.updateProvider("nonexistent", { name: "x" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes a provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const p = store.addProvider({ name: "ToRemove", url: "", apiKey: "" });
      expect(store.removeProvider(p.id)).toBe(true);
      expect(store.listProviders().length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when removing a non-existent provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      expect(store.removeProvider("nonexistent")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assigns a model to a role", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const p = store.addProvider({ name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "sk-test" });
      store.assignModel("small", p.id, "gpt-4o-mini");
      const assignment = store.getAssignment("small");
      expect(assignment?.providerId).toBe(p.id);
      expect(assignment?.modelId).toBe("gpt-4o-mini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when assigning to a non-existent provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      expect(() => store.assignModel("small", "nonexistent", "model")).toThrow("provider_not_found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes assignments when provider is deleted", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      const p = store.addProvider({ name: "OpenAI", url: "https://api.openai.com/v1", apiKey: "sk-test" });
      store.assignModel("small", p.id, "gpt-4o-mini");
      store.removeProvider(p.id);
      expect(store.getAssignment("small")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to defaults when providers.json is corrupted", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      writeFileSync(join(dir, "providers.json"), "{broken", "utf8");
      const state = store.getState();
      expect(state.providers).toEqual([]);
      expect(state.assignments).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes malformed provider entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "openpalm-provider-"));
    try {
      const store = new ProviderStore(dir);
      writeFileSync(join(dir, "providers.json"), JSON.stringify({
        providers: [
          { id: "valid", name: "Good", url: "http://test", apiKey: "key", createdAt: "2024-01-01" },
          { id: "", name: "", url: "", apiKey: "" },
          null,
          "not-an-object"
        ],
        assignments: {
          small: { providerId: "valid", modelId: "model-1" },
          bad: "not-an-object"
        }
      }, null, 2), "utf8");
      const state = store.getState();
      expect(state.providers.length).toBe(1);
      expect(state.providers[0].name).toBe("Good");
      expect(state.assignments.small?.modelId).toBe("model-1");
      expect(state.assignments.bad).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
