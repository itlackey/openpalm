# Gateway API Reference

## Public
### GET /health
Health status.

### POST /message
Body:
```json
{
  "userId": "user-1",
  "text": "remember my preference",
  "sessionId": "optional",
  "toolName": "memory_recall",
  "toolArgs": {},
  "approval": { "approved": true }
}
```

### POST /channel/inbound
Signed channel payload from adapters.
Headers:
- `x-channel-signature` (sha256 hmac)

Body:
```json
{
  "userId": "telegram:123",
  "channel": "telegram",
  "text": "hello",
  "metadata": {},
  "nonce": "uuid",
  "timestamp": 1730000000000
}
```

## Admin (API/CLI)
Headers:
- `x-admin-token`
- `x-admin-step-up` (required for apply/disable/config writes and change apply/rollback)

### Extension lifecycle
- `POST /admin/extensions/request`
- `GET /admin/extensions/list`
- `POST /admin/extensions/apply`
- `POST /admin/extensions/disable`

### Config
- `GET /admin/config`
- `POST /admin/config`

### Change manager
- `POST /admin/change/propose`
- `POST /admin/change/validate`
- `POST /admin/change/apply`
- `POST /admin/change/rollback`
