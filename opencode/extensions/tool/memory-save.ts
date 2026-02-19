import { z } from "zod";

export default {
  description: "Save content to OpenMemory for later recall",
  parameters: z.object({
    text: z.string().describe("The content to save to memory"),
    tags: z.array(z.string()).optional().describe("Optional tags for categorizing the memory"),
  }),
  async execute(params: { text: string; tags?: string[] }) {
    const baseUrl = Bun.env.OPENMEMORY_BASE_URL ?? "http://openmemory:8765";
    const res = await fetch(`${baseUrl}/api/memory/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        tags: params.tags,
      }),
    });
    if (!res.ok) {
      return { error: `OpenMemory save failed: ${res.status} ${res.statusText}` };
    }
    const data = await res.json();
    return { saved: true, id: data.id ?? data };
  },
};
