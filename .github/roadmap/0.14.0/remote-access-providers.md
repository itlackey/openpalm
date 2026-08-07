# Remote access providers — one front door, swappable engines

Status: proposal; §7 phase 1 (registry + card + Tailscale refactor)
implemented — see Implementation status at the end
Companion to `remote-access-from-anywhere.md` (which shipped the Tailscale
`remote` addon), `pangolin-remote-access.md` (the flagship proposal), and
`cloudflare-tunnel-comparison.md` (the three-way verdict). Those documents
settled *which* front doors matter and when; this one specs the seam that
lets the stack hold any of them: a provider-neutral `remote` capability
whose providers are mutually exclusive variants of one addon, a registry
the control plane and UI program against, and a normalized status
vocabulary that lets one card render every provider. It exists because
making Tailscale effortless for users and making the stack ready for
Pangolin (or a swap away from Tailscale entirely) turn out to be the same
work — one card, one registry, one vocabulary — and building them
Tailscale-first is the cheapest moment to do it: the `remote` addon has
no install base, so every rename below is free.

## 1. The requirement, stated plainly

Tailscale is the only remote option today and may remain so for a while;
Pangolin is proposed as the flagship when it lands; Cloudflare is a
designated occupant of one cell if demand appears. The stack must
therefore support **adding** a provider without re-architecture and
**swapping** the current one without stranding anyone — while the only
provider that exists gets easier, not more abstract, to set up.

The shipped code has thin seams but no contract: the original roadmap's
`provider: "tailscale"` discriminant was dropped in implementation, the
apply path is a name special-case (`if (name === 'remote')` in
`addons.ts` and the credentials route), guardian-ingress recomputation is
a Tailscale-private predicate, and the addon's user surface is a schema
drawer named after a capability but shaped entirely by one vendor. None
of that blocks a second provider; all of it means a second provider would
be a second copy. This document replaces the copies with tables before
there is anything to copy.

## 2. Providers are variants of one addon

The stack already ships the multi-implementation mechanism this needs:
the voice/ollama hardware-variant machinery — per-variant compose
profiles with `openpalm.profile.label` / `openpalm.profile.requires` /
`openpalm.profile.default` labels, selection stored as
`OP_<NAME>_PROFILE` via `profileEnvKey`, rendered by the profile selector
`AddonsTab.svelte` already special-cases for voice. Remote access
providers are that shape — with two generalizations the shipped
machinery needs first, verified against the code rather than assumed:
`PROFILE_ID_RE` in `profile-ids.ts` hard-codes the variant suffixes to
`cpu|cuda|rocm`, so `canonicalAddonProfileSelection` would reject every
profile id below until the pattern accepts arbitrary suffixes; and
profile *activation* never reads the compose labels —
`resolveActiveProfiles` in `compose-args.ts` maps a bare enabled addon to
the literal `addon.<id>` and hard-codes the voice/ollama
no-selection fallbacks, so the bare-enable guarantee below comes from
extending that function (read `OP_REMOTE_PROFILE`, fall back to
`addon.remote.tailscale`), not from the `openpalm.profile.default` label,
which is display metadata only.

| Variant profile | Provider | Services | Label (proposed) |
|---|---|---|---|
| `addon.remote.tailscale` | Tailscale (default) | `tunnel` | "Tailscale — your own devices, zero setup" |
| `addon.remote.pangolin-proxy` | Pangolin, server in-stack | `pangolin`, `pangolin-traefik` | "Pangolin — a web address this stack serves" |
| `addon.remote.pangolin-tunnel` | Pangolin, server + WireGuard ingress | `pangolin`, `pangolin-traefik`, `gerbil` | "Pangolin — server + tunneling for other machines" |
| `addon.remote.pangolin-connector` | Pangolin, connector to a server elsewhere | `newt` | "Pangolin — connect to a server you run elsewhere (or Pangolin Cloud)" |
| `addon.remote.cloudflare` | Cloudflare named tunnel (reserved, unbuilt) | `cloudflared` | "Cloudflare Tunnel" |

Selection lands in `OP_REMOTE_PROFILE` (`profileEnvKey("remote")` — no
collision with the existing `OP_REMOTE_*` keys). Enabling remote access
is `OP_ENABLED_ADDONS=…,remote` plus a profile; the shipped `tunnel`
service moves from `profiles: ["addon.remote"]` to
`profiles: ["addon.remote.tailscale"]`, and the `resolveActiveProfiles`
extension above is what keeps a bare enable deploying Tailscale exactly
as it does now.

Three consequences, each previously argued differently and corrected
here deliberately:

- **Swap is a profile switch.** Replacing Tailscale with Pangolin later —
  or trying Pangolin and switching back — is the existing selector, not a
  migration. Nothing is shared between providers, so a switch is
  stop-old-services, start-new-services; each provider's state
  (`data/tunnel/`, `data/pangolin/`) stays on disk for switching back.
- **Mutual exclusivity is now free, and chosen.** The Pangolin proposal
  argued against exclusivity because enforcing it would cost an
  invariant; under variants it costs nothing — one selection is how
  profiles already work. The both-at-once topology (side-by-side
  evaluation, DNS-failure redundancy) is knowingly sacrificed for a
  coherent one-front-door model; `pangolin-remote-access.md` §3 and §4.1
  record the reversal.
- **The front-door chooser dissolves into the provider selector.** The
  two questions it asked (*can the internet reach this machine? should
  visitors see a sign-in page on a real address?*) become the
  recommendation logic that sorts the selector's options — a component
  that renders as nothing while the registry holds one entry.

## 3. The provider registry

One declaration table in `@openpalm/lib`, replacing every would-be
special case (`packages/lib/src/control-plane/remote-providers.ts`):

```ts
export type RemoteProviderDefinition = {
  /** Registry key and profile suffix: "tailscale", "pangolin-proxy", … */
  id: string;
  /** Compose services this provider deploys — the recreate scope. */
  services: readonly string[];
  /** Env keys this provider owns in state/stack.env. */
  envKeys: readonly string[];
  /** Secret files to seed empty at install (ensureSecrets) — delegated
   *  credentials and generated placeholders that Compose declares alike. */
  secrets: readonly string[];
  /** Regenerate provider artifacts (serve.json, config.yml, newt_config…)
   *  after env/secret writes and around enable/disable. Fail-closed. */
  applyConfig(homeDir: string): AddonApplyResult;
  /** Observed state, mapped into the shared vocabulary (§4). */
  fetchStatus(state: ControlPlaneState): Promise<RemoteStatus>;
  /** Does this provider, as configured, need the guardian to answer
   *  direct ingress? ORed across providers by the ONE shared writer. */
  guardianIngressRequired(env: Record<string, string>): boolean;
  /** Lines for the security/exposure card. Ports and facts, never
   *  unverified URLs. */
  describeExposure(env: Record<string, string>): string[];
};

export const REMOTE_PROVIDERS: Record<string, RemoteProviderDefinition>;
```

What this deletes and centralizes:

- The `if (name === 'remote')` special cases in `addons.ts` and the
  credentials route become one lookup: resolve the selected provider,
  call its `applyConfig`. (The earlier proposal's `ADDON_APPLY_HOOKS`
  table is superseded by this — same idea, better typed, remote-scoped.)
- `computeGuardianIngressRequired(env)` is implemented once as
  `Object.values(REMOTE_PROVIDERS).some(p => selected(p) &&
  p.guardianIngressRequired(env))` and becomes the single input
  `resolveAccessEnv`'s `guardianIngressRequired` option receives. This
  *creates* the single-writer property rather than preserving one: today
  `remoteRequiresGuardianIngress(enabled, target)` is computed
  independently at three call sites (`access-apply.ts`, `setup.ts`,
  `remote-apply.ts`), a dispersal the consolidation also fixes.
- `ensureSecrets` seeds every registry entry's `secrets` list — delegated
  credentials *and* generated placeholders (`newt_config`, which is a
  declared Compose secret even though it is control-plane-generated) —
  so the hand-edit enable path cannot brick the stack on a missing
  declared secret file for any provider.
- Recreate scope stays where the shipped code already puts it for remote:
  `applyConfig`'s returned service list. The credentials route today
  deliberately bypasses `ADDON_ENV_RECREATE_SCOPE` for remote (`name ===
  'remote' ? []`, with a comment that the table cannot express remote's
  apply scope); the registry keeps that posture per provider rather than
  pretending a static `envKeys` × `services` table could.

What this deliberately does **not** abstract: each provider's artifact
machinery — Tailscale's `serve.json` discipline, Pangolin's generated
`config.yml`/Traefik files/blueprint, Cloudflare's remote API calls —
stays private behind `applyConfig`. That is where providers genuinely
differ, and a shared artifact model would be speculation. The registry
standardizes the *edges* (enable, apply, status, secrets, ingress,
exposure), not the middles.

## 4. The normalized status vocabulary

One type every provider maps into, designed so the UI renders providers
it has never heard of:

```ts
export type RemoteStatus = {
  state:
    | "off"                      // addon disabled
    | "awaiting-config"          // enabled, required inputs missing
    | "awaiting-authentication"  // needs a human to click/sign in
    | "pending-external"         // waiting on the world: DNS, certs
    | "starting"
    | "up"
    | "degraded"                 // running, but a named part is not
    | "error";
  /** One sentence in the operator's language. Required. */
  message: string;
  /** At most one primary action — a button, not a paragraph. */
  action?: { label: string; url: string };
  /** Copyable facts: URLs, DNS records, commands. qr renders a QR code. */
  copyables?: { label: string; value: string; qr?: boolean }[];
  /** Named stages for slow paths — never a bare spinner. */
  progress?: { stage: string; done: boolean }[];
};
```

Per-provider mappings, showing the vocabulary carries all three:

| Provider signal | Maps to |
|---|---|
| Tailscale `.AuthURL` from `tailscale --socket=/tmp/tailscaled.sock status --json` (the rootless container relocates the LocalAPI socket; a bare `tailscale status` reports down forever — `services.compose.yml`'s caller caveat) | `awaiting-authentication` + action "Connect your account" |
| Tailscale `.Self.DNSName`, container healthy | `up` + copyable URL (with QR) |
| Pangolin 80/443 unreachable with DNS in place | `error` + copyable firewall commands |
| Pangolin dashboard domain not resolving to this host | `pending-external` + copyable DNS record (custom mode) or plain message (ddns/manual modes) |
| Pangolin ACME issuance in flight | `pending-external` + progress stages |
| Pangolin one of three server containers unhealthy | `degraded` + which one, in the message |
| cloudflared `/ready` non-200 | `starting` or `degraded` per connection count |
| Any provider, required secret file empty | `awaiting-config` |

Two rules carry over from the shipped invariants: states clear only by
**observation** (poll the fact, never trust a clicked "done"), and a URL
is **advertised last** — `copyables` may carry a URL only in `up`.

## 5. One card in the UI

A single provider-neutral surface — the "Reach it from anywhere" card —
replacing the vendor-shaped drawer as the addon's front page:

- **The status renderer** consumes `RemoteStatus` generically: message,
  one action button, copy buttons, named progress. QR rendering reuses
  the pairing route's server-side QR-SVG generator, extracted into a
  shared helper (there is no client QR component today — the pairing page
  injects the route-minted SVG). No provider-specific components.
- **The provider selector** is the existing profile-selector pattern,
  rendered only when `REMOTE_PROVIDERS` holds more than one entry —
  today it shows nothing and Tailscale is simply what the card does.
  When it appears, its recommendation follows one rule stated once:
  reachable host → the Pangolin server variants; CGNAT and private
  access → Tailscale; CGNAT and public sharing → the vendor-or-own-VPS
  menu `cloudflare-tunnel-comparison.md` §5 specifies, trades disclosed.
- **Config fields** still come from the schema DSL, merged into one
  `remote` schema and filtered by the selected provider's registry
  `envKeys`/`secrets` lists (not by name prefix — `DUCKDNS_TOKEN`,
  `NEWT_SECRET`, and Tailscale's `OP_REMOTE_*` keys carry no shared
  prefix). The DSL has no conditional-display annotation, so the
  filtering lives in the drawer beside the selector — the same
  bespoke-section precedent voice already uses. Advanced fields stay
  collapsed by default.
- **Adjacent surfaces** read the registry, not the vendor: the "Open on
  your phone" card in `AssistantTab` links here when LAN URLs aren't
  enough; the exposure card renders `describeExposure` lines; the deep
  link is `?tab=addons&addon=remote` via the `focusAddon` mechanism,
  whose plumbing is currently hard-typed to `'voice'` at both ends
  (`host/+page.svelte`, `AddonsTab.svelte`) and widens to accept
  `'remote'`, opening the card.
- **Setup-spec**: reserve `remote: { provider: string, … }` as the
  headless shape; until it exists, the documented recipe remains env
  keys + secret files.

## 6. The first provider, made effortless

The card's Tailscale mapping is the whole setup story, and it is the
easiest in the field the comparison surveyed:

1. Toggle on (wizard next-step card or Addons tab). No fields.
2. Card polls `tailscale --socket=/tmp/tailscaled.sock status --json` via
   `composeExec` (the `--socket` flag is load-bearing: the rootless
   container relocates the LocalAPI socket, and the compose file's caller
   caveat warns a bare `tailscale status` reports down forever), surfaces
   `.AuthURL` as **Connect your account** — today that link is only in
   the container logs, which is the single worst step in the current
   flow. Operator signs in with Google/GitHub/Apple.
3. Card observes registration, flips to `up`, shows
   `https://<name>.<tailnet>.ts.net` with copy button and QR for the
   phone. Done: no tokens, no DNS, no domain, no logs.

The default surface is **Serve, private, assistant target** — the cell
Tailscale wins. `TS_AUTHKEY` (headless pre-auth), `OP_REMOTE_HOSTNAME`,
`OP_REMOTE_TARGET`, and `OP_REMOTE_PUBLIC` collapse under advanced;
Funnel gets no button, because public-unauthenticated is the field's
worst public option and the mitigations it would demand (approval
pre-flight, hard password gate, warning ceremony, chrome badge) belong
to the provider that does public exposure with an auth gate. Those items
leave the Tailscale backlog permanently — the hard password gate gets
built once, in the Pangolin work, scoped to its no-SSO/PIN-only
resources; the hand-edited `OP_REMOTE_PUBLIC` env path stays possible
and is documented in the runbook register as unguarded, which is the
posture every hand-edit path already has. The one shared fix that ships
with this work is `ADDRESS_HEADER` on the login throttle — it serves
every documented proxy topology today and every provider later.

## 7. Migration and sequencing

The profile rename (`addon.remote` → `addon.remote.tailscale`) and the
selection key are the only migration surface, and with no install base
they are renames, not migrations. The one guard worth writing anyway:
`resolveActiveProfiles` treats an enabled `remote` with no stored
`OP_REMOTE_PROFILE` as the default provider, so a hand-edited
`OP_ENABLED_ADDONS=remote` keeps working — the same posture its
hard-coded `addon.voice.cpu` / `addon.ollama.cpu` fallbacks already take
(that function, not the compose labels, is where
enabled-without-selection is decided today).

One lifecycle decision, made here so implementation doesn't stumble into
it: `OP_REMOTE_PROFILE` deliberately does **not** join
`PROFILE_ONLY_ENV_KEYS`. Staying out means the selection survives
disable — wanted, since §2 keeps provider state on disk for switching
back — and it sidesteps the hazard that list carries:
`migrateProfileOnlyAddonEnablement` treats a lingering listed profile
key as implied enablement and would silently re-add `remote` to
`OP_ENABLED_ADDONS` on the next reconcile, exactly the re-enable bug the
PR #564 note records for voice.

Sequencing:

1. **Registry + card + Tailscale refactor** — small, self-contained,
   immediately improves the only shipped provider's setup; establishes
   the contract everything later fills in.
2. **Pangolin variants** — the flagship proposal's implementation, now
   landing as registry entries and profiles instead of a sibling addon
   (`pangolin-remote-access.md` §4–§8, adjusted accordingly).
3. **Cloudflare** — stays unbuilt until its trigger; when it fires, it
   is one registry entry, one service block, one secret, one status
   mapping (`cloudflare-tunnel-comparison.md` §2.5).

## 8. Files touched

Create: `packages/lib/src/control-plane/remote-providers.ts` (registry +
`RemoteStatus`); the card component and status renderer in
`packages/ui`; `remote-providers.test.ts` (registry ↔ compose profile
agreement, single-writer ingress, secrets seeding sweep).

Modify: `packages/lib/src/control-plane/profile-ids.ts` (`PROFILE_ID_RE`
generalized from `cpu|cuda|rocm` to arbitrary variant suffixes, plus its
`canonicalAddonProfileSelection` / availability consumers);
`compose-args.ts` (`resolveActiveProfiles` reads `OP_REMOTE_PROFILE`
with the `addon.remote.tailscale` fallback — the voice/ollama fallback
branches generalize into a table at the same time);
`packages/skeleton/system/stack/services.compose.yml` (tunnel's profile
+ variant labels); `packages/lib/src/control-plane/addons.ts` and the
credentials route (special case → registry dispatch);
`access-toggles.ts` (`remoteRequiresGuardianIngress`'s three dispersed
call sites consolidate into the registry-driven
`computeGuardianIngressRequired`); `addon-env-schemas.ts` (schema
merge); `secrets.ts` (registry-driven seeding); `AddonsTab.svelte` /
`AssistantTab.svelte` / `host/+page.svelte` (card, selector, phone-card
link, `focusAddon` union widened to `'remote'`);
`remote-compose.test.ts`, `remote-addon-registry.test.ts` (profile
rename); `docs/remote-access-tls.md` and
`docs/operations/manual-headless-install.md` (provider-structured
sections). `addon-ids.ts` is deliberately **not** touched: no new addon
id exists in this design — that is the point.

## 9. Sources

- `packages/lib/src/control-plane/addons.ts` — `getAddonProfiles`,
  `profileEnvKey`, `setAddonProfileSelection`,
  `migrateProfileOnlyAddonEnablement` (the variant machinery reused)
- `packages/skeleton/system/stack/services.compose.yml` — voice/ollama
  variant labels; the `tunnel` service this restructures
- `packages/lib/src/control-plane/remote-access.ts`, `remote-apply.ts` —
  the Tailscale artifact machinery that stays provider-private
- `packages/ui/src/lib/components/addons/AddonsTab.svelte` — the voice
  profile-selector precedent; `packages/ui/src/routes/api/host/addons/`
- `.github/roadmap/0.14.0/remote-access-from-anywhere.md` — the dropped
  `provider:` discriminant this restores, and the unbuilt read-back items
  §6 finally lands
- `.github/roadmap/0.14.0/pangolin-remote-access.md`,
  `.github/roadmap/0.14.0/cloudflare-tunnel-comparison.md` — the
  providers this seam is being built to hold

## Implementation status

Phase 1 of §7 — the registry, the card, and the Tailscale refactor —
landed on this branch. What shipped, against the spec:

- **Registry**: `packages/lib/src/control-plane/remote-providers.ts`
  (metadata, predicates, selection, the single ingress writer) plus two
  node-side dispatchers the spec's one `RemoteProviderDefinition` split
  into for import-graph acyclicity: `remote-provider-apply.ts`
  (applyConfig dispatch — addons.ts imports it) and
  `remote-provider-status.ts` (fetchStatus — needs compose-args, whose
  chain reaches addons.ts). One naming deviation: the status type shipped
  as **`RemoteAccessStatus`**, because lib already exports a
  `RemoteStatus` from `launch-status.ts`.
- **Profile grammar**: `PROFILE_ID_RE` generalized to arbitrary variant
  suffixes; `resolveHardwareProfileVariant` still admits only
  cpu|cuda|rocm (§2's first blocker).
- **Bare-enable fallback**: `resolveActiveProfiles` gained the
  variant-defaults table (voice/ollama's hard-coded branches folded in;
  `OP_REMOTE_PROFILE` read with the `addon.remote.tailscale` fallback) —
  §2's second blocker. The tunnel service renamed to the variant profile
  with the selector display labels.
- **Special cases → dispatch**: both `if (name === 'remote')
  applyRemoteAccess` sites (addons.ts, credentials route) now call
  `applyRemoteProviderConfig`; `computeGuardianIngressRequired` replaced
  the three dispersed `remoteRequiresGuardianIngress` call sites
  (access-apply.ts, setup.ts, remote-apply.ts); `ensureSecrets` seeds
  from the registry's per-provider `secrets` lists.
- **The card**: `GET /api/host/addons/remote/status` returns the
  vocabulary; `RemoteStatusCard.svelte` renders it (state chip, message,
  action button, copyables with copy buttons, progress list) inside the
  remote drawer in `AddonsTab.svelte`, polling every 5 s — the sign-in
  link and the up-URL now surface in the UI instead of container logs.
  `focusAddon` widened to `'voice' | 'remote'`.
- **Tests**: `remote-providers.test.ts` pins registry↔compose agreement,
  the grammar generalization, the default-provider fallback,
  selection-never-implies-enablement, and computeGuardianIngressRequired's
  agreement with the predicate it consolidated;
  `remote-compose.test.ts` updated for the variant profile + labels.

Deliberately not done in this phase: the QR flag on copyables renders as
a plain copy row (the pairing route's server-side SVG renderer is not yet
extracted); the zero-field drawer collapse (§6's advanced-field demotion)
and the wizard next-step card; the `ADDRESS_HEADER` throttle fix; the
provider selector itself (correctly renders nothing — the registry holds
one entry, and `AddonsTab` shows no selector for remote); the
`remote: {provider, …}` setup-spec shape.

Verification: `bun run lint`, `bun run check`, `bun test packages/lib`
(the 9 pre-existing failures are root-container/network environment
cases in operator-ids/host-identity/opencode-client, present on the base
branch too), and the UI vitest suite (1674 pass; the runner's
browser-shell launch error is a pinned-Playwright environment artifact).
Not covered: a live tunnel round-trip — `fetchStatus`'s mapping of
`AuthURL`/`DNSName` is asserted against `tailscale status --json`'s
documented shape, not a running tailnet.
