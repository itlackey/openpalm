# MCP Channel

The `channel-mcp` adapter exposes an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server using Streamable HTTP transport and forwards tool invocations to the OpenPalm gateway using the standard signed channel flow.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /mcp` | MCP JSON-RPC endpoint (Streamable HTTP) |

## MCP Methods

| Method | Description |
|---|---|
| `initialize` | Returns server capabilities and protocol version |
| `tools/list` | Lists available tools (`openpalm_chat`) |
| `tools/call` | Invokes a tool — extracts the message and forwards to the gateway |
| `notifications/initialized` | Acknowledged (no-op) |

## Tools

| Tool | Description |
|---|---|
| `openpalm_chat` | Send a message to the OpenPalm assistant. Accepts `message` (required) and `userId` (optional) arguments. |

## Behavior

- Accepts MCP JSON-RPC requests over HTTP POST.
- Authenticates via optional Bearer token.
- Normalizes `tools/call` invocations into standard channel messages and forwards to the gateway.
- Returns MCP-shaped JSON-RPC responses with assistant output in `content` blocks.
- Non-tool methods (`initialize`, `tools/list`) are handled locally without gateway interaction.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8187` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_MCP_SECRET` | (required) | HMAC signing key for gateway communication |
| `MCP_BEARER_TOKEN` | (empty) | Optional Bearer token for client authentication |

## Example

```bash
# Initialize
curl http://localhost:8187/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'

# List tools
curl http://localhost:8187/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl http://localhost:8187/mcp \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"openpalm_chat","arguments":{"message":"Hello!"}}}'
```

## Related

- [Gateway README](../../core/gateway/README.md) — channel verification, intake, and forwarding
- [MCP Specification](https://spec.modelcontextprotocol.io/)
