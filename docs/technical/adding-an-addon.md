# Adding an Addon

How to add a profile-gated service to the stack without creating work for the
next person. Every trap listed here is one this repo actually hit.

## The rule that decides everything: build or pull?

| The service is… | Do this |
|---|---|
| **OpenPalm code** (assistant, guardian, portal, voice) | Build an image in `containers/<name>/` |
| **Third-party software** (ollama, tailscale, paperclip) | **Pull the upstream image, pinned by digest** |

```yaml
image: ollama/ollama:0.31.1@sha256:f1a705f2bd11…
image: ghcr.io/vendor/thing:sha-abc1234@sha256:0480347189…
```

**Do not repackage a third-party app into an `openpalm/*` image.** The moment
you do, you own reproducing someone else's runtime: their agent CLIs, their
system tools, their entrypoint's volume-ownership handling, their startup
prerequisites — and there is no test that tells you when upstream changes any
of it. The paperclip addon was built this way for one revision and shipped two
defects from exactly that: an image with none of the CLIs its adapters spawn
(deployed green, failed every run) and ~560 MB of unloadable binaries.

"Upstream publishes no semver tag" is **not** a reason to build. Pin the digest
— it is stricter than a tag. Reach for a build only if upstream ships no usable
image at all, and write down why.

## Checklist

1. **`addon-ids.ts`** — add the id to `BUILTIN_ADDON_IDS`. Add it to
   `GUARDIAN_INGRESS_ADDON_IDS` / `PORTAL_SECRET_ADDON_IDS` only if it really
   is guardian ingress.
2. **`services.compose.yml`** (or `portals.compose.yml` for ingress) — one
   service, `profiles: ["addon.<id>"]`, `networks: [addon_net]`,
   `user: "${OP_UID:-1000}:${OP_GID:-1000}"`, the standard `json-file` log caps
   (`max-size: 10m`, `max-file: 3`), a healthcheck, and a **literal-loopback**
   published port (`127.0.0.1:${OP_<NAME>_PORT:-38xx}:<container>`).
3. **`addon-env-schemas.ts`** — operator-facing keys only. Not image pins.
4. **Reserve the host port** in `core-principles.md` § Service port assignments.
5. **Add it to `ADDON_SERVICES`** in `addon-network-boundary.test.ts` — the
   canonical S.6b sweep. Skipping this is silent; nothing else catches it.
6. **Document mounts and env** in `environment-and-mounts.md`.

## Traps

**Data directories.** Do **not** add them to `ensureHomeDirs` in `home.ts`.
`ensureComposeVolumeTargets` already pre-creates every compose bind source —
profiled or not — *and* chowns it to the operator UID (issue #452). A bare
`mkdirSync` in `home.ts` is both redundant and weaker. `data/tunnel` is there
only because control-plane code references the path directly; yours probably
doesn't.

**Required files must exist before the addon is enabled.** Compose fails the
**entire project** — including `config`, which every apply runs — when a
profile-active service's `env_file` or declared secret source is missing. Seed
it in `ensureSecrets` (`secrets.ts`), which runs on every install and deploy,
*and* on the enable path for enabling between deploys. That is what
`ts_authkey` and the portal secrets do. Seeding only on enable means the
documented manual route (edit `OP_ENABLED_ADDONS`, rerun compose) bricks the
whole stack, and a migrated or restored home never gets the file at all.

**Networks.** `addon_net` only. Joining `assistant_net` needs a stated reason in
the header comment of `services.compose.yml` — the existing exceptions (ollama
as an LLM provider, tunnel as an ingress path) are the bar.

**Secrets.** Named Compose secrets under `private/secrets/`, exposed as
`*_FILE`. If a third-party image can only read a credential from `process.env`,
that is an exception requiring an audited entry in `secret-audit.ts` and a
matching carve-out in `core-principles.md` — the code and the invariant land in
the same commit, never one without the other.

**Don't hardcode your addon into generic control-plane code** unless there is
no alternative. One `if (name === 'x')` in `addons.ts` or `secret-audit.ts` is
tolerable with a comment explaining why; two is a signal to generalize into a
declaration table. Share constants between whoever writes a file and whoever
audits it — two private copies of the same key list will silently diverge.

**Version pins.** Image pins live in the compose file (third-party, digest) or
`versions.ts` (OpenPalm-built). Not in the addon env schema, and not duplicated
across four files with a test to keep them agreeing.

## Tests that are worth writing

Assert properties a plausible edit can violate. A test that checks a file
contains strings that file contains cannot fail — one of those sat green while
the image it "covered" was unusable.

Good: the image reference is digest-pinned; the service is on `addon_net` only;
the published port is literal loopback; security-relevant env is set explicitly
rather than inherited from a third-party image default.

## Done means

`bun run lint`, `bun run check`, and `bun run test` pass; the addon enables and
disables through `openpalm addon enable/disable <id>` **and** by hand-editing
`OP_ENABLED_ADDONS`; and `core-principles.md` describes what the code actually
does.
