import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Get L1 overview summary (~2k tokens) of a Viking resource. Cheaper than reading full content — use this first to decide if the full resource is relevant before calling viking-read.",
  args: {
    uri: tool.schema.string().describe("Viking URI path to get an overview of"),
  },
  async execute(args) {
    if (!args.uri.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "URI must start with 'viking://'" });
    }
    const params = new URLSearchParams({ uri: args.uri });
    return vikingFetch(`/content/overview?${params.toString()}`);
  },
});
