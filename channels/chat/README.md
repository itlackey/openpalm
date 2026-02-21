# Chat Channel

The `channel-chat` adapter provides a simple HTTP API for web chat integration. It accepts text messages, signs them with HMAC, and forwards them through the Gateway to the assistant.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /chat` | Send a message to the assistant |

### POST /chat

```json
{ "userId": "...", "text": "...", "metadata": {} }
```

Headers:
- `x-chat-token` — required if `CHAT_INBOUND_TOKEN` is set

Returns the assistant's response with the same HTTP status the gateway returns.

## Caddy ingress

- Route: `/channels/chat*` → rewrites to `/chat`
- Access: LAN by default (togglable to public via Admin API)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8181` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_CHAT_SECRET` | (required) | HMAC shared secret for signing payloads |
| `CHAT_INBOUND_TOKEN` | (empty) | Optional bearer token for inbound request auth |

## Setup

No external platform account needed — this channel accepts direct HTTP `POST` requests. Set a `CHAT_INBOUND_TOKEN` to protect the endpoint if it is exposed publicly.

Manage credentials via `POST /admin/channels/config` with `service: "channel-chat"`.

## Related

- [API Reference](../../dev/docs/api-reference.md#chat-channel-chat-8181) — Full endpoint and payload details
- [Gateway README](../../gateway/README.md) — How signed payloads are processed
