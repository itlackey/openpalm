import { tool } from "@opencode-ai/plugin";
import { vikingFetch } from "./viking-lib.ts";

export default tool({
  description:
    "Text pattern search within a Viking URI scope. Use for exact text matching when you know the specific string or pattern to find, rather than semantic similarity.",
  args: {
    uri: tool.schema.string().describe("Viking URI scope to search within, e.g. 'viking://resources'"),
    pattern: tool.schema.string().describe("Text pattern to search for"),
    case_insensitive: tool.schema
      .string()
      .optional()
      .describe("Set to 'true' for case-insensitive matching (default: false)"),
  },
  async execute(args) {
    if (!args.uri.startsWith("viking://")) {
      return JSON.stringify({ error: true, message: "URI must start with 'viking://'" });
    }
    const body: Record<string, unknown> = { uri: args.uri, pattern: args.pattern };
    if (args.case_insensitive?.toLowerCase() === "true") body.case_insensitive = true;
    return vikingFetch("/search/grep", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
});
