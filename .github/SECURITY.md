# Security policy

## Reporting a vulnerability

Contact the maintainers privately through the primary Gitea repository. If a
private channel is not visible, open a minimal issue asking for one without
including exploit details, credentials, private data, or an undisclosed
weakness.

Include the affected component and version, reproduction steps, expected
impact, sanitized logs, and a suggested mitigation when available. Maintainers
aim to acknowledge reports within 48 hours and provide an initial assessment
within one week.

## Supported version

OpenPalm 0.14 is the supported product line. Earlier versions describe a
different stack and do not receive routine backports.

## Security boundaries

The normative contract is
[`docs/technical/core-principles.md`](../docs/technical/core-principles.md).
Important boundaries include:

- The host CLI and optional local Admin utility are the only Docker
  orchestrators.
- Assistant receives no Docker socket, Guardian key, Portal key, OAuth token,
  or host-control credential.
- Native OpenCode access is authenticated and loopback-bound by default.
- Portal and remote traffic reaches Assistant only through authenticated,
  policy-scoped Guardian MCP.
- Guardian fails closed on authentication, ownership, handle validation,
  moderation, origin, and filesystem-containment errors.
- Portal allowlists are default-deny and each adapter receives only its
  delegated credential subset.
- Provider authentication is Assistant-readable by design. Other runtime
  credentials are private files with explicit consumers.
- Managed services run without root, added Linux capabilities, or a container
  runtime mount.

## In scope

- Authentication, authorization, ownership, or policy bypasses
- Prompt-screening or moderation bypasses at the Guardian boundary
- Secret exposure through files, mounts, logs, bundles, or protocol responses
- Assistant or Portal access to host/control-plane capabilities
- Workspace traversal or symlink escape through Guardian
- Unsafe network publication, container privilege, installer, or release
  supply-chain flaws

## Out of scope

- Upstream vulnerabilities without an OpenPalm-specific exploit
- Social engineering
- Issues requiring physical host access without crossing an OpenPalm boundary
- Resource exhaustion of an intentionally local service unless it bypasses an
  authentication, rate, or isolation boundary
