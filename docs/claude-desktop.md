# Claude Desktop

Use the OpenPalm desktop extension for a Guardian running on the same computer.
It is the correct local integration: Claude's remote-connector form requires
`https://`, while a desktop extension runs locally and can reach a loopback
service. Anthropic documents the same distinction in
[When to use desktop and web connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors).

The extension is a transparent MCP bridge. It adds no OpenPalm service, tool,
policy, or permission. Guardian still authenticates the named credential,
filters the MCP catalog, screens input, owns sessions, and writes audit events.

## Install

Enable Guardian and create a dedicated credential. Start with `read` unless
Claude must modify the workspace or approve Assistant permissions:

```bash
openpalm addon enable gateway
openpalm credential add claude-desktop read
openpalm credential show claude-desktop --show-key
```

Download `openpalm-claude-desktop-<version>.mcpb` from the matching OpenPalm
release. In Claude Desktop:

1. Open **Settings → Extensions → Advanced settings**.
2. In **Extension Developer**, choose **Install Extension…**.
3. Select the `.mcpb` file.
4. Keep the default Guardian URL, `http://127.0.0.1:3830/mcp`, unless the local
   port was changed.
5. Paste the `claude-desktop` credential key when prompted.
6. Restart Claude Desktop if the tools do not appear.

These are Anthropic's documented steps for
[installing a custom desktop extension](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop#h_6df82aa934).
The key field is marked sensitive in the MCPB manifest, so Claude Desktop uses
the operating system's secure credential storage.

Open the **+ → Connectors** menu in a conversation to enable OpenPalm. The
credential policy determines the catalog Claude receives. A `read` credential
can run the guarded agent and inspect ordinary workspace files; a `full`
credential also receives session mutation and permission-approval operations.

## Limits and safety

- The extension accepts only `http://127.0.0.1/...`, `http://localhost/...`, or
  `http://[::1]/...` and requires the exact `/mcp` path. It cannot be pointed at
  a LAN or public host.
- The extension neither starts nor updates OpenPalm. Guardian must already be
  healthy.
- Credential rotation requires updating the extension setting.
- Removing the named credential immediately revokes its key.
- Privately distributed MCPB updates are installed manually.

Build the artifact from source with:

```bash
bun install
bun run --cwd packages/claude-desktop pack
```

The result is written to `packages/claude-desktop/artifacts/`. The build
bundles its runtime dependencies and validates the MCPB manifest before the
release workflow publishes it.

For access from Claude web/mobile or from another computer, use the
[public remote MCP deployment](remote-mcp.md), not this extension.
