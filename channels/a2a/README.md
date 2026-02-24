# A2A Channel

The `channel-a2a` adapter exposes an [A2A (Agent-to-Agent)](https://google.github.io/A2A/) JSON-RPC endpoint and forwards task messages to the OpenPalm gateway using the standard signed channel flow.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `GET /.well-known/agent.json` | A2A Agent Card — describes agent capabilities and skills |
| `POST /a2a` | A2A JSON-RPC endpoint |

## A2A Methods

| Method | Description |
|---|---|
| `tasks/send` | Send a task message — extracts text, forwards to gateway, returns completed task |

## Behavior

- Serves the Agent Card at `/.well-known/agent.json` per the A2A specification.
- Accepts A2A JSON-RPC requests over HTTP POST at `/a2a`.
- Authenticates via optional Bearer token.
- Normalizes `tasks/send` messages into standard channel messages and forwards to the gateway.
- Returns A2A-shaped JSON-RPC responses with task status and artifacts.
- Only lists public skills — no tool enumeration or internal traces are exposed.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8188` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_A2A_SECRET` | (required) | HMAC signing key for gateway communication |
| `A2A_BEARER_TOKEN` | (empty) | Optional Bearer token for client authentication |
| `A2A_PUBLIC_URL` | `http://localhost:8188` | Public URL advertised in the Agent Card |

## Example

```bash
# Fetch Agent Card
curl http://localhost:8188/.well-known/agent.json

# Send a task
curl http://localhost:8188/a2a \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tasks/send",
    "params": {
      "id": "task-001",
      "message": {
        "parts": [{"type": "text", "text": "Hello from another agent!"}]
      }
    }
  }'
```

## Related

- [Gateway README](../../core/gateway/README.md) — channel verification, intake, and forwarding
- [A2A Specification](https://google.github.io/A2A/)
