# Portal image

One private image runs either the Discord or Slack adapter according to
`PORTAL_ADAPTER`.

Both adapters are standard MCP clients of Guardian. They never join
`agent_net`, call Assistant directly, or receive unrelated credentials. Each
gets a generated keyring containing its fallback and explicitly mapped named
credentials, its platform token files, and one SQLite state volume. Exact
platform user IDs select a credential per request; Guardian remains the policy
authority.

Access is default-deny. At least one adapter allowlist must be configured, and
every configured allowlist must match. Blocked users always lose access.

Build locally:

```bash
docker build -f containers/portal/Dockerfile -t openpalm/portal:dev .
```

The old entrypoint, start script, workspace manifest, and image-side adapter
assembly are inactive legacy files pending deletion approval.
