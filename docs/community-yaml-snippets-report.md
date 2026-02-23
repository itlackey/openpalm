# Community YAML Snippets for Channels, Services & Automations

**Report: 5 Best Options for a Community-Driven Snippet Registry**

## Problem Statement

OpenPalm needs a way for the community to publish reusable YAML snippets that describe channels, services, and automations — including what environment variables each container requires, whether they're required or optional, whether they hold secrets, and how to configure them. The UI should be able to render a custom install/configure page from these snippets without any code changes to the core stack. The system must also be easy for AI agents to author, validate, and curate.

## Current State

**What exists today:**

- **Channel YAML snippets** (`packages/lib/assets/channels/*.yaml`) define `name`, `containerPort`, `rewritePath`, `sharedSecretEnv`, and a flat `configKeys` string array. No descriptions, types, or required flags.
- **UI field metadata is hardcoded** in `ChannelsStep.svelte` — each field's `label`, `type`, `required`, and `helpText` are duplicated in Svelte code, not derived from the YAML.
- **Extension registry** (`packages/lib/src/embedded/state/registry/`) — JSON files per extension with a JSON Schema, CI validation on PR, and auto-rebuilt `index.json` on merge to main. Currently has one entry (Slack channel).
- **Secret references** use `${UPPER_CASE_NAME}` pattern, validated by `parseSecretReference()` in `stack-spec.ts`.
- **Automations** (`StackAutomation`) have `id`, `name`, `description`, `schedule`, `script`, `enabled`, `core` — but no way to declare environment variables they consume.

**The gap:** There is no structured, data-driven schema for describing environment variables with rich metadata. The UI can't generate configuration forms from snippet data alone. Community members have no clear path to publish reusable configurations.

---

## Proposed Snippet Schema (Common to All 5 Options)

Regardless of distribution mechanism, every option below uses this YAML snippet format. This is the foundational schema that enables all downstream capabilities.

```yaml
# Example: channel-discord.yaml
apiVersion: v1
kind: channel                          # channel | service | automation

metadata:
  id: channel-discord
  name: Discord
  description: Connect your assistant to a Discord server
  author: OpenPalm
  version: 1.0.0
  tags: [channel, discord, bot, messaging]
  docUrl: https://discord.com/developers/applications
  icon: discord                        # icon key or URL

# Container block (channels & services only)
container:
  image: openpalm/channel-discord:latest
  port: 8184
  rewritePath: /discord/webhook
  sharedSecretEnv: CHANNEL_DISCORD_SECRET
  volumes: []
  dependsOn: []

# Automation block (automations only)
automation:
  schedule: "*/5 * * * *"
  script: |
    #!/usr/bin/env bash
    set -euo pipefail
    curl -X POST http://gateway:8080/api/message ...

# Environment variables — the core of the snippet
env:
  - name: DISCORD_BOT_TOKEN
    label: Bot Token
    description: Create a bot at discord.com/developers and copy the token
    type: secret                       # text | secret | number | boolean | select | url | email
    required: true
    helpUrl: https://discord.com/developers/applications

  - name: DISCORD_PUBLIC_KEY
    label: Public Key
    description: Found on the same page as your bot token
    type: text
    required: true

  - name: CHANNEL_DISCORD_SECRET
    label: Channel Secret
    description: HMAC signing key for gateway communication. Auto-generated if left blank.
    type: secret
    required: false
    generate: random(64)               # hint to UI/CLI: auto-generate if empty

  - name: DISCORD_LOG_LEVEL
    label: Log Level
    description: Logging verbosity
    type: select
    default: info
    options:
      - { label: Debug, value: debug }
      - { label: Info, value: info }
      - { label: Warning, value: warn }
      - { label: Error, value: error }

# Security metadata
security:
  risk: medium
  permissions:
    - "Network: outbound to gateway + Discord API"
    - "HMAC channel signing"
  notes: >
    Requires Discord bot token stored as a secret.
    Validates Discord request signatures on every webhook.
```

**For automations**, the same `env` block applies:

```yaml
apiVersion: v1
kind: automation

metadata:
  id: daily-summary-email
  name: Daily Summary Email
  description: Sends a daily briefing email at 8 AM
  author: community-contributor
  version: 1.0.0
  tags: [automation, email, daily, summary]

automation:
  schedule: "0 8 * * *"
  script: |
    #!/usr/bin/env bash
    set -euo pipefail
    curl -X POST http://gateway:8080/api/message \
      -H "Authorization: Bearer $GATEWAY_TOKEN" \
      -d "{\"text\": \"Send daily summary to $EMAIL_RECIPIENT\"}"

env:
  - name: EMAIL_RECIPIENT
    label: Recipient Email
    description: Email address to send the daily summary to
    type: email
    required: true

  - name: GATEWAY_TOKEN
    label: Gateway Token
    description: Token for authenticating with the gateway API
    type: secret
    required: true
```

The UI and validator read the `env` block to:
1. Render input fields with proper types (password fields for secrets, dropdowns for selects)
2. Mark required fields and block apply/save until they have values or secret references
3. Offer auto-generation for fields with `generate` hints
4. Link to external docs via `helpUrl`

---

## The 5 Options

### Option 1: GitHub Repo Index with Raw URL Fetch (Recommended)

**Model:** Helm's `index.yaml` + Homebrew's tap model

**How it works:**

The main OpenPalm repo contains a `community/snippets/` directory. Each snippet is a single YAML file. A GitHub Actions workflow validates on PR and rebuilds `index.yaml` on merge — exactly like the existing registry CI but for YAML snippets instead of JSON extension entries.

The admin dashboard fetches `index.yaml` from the repo's raw URL at runtime:
```
https://raw.githubusercontent.com/itlackey/openpalm/main/community/snippets/index.yaml
```

No code changes needed to add new snippets. A merged PR to the snippets directory is all it takes.

**Publishing workflow:**
1. Contributor creates a YAML snippet file following the schema
2. Opens a PR to `community/snippets/`
3. CI validates against JSON Schema, checks for duplicate IDs, posts a validation report on the PR
4. Maintainer reviews and merges
5. CI rebuilds `index.yaml` and pushes
6. All OpenPalm instances see the new snippet on next dashboard load

**Federation (future):** Users can add additional snippet source URLs in settings. Each source provides its own `index.yaml`. The UI merges them and shows provenance (source name/URL).

```typescript
// No code changes needed to add snippets — just a config array
interface SnippetSource {
  name: string;
  url: string;        // URL to index.yaml
  trusted: boolean;   // true for the official repo
}

const DEFAULT_SOURCES: SnippetSource[] = [
  {
    name: "OpenPalm Community",
    url: "https://raw.githubusercontent.com/itlackey/openpalm/main/community/snippets/index.yaml",
    trusted: true,
  },
];
```

**Why this is the best option:**

| Criteria | Rating |
|---|---|
| DX for contributors | High — fork, add YAML file, open PR. Familiar GitHub workflow. |
| AI agent friendliness | Excellent — YAML is benchmarked as the best format for LLM accuracy. Flat structure, enum constraints, self-documenting descriptions. AI agents can generate, validate, and submit PRs. |
| No code changes for updates | Yes — raw URL fetch at runtime. New snippets appear without releases. |
| Easy to curate | PR-based review. AI agents can review PRs via GitHub API. |
| Community adoption likelihood | Highest — leverages existing GitHub muscle memory. Same pattern as Homebrew core, Helm stable charts, awesome lists, Portainer templates. |
| Infrastructure cost | Zero — GitHub hosts everything. |

**Tradeoffs:**
- Centralized — maintainer is a bottleneck for merging PRs (mitigated by federation support)
- Rate limits on raw.githubusercontent.com (mitigated by caching in the admin service)

---

### Option 2: GitHub Topic Discovery (Zero-Gatekeeping)

**Model:** Backstage's GitHub-based plugin discovery + Go module's DNS-as-authority

**How it works:**

Instead of a central repo, each snippet lives in its own GitHub repository (or a contributor's dedicated snippets repo). Contributors tag their repo with the `openpalm-snippet` GitHub topic and include a `openpalm-snippet.yaml` file at the repo root.

The admin dashboard uses the GitHub Search API to discover snippets:
```
GET https://api.github.com/search/repositories?q=topic:openpalm-snippet
```

Then fetches `openpalm-snippet.yaml` from each discovered repo.

**Publishing workflow:**
1. Contributor creates a repo (e.g., `myuser/openpalm-discord-channel`)
2. Adds `openpalm-snippet.yaml` at the root following the schema
3. Adds the `openpalm-snippet` topic to the repo
4. Done — no PR, no approval, no central authority

**Discovery aggregation:** The admin service periodically queries the GitHub API, caches results, and presents them in the UI. A CI job in the main repo could also run nightly to build a cached index from discovered repos.

**Why this option is compelling:**

| Criteria | Rating |
|---|---|
| DX for contributors | Highest — no PR needed, no approval wait. Own your snippet entirely. |
| AI agent friendliness | Excellent — AI agents can create repos, add topics, and push YAML via GitHub API with zero human interaction. |
| No code changes for updates | Yes — discovery is dynamic via GitHub Search API. |
| Easy to curate | Moderate — no quality gate by default. Could add a "verified" badge system for reviewed snippets. |
| Community adoption likelihood | High — lowest barrier to entry. Contributors who don't want to learn the PR process can still participate. |
| Infrastructure cost | Zero — GitHub API is free for public repos. |

**Tradeoffs:**
- No quality gate — anyone can publish anything (mitigated by trust badges and user ratings)
- GitHub Search API rate limits (60/hour unauthenticated, 30/minute authenticated)
- Requires internet access to discover snippets (mitigated by shipping a cached index with releases)

---

### Option 3: Embedded Index + PR Contributions (Ship with the Release)

**Model:** Portainer templates + VS Code built-in extensions

**How it works:**

Snippets are committed directly into the `packages/lib/assets/` directory alongside existing channel YAML files. They ship as part of the OpenPalm release. The admin dashboard reads them from the filesystem — no network fetch required.

This is an evolution of the current approach: enrich the existing channel YAML files with the `env` metadata, and extend the pattern to services and automations.

**Publishing workflow:**
1. Contributor opens a PR adding/modifying a YAML file in `packages/lib/assets/snippets/`
2. CI validates the snippet schema
3. Maintainer reviews and merges
4. Snippet ships in the next release

**Migration path from current state:**
1. Enrich `packages/lib/assets/channels/discord.yaml` with `env` metadata (add `label`, `type`, `required`, `description`, `helpUrl` to each config key)
2. Update `BuiltInChannelDef` type to include typed env field definitions
3. Remove hardcoded field metadata from `ChannelsStep.svelte` — render from snippet data
4. Add `packages/lib/assets/snippets/services/` and `packages/lib/assets/snippets/automations/` directories

**Why this option is compelling:**

| Criteria | Rating |
|---|---|
| DX for contributors | High — same PR workflow as Option 1. |
| AI agent friendliness | Excellent — same YAML format. |
| No code changes for updates | Partial — new snippets ship with releases, not dynamically. But the snippet schema itself requires no code changes to support new entries. |
| Easy to curate | Highest — all snippets are reviewed and shipped by the core team. |
| Community adoption likelihood | High — contributors trust that official snippets work. |
| Infrastructure cost | Zero — bundled with the app. |

**Tradeoffs:**
- New snippets only appear in new releases (mitigated by combining with Option 1 or 2 for dynamic discovery)
- Increases repo size over time (mitigated by keeping snippets small — each is ~30 lines of YAML)

---

### Option 4: OCI Artifact Registry (Container-Native)

**Model:** Helm OCI charts + Flux OCI artifacts

**How it works:**

Each snippet is published as an OCI artifact to GitHub Container Registry (GHCR) alongside the container image it describes. The snippet YAML is a layer in the OCI manifest with a custom media type:

```
application/vnd.openpalm.snippet.v1+yaml
```

Contributors push snippets using ORAS (OCI Registry As Storage):
```bash
oras push ghcr.io/myuser/openpalm-discord-channel:v1.0.0 \
  snippet.yaml:application/vnd.openpalm.snippet.v1+yaml
```

The admin dashboard discovers snippets by querying OCI registries for artifacts with the OpenPalm media type.

**Publishing workflow:**
1. Contributor writes `snippet.yaml` following the schema
2. Pushes to any OCI-compliant registry with `oras push`
3. Optionally registers the artifact URL with a central index (or relies on registry search)

**Why this option is compelling:**

| Criteria | Rating |
|---|---|
| DX for contributors | Moderate — requires learning ORAS tooling. CI template can automate this. |
| AI agent friendliness | Good — YAML content is the same. OCI push is scriptable. |
| No code changes for updates | Yes — registry is external. |
| Easy to curate | Moderate — no central review gate, but OCI signing (cosign/notation) provides provenance. |
| Community adoption likelihood | Moderate — familiar to Kubernetes/DevOps community, less so to general developers. |
| Infrastructure cost | Low — GHCR is free for public images. |

**Tradeoffs:**
- Higher contributor friction (ORAS is less well-known than `git push`)
- Discovery requires OCI registry search or a separate index
- Overkill for pure YAML snippet sharing — best suited if snippets are always paired with container images

---

### Option 5: Static JSON Feed + GitHub Pages (Decentralized Aggregation)

**Model:** Artifact Hub's repository federation + JSON Feed spec

**How it works:**

Any contributor can host a snippet feed — a single `openpalm-snippets.json` file served from any HTTPS URL (GitHub Pages, Netlify, S3, any static host). The file follows a simple array format:

```json
{
  "version": "1.0",
  "name": "My OpenPalm Snippets",
  "author": "myuser",
  "url": "https://myuser.github.io/openpalm-snippets",
  "snippets": [
    { /* snippet object matching the schema */ },
    { /* another snippet */ }
  ]
}
```

The admin dashboard has a "Snippet Sources" page where users add feed URLs. A curated list of community feeds ships as the default.

**Publishing workflow:**
1. Contributor creates a repo with their snippets as YAML files
2. A GitHub Actions workflow validates and builds `openpalm-snippets.json`
3. GitHub Pages serves it at `https://myuser.github.io/openpalm-snippets/openpalm-snippets.json`
4. Users add the URL to their OpenPalm instance, or the contributor submits a PR to add it to the default feed list

**Why this option is compelling:**

| Criteria | Rating |
|---|---|
| DX for contributors | Moderate-High — requires setting up a repo with GitHub Pages. A template repo can reduce this to a few clicks. |
| AI agent friendliness | Excellent — JSON feeds are trivially parseable. AI agents can create repos from templates and manage feed content entirely via API. |
| No code changes for updates | Yes — feeds are fetched at runtime. |
| Easy to curate | High — each feed is independently maintained. The default feed list is curated via PR. |
| Community adoption likelihood | Moderate-High — familiar pattern from RSS/Atom/JSON Feed. True decentralization without the complexity of IPFS or DNS tricks. |
| Infrastructure cost | Zero per feed — GitHub Pages is free. |

**Tradeoffs:**
- Users must add feeds manually (unless a default list is maintained)
- Feed availability depends on the host (GitHub Pages is reliable)
- Slightly more complex than a single central repo

---

## Comparison Matrix

| Criteria | Option 1: Repo Index | Option 2: GitHub Topics | Option 3: Embedded | Option 4: OCI Artifacts | Option 5: JSON Feeds |
|---|---|---|---|---|---|
| **Contributor friction** | Low (PR) | Lowest (tag repo) | Low (PR) | Medium (ORAS) | Medium (setup repo) |
| **Quality gate** | PR review | None | PR review | Signing | Feed list PR |
| **Offline support** | Cached | Cached index | Full | Cached | Cached |
| **Dynamic updates** | Yes (raw fetch) | Yes (API search) | Release-only | Yes (registry) | Yes (feed fetch) |
| **AI agent DX** | Excellent | Excellent | Excellent | Good | Excellent |
| **Federation ready** | Yes (multi-URL) | Built-in | No | Yes (multi-registry) | Yes (multi-feed) |
| **Infra cost** | Zero | Zero | Zero | Low | Zero |
| **Adoption likelihood** | Highest | High | High | Moderate | Moderate-High |

---

## Recommendation

**Start with Option 3 (Embedded) + Option 1 (Repo Index) as a hybrid.**

This gives the best of both worlds:

1. **Option 3 first:** Enrich the existing channel YAML files with `env` metadata. This is the smallest change — update 4 YAML files, update the `BuiltInChannelDef` type, and drive `ChannelsStep.svelte` from snippet data instead of hardcoded arrays. Built-in channels ship with the release and work offline.

2. **Option 1 next:** Add a `community/snippets/` directory with the same schema. The admin dashboard fetches `index.yaml` from the raw GitHub URL for community-contributed snippets. New community contributions appear without releases.

3. **Design the data-fetching layer to support multiple sources from day one** (the `SnippetSource[]` abstraction), even if only one source is configured initially. This makes Option 2, 4, or 5 a future configuration change, not an architecture change.

4. **For automations:** Add an `env` field to `StackAutomation` to declare environment variables the script uses. The UI and validator check that values or secrets exist for required env vars before enabling the automation.

This approach:
- Requires the least upfront work (enrich existing YAMLs, add a fetch layer)
- Has the highest community adoption likelihood (familiar GitHub PR workflow)
- Is AI-agent native (YAML + JSON Schema + GitHub API = trivially automatable)
- Scales to federation when the community grows
- Requires zero infrastructure beyond GitHub

---

## Implementation Sketch

### Phase 1: Enrich existing channel YAMLs (Option 3)

1. Update `packages/lib/assets/channels/discord.yaml` (and chat, telegram, voice) with `env` metadata
2. Update `BuiltInChannelDef` type to include `env: EnvVarDef[]`
3. Create `EnvVarDef` type matching the schema
4. Update `ChannelsStep.svelte` to render fields from snippet `env` data
5. Add `env` field to `StackAutomation` type for automation env var declarations

### Phase 2: Community snippets directory (Option 1)

1. Create `community/snippets/` directory with `snippet-schema.json`
2. Add CI workflow: validate YAML snippets on PR, rebuild `index.yaml` on merge
3. Add `SnippetSource` abstraction to admin service
4. Add runtime fetch of community `index.yaml` with caching
5. UI: "Community" tab in channel/service/automation browsers
6. Provide a PR template and `CONTRIBUTING.md` for snippet authors

### Phase 3: Federation (Option 1 + 2 hybrid, future)

1. Add "Snippet Sources" settings page to admin dashboard
2. Support custom source URLs
3. Optionally discover repos via `openpalm-snippet` GitHub topic
4. Trust tier badges: Official / Verified / Community
