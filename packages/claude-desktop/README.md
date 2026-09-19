# OpenPalm for Claude Desktop

This optional MCP Bundle connects Claude Desktop to an already-running local
OpenPalm Guardian. It does not install, start, or control the OpenPalm stack.

1. Enable the Guardian add-on.
2. Create a dedicated credential, preferably with `read` policy.
3. Install the generated `.mcpb` file in Claude Desktop.
4. Enter the loopback Guardian URL and credential key when prompted.

The bridge accepts only an HTTP loopback `/mcp` URL. Public deployments should
connect through Claude's remote-connector flow and OAuth instead. Full setup:
https://github.com/itlackey/openpalm/blob/main/docs/claude-desktop.md
