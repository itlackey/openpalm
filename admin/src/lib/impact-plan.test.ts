import { describe, expect, it } from "bun:test";
import { computeImpactFromChanges } from "./impact-plan.ts";

describe("impact plan", () => {
  it("maps change classes to reload/restart impacts", () => {
    const impact = computeImpactFromChanges({
      caddyChanged: true,
      gatewaySecretsChanged: true,
      channelConfigChanged: ["channel-discord"],
      opencodeChanged: true,
      openmemoryChanged: true,
    });

    expect(impact.reload).toContain("caddy");
    expect(impact.restart).toContain("gateway");
    expect(impact.restart).toContain("channel-discord");
    expect(impact.restart).toContain("opencode-core");
    expect(impact.restart).toContain("openmemory");
  });
});
