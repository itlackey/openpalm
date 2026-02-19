import { z } from "zod";

export default {
  description: "Search OpenMemory for stored facts and recalled memories",
  parameters: z.object({
    query: z.string().describe("The search query to find relevant memories"),
    limit: z.number().default(5).describe("Maximum number of results to return"),
    tags: z.array(z.string()).optional().describe("Optional tags to filter results"),
  }),
  async execute(params: { query: string; limit: number; tags?: string[] }) {
    const baseUrl = Bun.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765";
    const res = await fetch(`${baseUrl}/api/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: params.query,
        limit: params.limit,
        tags: params.tags,
      }),
    });
    if (!res.ok) {
      return { error: `OpenMemory query failed: ${res.status} ${res.statusText}` };
    }
    const data = await res.json();
    return { results: data.results ?? data };
  },
};
