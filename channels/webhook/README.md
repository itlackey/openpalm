# Webhook Channel

The `channel-webhook` adapter provides a generic webhook endpoint for integrating any external service that can send HTTP POST requests. It accepts text payloads, signs them with HMAC, and forwards them through the Gateway.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /webhook` | Send a message via webhook |

### POST /webhook

```json
{ "userId": "...", "text": "...", "metadata": {} }
```

Headers:
- `x-webhook-token` — required if `WEBHOOK_INBOUND_TOKEN` is set

Returns the assistant's response with the same HTTP status the gateway returns.

## Caddy ingress

This channel is not included in the default Caddy routing. To expose it, add a route to the Caddyfile or enable it via the Admin API.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8185` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_WEBHOOK_SECRET` | (required) | HMAC shared secret for signing payloads |
| `WEBHOOK_INBOUND_TOKEN` | (empty) | Optional bearer token for inbound request auth |

## Setup

No external platform account is needed. Configure any HTTP-capable service to `POST` to `/webhook` with a JSON body containing at least a `text` field. Set `WEBHOOK_INBOUND_TOKEN` to restrict access to known callers.

Manage credentials via `POST /admin/channels/config` with `service: "channel-webhook"`.

## Related

- [API Reference](../../dev/docs/api-reference.md) — Gateway and admin API details
- [Gateway README](../../core/gateway/README.md) — How signed payloads are processed
