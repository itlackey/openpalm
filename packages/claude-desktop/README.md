# OpenPalm for Claude Desktop

This optional MCP Bundle connects Claude Desktop to an already-running local
OpenPalm agent through its protected access layer. It does not install, start,
or control the OpenPalm stack.

1. In OpenPalm Admin, open **Connections → Claude Desktop**.
2. Enable protected access and create a dedicated identity, preferably with
   **Read files** access.
3. Download and install the `.mcpb` offered by the guided connection panel.
4. Enter the displayed **Local OpenPalm address** and access key.

The bridge accepts only an HTTP loopback `/mcp` URL. Public deployments should
connect through Claude's remote-connector flow and OAuth instead. Full setup is
in [`docs/claude-desktop.md`](../../docs/claude-desktop.md).
