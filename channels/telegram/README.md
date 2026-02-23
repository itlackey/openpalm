# Telegram Channel

The `channel-telegram` adapter connects a Telegram bot to the OpenPalm assistant via webhooks. It validates the webhook secret, extracts text from message updates, and forwards them through the Gateway.

Non-text messages (photos, stickers, etc.) are silently skipped.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /telegram/webhook` | Telegram bot update (webhook) |

### POST /telegram/webhook

Accepts Telegram's bot update JSON format. Only `message.text` updates are processed.

Headers:
- `x-telegram-bot-api-secret-token` — required if `TELEGRAM_WEBHOOK_SECRET` is set

## Caddy ingress

- Route: `/channels/telegram*` → rewrites to `/telegram/webhook`
- Access: LAN by default (togglable to public via Admin API)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8182` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_TELEGRAM_SECRET` | (required) | HMAC shared secret for signing payloads |
| `TELEGRAM_WEBHOOK_SECRET` | (empty) | Telegram webhook verification secret |

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram. Copy the **Bot Token**.
2. Save the bot token as `TELEGRAM_BOT_TOKEN` in secrets (used to register the webhook URL with Telegram).
3. Set your webhook URL with Telegram: `https://api.telegram.org/bot<token>/setWebhook?url=<your-public-url>/channels/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>`
4. Verify: `https://api.telegram.org/bot<token>/getMe`

Manage credentials via `POST /admin/channels/config` with `service: "channel-telegram"`.

## Related

- [API Reference](../../dev/docs/api-reference.md#telegram-channel-telegram-8182) — Full endpoint and payload details
- [Gateway README](../../core/gateway/README.md) — How signed payloads are processed
