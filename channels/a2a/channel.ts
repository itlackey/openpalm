import type { ChannelAdapter, InboundResult } from "@openpalm/lib/shared/channel.ts";

const BEARER_TOKEN = Bun.env.A2A_BEARER_TOKEN ?? "";

/**
 * A2A Agent Card — describes this agent's public capabilities.
 * Served at `GET /.well-known/agent.json` per the A2A specification.
 */
const AGENT_CARD = {
  name: "OpenPalm",
  description: "OpenPalm AI assistant accessible via the Agent-to-Agent protocol.",
  url: Bun.env.A2A_PUBLIC_URL ?? "http://localhost:8188",
  version: "0.3.4",
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  skills: [
    {
      id: "chat",
      name: "Chat",
      description: "Send a message and receive a response from the assistant.",
    },
  ],
};

function verifyBearer(req: Request): boolean {
  if (!BEARER_TOKEN) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${BEARER_TOKEN}`;
}

type JsonRpcRequest = {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

function jsonrpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function createA2aChannel(): ChannelAdapter {
  return {
    name: "a2a",
    routes: [
      {
        method: "GET",
        path: "/.well-known/agent.json",
        handler: async (_req: Request): Promise<InboundResult> => {
          return { ok: false, status: 200, body: AGENT_CARD };
        },
      },
      {
        method: "POST",
        path: "/a2a",
        handler: async (req: Request): Promise<InboundResult> => {
          if (!verifyBearer(req)) {
            return { ok: false, status: 401, body: { error: "unauthorized" } };
          }

          let rpc: JsonRpcRequest;
          try {
            rpc = (await req.json()) as JsonRpcRequest;
          } catch {
            return {
              ok: false,
              status: 200,
              body: jsonrpcError(null, -32700, "Parse error"),
            };
          }

          if (rpc.jsonrpc !== "2.0" || !rpc.method) {
            return {
              ok: false,
              status: 200,
              body: jsonrpcError(rpc.id, -32600, "Invalid Request"),
            };
          }

          if (rpc.method === "tasks/send") {
            const params = rpc.params ?? {};
            const message = params.message as Record<string, unknown> | undefined;
            const parts = (message?.parts ?? []) as Array<Record<string, unknown>>;
            const textPart = parts.find((p) => p.type === "text");
            const text = typeof textPart?.text === "string" ? textPart.text.trim() : "";

            if (!text) {
              return {
                ok: false,
                status: 200,
                body: jsonrpcError(rpc.id, -32602, "message with text part is required"),
              };
            }

            const taskId = typeof params.id === "string" && params.id.trim()
              ? params.id
              : crypto.randomUUID();

            const userId = typeof (message?.metadata as Record<string, unknown> | undefined)?.userId === "string"
              ? ((message?.metadata as Record<string, unknown>).userId as string)
              : "a2a-user";

            return {
              ok: true,
              payload: {
                userId,
                channel: "a2a",
                text,
                metadata: { taskId, rpcId: rpc.id, a2aMethod: "tasks/send" },
              },
            };
          }

          return {
            ok: false,
            status: 200,
            body: jsonrpcError(rpc.id, -32601, `Method not found: ${rpc.method}`),
          };
        },
      },
    ],

    health: () => ({ ok: true, service: "channel-a2a" }),
  };
}
