# Security Policy

## Reporting A Vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting feature for this repository. Do not open a public issue containing an
exploit, credential, or undisclosed weakness.

Include:

- affected component and version
- reproduction steps
- expected impact
- relevant logs with all credentials removed
- a suggested mitigation, if available

Maintainers aim to acknowledge a report within 48 hours and provide an initial
assessment within one week. Disclosure timing is coordinated with the reporter.

## Supported Versions

| Version | Status |
|---|---|
| Latest `0.13.x` prerelease/release | Active development |
| Earlier `0.x` versions | No routine backports |

## Security Boundaries

The authoritative security invariants are in
[`docs/technical/core-principles.md`](../docs/technical/core-principles.md).
Key boundaries include:

- The host CLI or admin-capable host UI is the only Docker orchestrator.
- The assistant has no Docker socket, admin credential, or default network path
  to the host admin process.
- Portal traffic reaches Assistant only through Guardian.
- Guardian authenticates principals with HTTP Basic credentials, persists
  ownership, rate-limits traffic, filters events, and validates content by
  default.
- Host listeners default to loopback. Broader exposure is explicit and
  service-specific.
- Provider `auth.json` is assistant-readable by design. Delegated UI, Guardian,
  API, portal, and bot credentials live under `private/secrets/` and are granted
  to containers as named files.
- Admin browser sessions use an HttpOnly, SameSite=Lax HMAC-signed cookie;
  host routes also require a server-side capability.

## In Scope

- Authentication, authorization, ownership, or capability bypasses
- Guardian principal or content-validation bypasses
- Secret exposure through files, mounts, logs, bundles, or API responses
- Assistant escape into host control-plane capabilities
- Container privilege escalation or unsafe default network publication
- Cross-site scripting or CSRF bypasses in authenticated UI actions
- Supply-chain or installer flaws in shipped release artifacts

## Out Of Scope

- Upstream dependency vulnerabilities with no OpenPalm-specific exploit
- Social engineering
- Issues requiring physical host access without crossing an OpenPalm boundary
- Resource exhaustion against an intentionally local service unless it crosses
  an authentication or isolation boundary
