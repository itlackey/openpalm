import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Browse Viking filesystem — list directory contents with L0 abstracts. Use this to explore what resources, memories, and skills are available at a given path.",
  args: {
    uri: tool.schema.string().describe("Viking URI path to browse, e.g. 'viking://resources'"),
  },
  async execute(args) {
    if (!args.uri.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "URI must start with 'viking://'" });
    }
    const params = new URLSearchParams({ uri: args.uri });
    return vikingFetch(`/fs/ls?${params.toString()}`);
  },
});
