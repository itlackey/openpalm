import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryRecord } from "./types.ts";
import { containsSecret } from "./policy.ts";

export class MemoryStore {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) writeFileSync(filePath, "[]", "utf8");
  }

  private listAll(): MemoryRecord[] {
    return JSON.parse(readFileSync(this.filePath, "utf8")) as MemoryRecord[];
  }

  private saveAll(items: MemoryRecord[]) {
    writeFileSync(this.filePath, JSON.stringify(items, null, 2), "utf8");
  }

  remember(input: { userId: string; content: string; tags?: string[]; source?: string; confidence?: number }) {
    if (containsSecret(input.content)) {
      throw new Error("Memory policy blocked content that appears to contain secrets.");
    }
    const items = this.listAll();
    const record: MemoryRecord = {
      id: randomUUID(),
      userId: input.userId,
      content: input.content,
      tags: input.tags ?? [],
      source: input.source ?? "user",
      confidence: input.confidence ?? 0.8,
      timestamp: new Date().toISOString()
    };
    items.push(record);
    this.saveAll(items);
    return record;
  }

  recall(input: { userId: string; query: string; topK?: number; tags?: string[] }) {
    const q = input.query.toLowerCase();
    const tags = new Set((input.tags ?? []).map((t) => t.toLowerCase()));
    return this.listAll()
      .filter((m) => m.userId === input.userId)
      .map((m) => {
        let score = 0;
        if (m.content.toLowerCase().includes(q)) score += 1;
        if (m.tags.some((t) => tags.has(t.toLowerCase()))) score += 0.5;
        return { ...m, _score: score };
      })
      .filter((m) => m._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, input.topK ?? 5)
      .map(({ _score, ...m }) => m);
  }
}
