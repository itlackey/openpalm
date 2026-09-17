# Portal image

One private image runs either the Discord or Slack adapter according to
`PORTAL_ADAPTER`.

Both adapters are standard MCP clients of Guardian. They never join
`agent_net`, call Assistant directly, or receive credentials not selected for it. Each
gets one selected named Guardian credential, its platform token files, and one
SQLite state volume.

Access is default-deny. At least one adapter allowlist must be configured, and
every configured allowlist must match. Blocked users always lose access.

Build locally:

```bash
docker build -f containers/portal/Dockerfile -t openpalm/portal:dev .
```

The old entrypoint, start script, workspace manifest, and image-side adapter
assembly are inactive legacy files pending deletion approval.
