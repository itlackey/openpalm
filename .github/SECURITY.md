# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenPalm, **please report it privately** rather than opening a public issue.

**Email:** Send details to the maintainers via GitHub's private vulnerability reporting feature on this repository, or reach out directly at the contact listed on the [@itlackey](https://github.com/itlackey) GitHub profile.

**What to include:**

- Description of the vulnerability
- Steps to reproduce
- Affected component(s) (admin, guardian, assistant, memory, channels, installer)
- Potential impact
- Suggested fix (if you have one)

**What to expect:**

- Acknowledgment within 48 hours
- An initial assessment within 1 week
- A fix or mitigation plan before any public disclosure

We follow coordinated disclosure — we'll work with you on timing before any details are made public.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.9.x (current RC) | ✅ Active development |
| < 0.9.0 | ❌ No backports |

Once v1.0.0 ships, this table will be updated with a formal support window.

## Security Architecture

OpenPalm uses defense-in-depth with multiple independent layers. For the full breakdown, see [docs/core-principles.md](../docs/technical/authoritative/core-principles.md) and the "How It Works" section of the [README](../README.md).

Key boundaries:

- **Network isolation** — Caddy reverse proxy restricts admin access to LAN by default; all inter-service traffic stays on private Docker networks.
- **Signed messages** — Every channel message is HMAC-SHA256 signed and verified by the guardian before reaching the assistant.
- **Rate limiting** — Per-user (120 req/min) and per-channel (200 req/min) throttling with replay detection.
- **Assistant isolation** — The assistant container has no Docker socket access. All stack operations go through the authenticated admin API.
- **Docker socket proxy** — Only the admin container communicates with Docker, and only through a filtered socket proxy (Tecnativa) — never a direct socket mount.
- **Secret protection** — Secrets are never stored in memory. The admin token is required for all non-health API endpoints after setup completes.

## Scope

The following are **in scope** for security reports:

- Authentication or authorization bypasses in the admin API
- HMAC signature verification flaws in the guardian
- Secret leakage (API keys, admin tokens) through logs, memory, or API responses
- Container escape or privilege escalation
- Prompt injection that bypasses the assistant's security boundaries
- Cross-site scripting (XSS) in the admin UI
- Vulnerabilities in the install scripts (`setup.sh`, `setup.ps1`)

The following are **out of scope:**

- Vulnerabilities in upstream dependencies (report these to the upstream project)
- Denial of service against a locally-hosted instance (the threat model assumes a trusted LAN)
- Social engineering attacks
- Issues requiring physical access to the host machine
