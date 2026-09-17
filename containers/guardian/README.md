# Guardian image

Guardian is an optional authenticated MCP security gateway.

The image contains the Bun Guardian service and a pinned OpenCode runtime used
only by a loopback moderation server. Its entrypoint validates strong file
secrets, starts the moderator, and starts Guardian. It performs no installation
at boot.

Guardian exposes only:

- `GET /health`
- MCP Streamable HTTP at `/mcp`

It authenticates named credentials reusable by MCP, Discord, and Slack; rate-limits and
bounds requests; encrypts expiring session/message/job/interaction handles; screens every message;
and sends allowed messages to Assistant with the configured class policy.
`chat` is tool-disabled, `read` permits bounded filesystem inspection, and
`full` inherits Assistant permissions. Suspicious input is classified by the
separate moderator. Any failure, invalid result, `flag`, or `block` verdict
fails closed.

Guardian runs non-root with all capabilities dropped. It mounts managed and
operator moderator configuration, provider auth, and `/work` read-only; only
its append-only audit-log directory is read/write. Its direct MCP file reader
uses the read-only workspace mount to reject symlink escapes before returning
content.
