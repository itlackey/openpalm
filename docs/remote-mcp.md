# Public remote MCP deployment

This deployment is optional. OpenPalm does not add a proxy, tunnel, certificate
manager, or identity provider to the managed stack. Operators bring an HTTPS
reverse proxy and an OAuth/OIDC authorization server; Guardian remains the MCP
resource server and policy boundary.

Use this path when OpenPalm should be available as a Claude custom connector or
to another internet MCP client. Claude remote connectors originate from
Anthropic's cloud—even when configured in Claude Desktop—so the MCP URL must be
publicly reachable. See Anthropic's
[remote connector network requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp#h_5c0182e5d0).

## Required topology

```text
MCP client
  -> public HTTPS reverse proxy
  -> 127.0.0.1:3830 Guardian
  -> Assistant

MCP client <-> external OAuth authorization server
Guardian -> authorization server JWKS
```

Keep Guardian loopback-bound. Publish only the exact MCP and OAuth metadata
paths through the proxy. Do not expose Assistant's native API.

## Configure the authorization server

The external authorization server must:

- publish OAuth authorization-server or OIDC discovery metadata;
- issue JWT access tokens with a stable `sub`, the configured issuer, audience,
  and required scope;
- publish signing keys at an HTTPS JWKS URL;
- support an MCP-compatible client-registration path: Client ID Metadata
  Documents, Dynamic Client Registration, or a pre-registered client ID and
  secret; and
- support Authorization Code with PKCE for interactive clients.

For Claude, allow the current callback URL
`https://claude.ai/api/mcp/auth_callback`. Anthropic notes that the hostname may
move to `claude.com`, so allow the successor shown by Claude or its current
[custom connector documentation](https://support.anthropic.com/en/articles/11503834-building-custom-connectors-via-remote-mcp-servers).

OpenPalm deliberately does not store the OAuth client registration. If the
authorization server does not support dynamic/metadata registration, enter its
pre-registered client ID and secret in Claude's **Advanced settings** when
adding the connector.

## Configure OpenPalm

Create a named credential for each policy class you need, then map each OAuth
subject to one of them:

```bash
openpalm addon enable gateway
openpalm credential add claude-read read
openpalm credential add claude-full full

openpalm config oauth \
  --resource https://agent.example.com/mcp \
  --issuer https://identity.example.com/ \
  --jwks-url https://identity.example.com/.well-known/jwks.json \
  --audience https://agent.example.com/mcp \
  --scopes openpalm

openpalm credential map oauth \
  https://identity.example.com/ subject-for-alice claude-read
openpalm credential map oauth \
  https://identity.example.com/ subject-for-operator claude-full
```

`config oauth` recreates the stack by default because Guardian loads the
resource-server configuration at startup. Use `--no-apply` to stage changes.
Identity mappings are read on each request and do not require a restart.

Inspect or revoke mappings with:

```bash
openpalm credential mappings oauth
openpalm credential unmap oauth \
  https://identity.example.com/ subject-for-alice
openpalm config oauth --disable
```

An OAuth identity receives exactly the mapped credential's `chat`, `read`, or
`full` policy. Scopes prove that the token was issued for OpenPalm; they do not
grant an OpenPalm policy. Unknown issuers, subjects, audiences, algorithms, or
missing scopes fail closed.

## Reverse proxy

Example Caddy site:

```caddyfile
agent.example.com {
    @openpalm path /mcp /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp
    handle @openpalm {
        reverse_proxy 127.0.0.1:3830
    }
    handle {
        respond 404
    }
}
```

Example Nginx locations inside an HTTPS server block:

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:3830;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 130s;
}

location = /.well-known/oauth-protected-resource {
    proxy_pass http://127.0.0.1:3830;
}

location = /.well-known/oauth-protected-resource/mcp {
    proxy_pass http://127.0.0.1:3830;
}
```

Terminate TLS with a publicly trusted certificate. Preserve the
`Authorization`, `Mcp-Protocol-Version`, `Mcp-Session-Id`, `Last-Event-ID`, and
`Accept` headers; standard Caddy and Nginx proxy behavior does this unless an
operator override removes them. Disable response buffering on `/mcp` so
streamed responses are delivered promptly.

## Verify before adding a client

```bash
curl --fail http://127.0.0.1:3830/health
curl --fail https://agent.example.com/.well-known/oauth-protected-resource
curl --include --request POST https://agent.example.com/mcp
```

The metadata response must name the exact public resource and issuer. The
unauthenticated MCP request must return `401` with a `WWW-Authenticate` header
whose `resource_metadata` URL is public HTTPS. Use the MCP Inspector to complete
the OAuth flow and verify the policy-filtered tools before enabling a production
client.

For Claude Pro/Max, open **Customize → Connectors → Add custom connector** and
enter `https://agent.example.com/mcp`. Team/Enterprise owners add it under
organization connector settings. Claude supports tools, prompts, and resources
on remote MCP connectors, so this uses the complete Guardian MCP catalog rather
than a chat-only subset.

## Operational guidance

- Prefer OAuth for public ingress. Do not distribute a long-lived static
  OpenPalm bearer key through a cloud connector.
- Apply proxy request-rate limits in addition to Guardian's own pre-auth and
  per-principal limits.
- Restrict inbound source ranges when practical, but treat OAuth—not IP
  allowlisting—as the identity boundary.
- Watch `data/logs/guardian-audit.log` for authentication failures and unusual
  tool volume.
- Rotate authorization-server signing keys through JWKS and revoke access by
  removing the exact identity mapping or disabling the upstream user.
- Keep `full` rare. Use dedicated `read` credentials for ordinary connector
  users.
