# OpenPalm: Unified Component Registry

**Status:** Proposal
**Depends on:** Component system (see [openpalm-components-plan.md](openpalm-components-plan.md))
**Scope:** Replace the curated gallery, community registry, and npm search with a single component registry. The registry contains component directories — each with a `compose.yml` and `.env.schema`. That's all it handles. Plugins, agents, and skills are managed by OpenCode directly and are out of scope for the registry.

> **Note:** This plan has been incorporated into the [Components Plan](openpalm-components-plan.md) and serves as additional detail on the registry aspect — specifically the discovery, install/uninstall flow, admin API, and admin UI for browsing and managing the component catalog. The components plan is the authoritative source for the instance lifecycle and compose overlay mechanics.
>
> **Filesystem context:** This plan uses the `~/.openpalm/` single-root layout defined in [fs-mounts-refactor.md](fs-mounts-refactor.md). All `~/.openpalm/` paths below follow that layout. The old `${OP_DATA}`, `${OP_STATE}`, `${OP_CONFIG}`, `CONFIG_HOME`, `DATA_HOME`, and `STATE_HOME` references from the three-tier XDG model are replaced by subdirectories under `~/.openpalm/`.

---

## Problem

The current extension system has three discovery layers (curated gallery, community registry, npm search), each with its own API endpoints, data model, UI section, and install path. With the component system, we already have a clean model: a component is a `compose.yml` + `.env.schema`. The registry should match that model exactly — nothing more.

### Scope Boundaries

**Automations are explicitly out of scope.** Automations remain a separate registry mechanism (`registry/automations/`). The unified registry covers components only. Components are containers managed by Docker Compose; automations are scheduled tasks with fundamentally different lifecycle concerns (cron schedules, shell actions, trigger conditions). Different concerns, different registries. There is no plan to merge them.

**Legacy channel format is replaced entirely.** The registry replaces the legacy `~/.config/openpalm/channels/*.yml` channel format (from the old XDG layout) with a clean break for 0.10.0. There is no coexistence and no dual-format staging pipeline. Users upgrading from 0.9.x run `openpalm migrate`, which handles the filesystem relocation and channel-to-component transition (see [fs-mounts-refactor.md Part 8](fs-mounts-refactor.md#part-8-migration-09x--0100)). Users with custom channels must reinstall them as components. This is a deliberate choice — the component model is strictly better, and maintaining backward compatibility with the old format would add complexity with no long-term benefit.

---

## Design

The registry is a collection of component directories. Each directory contains the same two files used everywhere else in the component system:

```
registry/
├── components/
│   ├── discord/
│   │   ├── compose.yml
│   │   ├── .env.schema
│   │   └── README.md
│   ├── caddy/
│   │   ├── compose.yml
│   │   ├── .env.schema
│   │   └── README.md
│   ├── searxng/
│   │   ├── compose.yml
│   │   ├── .env.schema
│   │   └── README.md
│   └── n8n/
│       ├── compose.yml
│       ├── .env.schema
│       └── README.md
├── index.json
└── schema.json
```

### Naming Convention: compose.yml

Component directories use `compose.yml` — the modern Docker Compose convention (since Compose V2). The core stack retains `docker-compose.yml` (the legacy name) for backward compatibility with existing deployments and documentation. This is a deliberate choice: new component definitions use the modern name; the established core stack keeps the name users already expect.

### index.json

Auto-generated from the component directories. Metadata is pulled from compose labels:

```json
{
  "components": [
    {
      "id": "discord",
      "name": "Discord",
      "description": "Discord bot channel adapter",
      "icon": "message-circle",
      "category": "messaging",
      "tags": ["messaging", "bot"],
      "author": "openpalm",
      "version": "1.0.0",
      "curated": true
    },
    {
      "id": "searxng",
      "name": "SearXNG",
      "description": "Privacy-respecting metasearch engine",
      "icon": "search",
      "category": "search",
      "tags": ["search", "privacy"],
      "author": "community-contributor",
      "version": "1.0.0",
      "curated": false
    }
  ]
}
```

The `curated` flag is the only distinction between first-party and community components. It replaces the old gallery concept — curated components are just ones the OpenPalm team has reviewed and tagged. The admin UI can filter on it. Nothing else treats them differently.

---

## Install Flow

Installing a registry component copies its directory into `~/.openpalm/data/catalog/`, making it available for instance creation. This is the same flow described in the components plan — the user then creates an instance from the catalog entry.

```
Registry → Download directory → ~/.openpalm/data/catalog/{id}/ → User creates instance
```

No npm. No package management. No plugin list manipulation. Just files on disk.

The instance creation flow (from the components plan) then copies the catalog entry into `~/.openpalm/data/components/{instanceId}/`, writes identity vars to `.env`, and adds the instance to `~/.openpalm/data/components/enabled.json`.

### Catalog Entry Removal

When a catalog entry is removed (via uninstall), only the source template in `~/.openpalm/data/catalog/{id}/` is deleted. Existing instances created from that component are **not affected** — each instance is a complete, self-contained copy of the compose definition and environment schema. The catalog entry is just the template used to create new instances; removing it means no new instances can be created from that component, but all running and stopped instances continue to work exactly as before. Instances are never orphaned by catalog changes.

### Archive Retention

When component instances are deleted, they are archived to `~/.openpalm/data/archived/` rather than permanently removed. There is no automated cleanup — the user manages archived instances manually. A future version may add a `GET /api/archived` endpoint for listing archived instances and a restore mechanism, but for 0.10.0 the archive directory is a simple safety net for accidental deletions.

---

## Admin API

The registry endpoints sit alongside the component and instance endpoints from the components plan:

```
# Registry (browsing and catalog management)
GET    /api/registry                         # cached index.json
GET    /api/registry/:id                     # component detail (README, schema)
POST   /api/registry/refresh                 # force re-fetch index
POST   /api/registry/:id/install             # download to catalog
POST   /api/registry/:id/uninstall           # remove from catalog
GET    /api/registry/search?q=...            # search by name, tags, category

# Components and instances (from the components plan — listed here for reference)
GET    /api/components                       # list available components (built-in + catalog)
GET    /api/components/:componentId          # component detail + schema
POST   /api/instances                        # create instance { component, name }
GET    /api/instances                        # list all instances with status
# ... (see components plan for full instance API)
```

The install flow connects the two API trees: `POST /api/registry/:id/install` downloads a component to `~/.openpalm/data/catalog/`, after which it appears in `GET /api/components` and can be used to create instances via `POST /api/instances`.

These replace all legacy gallery and extension endpoints (none of which exist in the current `packages/admin/src/` codebase — they were removed in a prior refactor):

| Legacy endpoint (removed) | Replaced by |
|---------|------------|
| `GET /admin/gallery/search` | `GET /api/registry/search` |
| `GET /admin/gallery/community` | `GET /api/registry` |
| `GET /admin/gallery/npm-search` | Removed entirely |
| `POST /admin/gallery/install` | `POST /api/registry/:id/install` |
| `POST /admin/gallery/uninstall` | `POST /api/registry/:id/uninstall` |
| `GET /admin/installed` | `GET /api/instances` |
| `GET /admin/gallery/categories` | Derived from `GET /api/registry` |
| `GET /admin/gallery/item/:id` | `GET /api/registry/:id` |
| `POST /admin/gallery/community/refresh` | `POST /api/registry/refresh` |

---

## Admin UI

Two tabs work together:

- **Components** — shows enabled instances, manage what's running (from the component plan).
- **Extensions** — browse the registry, install new components. This is the existing Extensions tab, rewired to pull from the component registry instead of the gallery/community/npm systems.

### Extensions tab

```
┌─ Extensions ────────────────────────────────────────────────┐
│                                                             │
│  Search: [____________]  Filter: [All ▼]                    │
│                                                             │
│  ── Curated ────────────────────────────────────────────── │
│  💬 Discord          Channel adapter           [Install]    │
│  ✈️ Telegram         Telegram bot adapter      [Install]    │
│  🧠 Ollama           Local LLM inference       [Install]    │
│  🔒 Caddy            Reverse proxy with TLS    [Installed]  │
│                                                             │
│  ── Community ──────────────────────────────────────────── │
│  💬 Slack            Slack workspace adapter   [Install]    │
│  🔍 SearXNG          Privacy search engine     [Install]    │
│  ⚡ n8n              Workflow automation        [Install]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Clicking **Install** downloads the component to the catalog and prompts to create an instance. Clicking a component name shows its README. **[Installed]** badge links to the instance in the Components tab.

---

## Submitting to the Registry

1. Create a directory under `registry/components/{id}/`.
2. Add `compose.yml` + `.env.schema` + `README.md`.
3. Open a PR. CI validates the compose file and schema.
4. After merge, the index is regenerated.

That's the entire contribution process. No special schemas to learn beyond standard Docker Compose and @env-spec.

---

## What Gets Removed

> **Note:** The files listed below are from the original admin codebase and have already been removed in prior refactors. They are listed here for historical context — no additional code removal is needed for these specific files. The current `packages/admin/src/` codebase does not contain gallery, community, or npm-search modules.

- ~~`admin/src/gallery.ts`~~ — curated gallery data and search (already removed)
- ~~`admin/src/extensions/community.ts`~~ — remote community registry fetch (already removed)
- ~~`admin/src/extensions/npm-search.ts`~~ — npm registry search (already removed)
- ~~`admin/src/extensions/types.ts`~~ — GalleryItem, GalleryCategory, RiskLevel (already removed)
- ~~`admin/src/extensions/installer.ts`~~ — plugin list management (already removed)
- All `/admin/gallery/*` API endpoints (already removed)

The Extensions tab stays but is rewired to use the `/api/registry` endpoints. Any remaining legacy extension/channel code in `packages/admin/src/` that conflicts with the component model should be identified and removed during implementation.

---

## Implementation Tasks

- [ ] Define `index.json` schema
- [ ] Build index generator (scans `registry/components/*/`, reads compose labels, outputs `index.json`)
- [ ] Migrate curated gallery entries that are container-based to component directories
- [ ] Migrate community registry entries to component directories
- [ ] CI validation for component submissions (compose spec + @env-spec)
- [ ] Admin: registry fetch + cache (replace gallery + community fetch code)
- [ ] Admin API: `/api/registry` endpoints
- [ ] Admin UI: Rewire Extensions tab to use `/api/registry` endpoints
- [ ] Remove gallery, community, npm-search code and old API endpoints
- [ ] Remove any remaining legacy channel support (clean break — legacy `~/.config/openpalm/channels/*.yml` format is dropped; migration handled by `openpalm migrate`)
- [ ] Update docs
