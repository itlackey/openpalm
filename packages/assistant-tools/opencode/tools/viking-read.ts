import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Read full content (L2) of a Viking resource. Returns the complete text of the resource at the given URI. Use viking-overview for a cheaper summary instead when full content isn't needed.",
  args: {
    uri: tool.schema.string().describe("Viking URI path to the resource to read"),
  },
  async execute(args) {
    if (!args.uri.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "URI must start with 'viking://'" });
    }
    const params = new URLSearchParams({ uri: args.uri });
    return vikingFetch(`/content/read?${params.toString()}`);
  },
});
