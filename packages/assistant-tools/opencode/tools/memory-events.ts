import { tool } from "@opencode-ai/plugin";
import { memoryFetch, memoryResponseHasError } from "./lib.ts";

export default tool({
  description:
    "Poll a memory API event for async ingestion/export pipelines until completion.",
  args: {
    event_id: tool.schema.string().describe("Event identifier to poll"),
  },
  async execute(args) {
    let result = await memoryFetch(
      `/api/v1/events/${encodeURIComponent(args.event_id)}`,
    );
    if (memoryResponseHasError(result)) {
      result = await memoryFetch(
        `/api/v2/events/${encodeURIComponent(args.event_id)}`,
      );
    }
    return result;
  },
});
