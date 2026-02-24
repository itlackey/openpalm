import type { ChannelAdapter, InboundResult } from "@openpalm/lib/shared/channel.ts";

const BEARER_TOKEN = Bun.env.MCP_BEARER_TOKEN ?? "";

/**
 * MCP tool definitions exposed by this channel.
 * Clients discover these via `tools/list` and invoke them via `tools/call`.
 */
const TOOLS = [
  {
    name: "openpalm_chat",
    description: "Send a message to the OpenPalm assistant and receive a response.",
    inputSchema: {
      type: "object" as const,
      properties: {
        message: { type: "string", description: "The message to send to the assistant." },
        userId: { type: "string", description: "Optional user identifier." },
      },
      required: ["message"],
    },
  },
];

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

function jsonrpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function createMcpChannel(): ChannelAdapter {
  return {
    name: "mcp",
    routes: [
      {
        method: "POST",
        path: "/mcp",
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

          if (rpc.method === "initialize") {
            return {
              ok: false,
              status: 200,
              body: jsonrpcResult(rpc.id, {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "openpalm-mcp", version: "0.3.4" },
              }),
            };
          }

          if (rpc.method === "tools/list") {
            return {
              ok: false,
              status: 200,
              body: jsonrpcResult(rpc.id, { tools: TOOLS }),
            };
          }

          if (rpc.method === "tools/call") {
            const params = rpc.params ?? {};
            const toolName = params.name as string | undefined;
            const args = (params.arguments ?? {}) as Record<string, unknown>;

            if (toolName !== "openpalm_chat") {
              return {
                ok: false,
                status: 200,
                body: jsonrpcError(rpc.id, -32602, `Unknown tool: ${toolName}`),
              };
            }

            const message = typeof args.message === "string" ? args.message.trim() : "";
            if (!message) {
              return {
                ok: false,
                status: 200,
                body: jsonrpcError(rpc.id, -32602, "message argument is required"),
              };
            }

            const userId = typeof args.userId === "string" && args.userId.trim()
              ? args.userId
              : "mcp-user";

            return {
              ok: true,
              payload: {
                userId,
                channel: "mcp",
                text: message,
                metadata: { tool: "openpalm_chat", rpcId: rpc.id },
              },
            };
          }

          if (rpc.method === "notifications/initialized") {
            return { ok: false, status: 200, body: jsonrpcResult(rpc.id, {}) };
          }

          return {
            ok: false,
            status: 200,
            body: jsonrpcError(rpc.id, -32601, `Method not found: ${rpc.method}`),
          };
        },
      },
    ],

    health: () => ({ ok: true, service: "channel-mcp" }),
  };
}
