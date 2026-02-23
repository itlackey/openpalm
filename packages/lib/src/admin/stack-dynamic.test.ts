import { signPayload } from "../shared/crypto.ts";
import { describe, expect, it } from "bun:test";
import { parseStackSpec } from "./stack-spec.ts";
import { createGatewayFetch } from "../../../../gateway/src/server.ts";

describe("dynamic stack and gateway behavior", () => {
  it("accepts arbitrary channel names in stack spec", () => {
    const spec = parseStackSpec({
      version: 3,
      accessScope: "lan",
      channels: {
        "Community Slack / v1": {
          enabled: true,
          exposure: "public",
          image: "ghcr.io/example/slack-channel:latest",
          containerPort: 8199,
          sharedSecretEnv: "CHANNEL_COMMUNITY_SLACK_SECRET",
          rewritePath: "/slack/events",
          config: {
            CHANNEL_COMMUNITY_SLACK_SECRET: "${SLACK_SHARED_SECRET}",
            "x-custom-key.with-symbols": "value",
          },
        },
      },
      services: {
        "n8n worker @edge": {
          enabled: true,
          image: "n8nio/n8n:latest",
          containerPort: 5678,
          config: {
            "n8n.port": "5678",
          },
        },
      },
      automations: [],
    });

    expect(spec.channels["Community Slack / v1"].enabled).toBe(true);
    expect(spec.services["n8n worker @edge"].enabled).toBe(true);
  });

  it("allows gateway payload validation for arbitrary non-empty channels", async () => {
    const fetchFn = createGatewayFetch({
      channelSecrets: { "community-slack": "secret" },
      openCode: {
        async send() {
          return { response: '{"valid": true, "summary": "ok"}', metadata: {} };
        },
      } as never,
      audit: { write() {} } as never,
    });

    const payload = {
      userId: "u1",
      channel: "community-slack",
      text: "hello",
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
      metadata: {},
    };

    const raw = JSON.stringify(payload);
    const signature = signPayload("secret", raw);

    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": signature,
      },
      body: raw,
    });

    const resp = await fetchFn(req);
    expect(resp.status).toBe(200);
  });
});
