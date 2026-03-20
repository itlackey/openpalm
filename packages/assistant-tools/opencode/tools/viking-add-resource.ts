import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Add a resource to Viking for indexing. Supports URLs and text content. The resource will be embedded and made searchable. Use this to ingest documents, web pages, or knowledge into Viking.",
  args: {
    content: tool.schema.string().describe("The text content or URL to ingest into Viking"),
    destination: tool.schema
      .string()
      .describe("Target Viking URI like 'viking://resources/docs'"),
    reason: tool.schema
      .string()
      .optional()
      .describe("Description of why this resource is being added"),
  },
  async execute(args) {
    if (!args.destination.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "destination must start with 'viking://'" });
    }
    const body: Record<string, unknown> = {
      content: args.content,
      destination: args.destination,
      wait: true,
    };
    if (args.reason) body.reason = args.reason;
    return vikingFetch("/resources", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
});
