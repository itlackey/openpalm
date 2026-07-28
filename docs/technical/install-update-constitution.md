# Install And Update Contract

This former constitution was retired because it duplicated the filesystem and
lifecycle rules and had drifted from the implemented ownership model.

Current normative rules live in:

- [`core-principles.md`](core-principles.md) for architecture, security, and the
  filesystem contract
- [`code-quality-principles.md`](code-quality-principles.md) for lifecycle and
  engineering invariants
- [`artifact-delivery-pattern.md`](artifact-delivery-pattern.md) for UI,
  skeleton, and image delivery

Install and update code lives in `packages/lib/`; CLI and UI callers must not
implement independent lifecycle behavior.
