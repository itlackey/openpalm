# OpenPalm Components Plan

This document is retained only as a historical placeholder.

It is no longer the authoritative v0.10.0 design because the refactor shifted the
architecture substantially:

- the user-facing term is now `addon`
- runtime assembly is based on `~/.openpalm/stack/addons/`
- the clean-break release no longer includes migration tooling
- Caddy integration and `.caddy` route snippets were dropped
- the old `data/components/` model is not part of the shipped layout

Do not use this file for implementation guidance.

Use these documents instead:

- `./README.md` — v0.10.0 roadmap summary
- `./plans/issue-301-unified-component-system.md` — current addon/addon-lifecycle plan for issue #301
- `./openpalm-unified-registry-plan.md` — addon registry details
- `./fs-mounts-refactor.md` — current filesystem and clean-break direction
- `./review-decisions.md` — final architectural decisions
