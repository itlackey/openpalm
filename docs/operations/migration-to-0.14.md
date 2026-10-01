# Moving to OpenPalm 0.14

0.14 is a deliberate fresh-install boundary. It does not upgrade a 0.13 or
legacy OpenPalm home in place.

The implemented transition is a dry-run-first, allowlisted copy into a fresh
home. The old home is only a read-only source: OpenPalm neither upgrades it nor
deletes it.

An upgrade should preserve your conversations and authored work, not merely
start healthy containers. **Portable import is only one part of migration.**
It does not restore native OpenCode history, external work directories, runtime
snapshots or old portal conversation handles. Use the separate native-history
recovery below, and account for every other required source before cutover.

The preservation inventory, acknowledgements, private import receipts and
`openpalm history` commands described here are on the lean branch **after
beta.1**. They are not available in the immutable beta.1 release. Use a build
containing these changes; do not assume an older binary supports these flags.

**Alpha.2 migration boundary:** The hardening described below is included in
`0.14.0-alpha.2` and later; it is not retroactively included in
`0.14.0-alpha.1`. That release stages old `config/akm/` under searchable
knowledge and misses provider `{file:...}` secrets. Do not run an unchecked
alpha.1 migration: use alpha.2 or later, or carefully review manual
staging and keep historical configuration outside every agent mount. Concise
import summaries and generated-dependency pruning also require alpha.2 or later.

## Why the break exists

Older OpenPalm releases accumulated services, configuration formats, generated
state, migrations, and compatibility code that are unrelated to the personal
agent product. Reconstructing 0.14 from those internals would carry the same
complexity into the new stack.

Preserve the user's knowledge, conversations, schedules and authored working
files while regenerating runtime configuration and access authority. A fresh
install plus reviewed recovery keeps those concerns separate.

## Supported flow

1. Inventory the old home, exact containers, published ports, named volumes,
   external mounts, and client connections. Leave unrelated instances alone.
2. Download the intended released CLI and images before the cutover.
3. Stop only the old instance's containers and make a verified cold backup.
4. Preserve the old home, containers, volumes, and CLI for rollback.
5. Install into a different, empty `OP_HOME` with a distinct Compose project.
6. Preserve native history privately; inventory required external work and artifacts.
   Preview the portable import with the exact secret/map opt-ins you intend to apply.
7. Recreate named Guardian credentials required by selected maps, then apply
   only the reviewed allowlist.
8. Recover native conversations into the stopped new instance, then complete
   provider setup and its real readiness check before enabling portals.
9. Review imported schedules and test each access path independently.
10. Retire old proxy routes separately after acceptance; never delete the old
    home or backup as part of migration.

Do not run old and new stacks against the same writable directories.

### Select the actual release and instance

Download the platform CLI binary from the intended
[GitHub release](https://github.com/itlackey/openpalm/releases) and verify its
published checksum. Run it by absolute path and check `--version` before any
write. For example, an alpha test must report the selected alpha, not the old
stable release. Bare `openpalm`, `npm exec`, or `npx` can resolve an existing
workspace/global installation; requesting a package version is not proof of
which executable ran. Follow that release's notes for preview limitations.

The examples below use `OP_CLI` as the absolute path to that verified binary:

```bash
export OP_CLI=/absolute/path/to/released-openpalm
"$OP_CLI" --version
export OP_HOME=/absolute/path/to/new-openpalm
export OP_PROJECT_NAME=openpalm-new
"$OP_CLI" install --no-start
"$OP_CLI" import --from /absolute/path/to/old-openpalm --dry-run
"$OP_CLI" import --from /absolute/path/to/old-openpalm --apply --acknowledge-unrestored
# Recover native history as described below, before completing setup.
"$OP_CLI" setup
```

Use the same opt-ins on preview and apply. Import requires an installed but
not-yet-completed fresh home; do not run `setup` before applying the import.
The CLI recomputes the plan at apply time; a separate preview does not freeze
the source or persist an approval digest. Keep the old instance stopped and
preview again if any source content or destination configuration changes.
`OP_PROJECT_NAME` is persisted on first install and must not match another
home's project. If both instances will run simultaneously, choose unused
Assistant and Guardian ports with `config ... --no-apply` before setup.

`OP_HOME` selects an instance for **every** later command. Without it, the CLI
defaults to `~/.openpalm`, which may still be the preserved old home. A private
shell alias or wrapper can bind the verified binary and home for convenience;
a name such as `openpalm-personal` is host-local, not an OpenPalm command or
installed product feature. Inspect it before use and ensure its selected
binary still reports the intended version. The explicit equivalent is:

```bash
OP_HOME=/absolute/path/to/new-openpalm "$OP_CLI" status
```

### Make a complete rollback backup

`openpalm backup` is a **portable 0.14 recovery source**, not a complete backup
of an older runtime. A rollback snapshot must cover the entire stopped old
home, plus named volumes and external mounts identified in the inventory.
Preserve their paths and ownership, the old CLI version, container IDs, image
references, and network bindings. Do not copy a live database and call it a
verified snapshot.

Use an operator-owned private backup directory outside both homes. On Linux,
GNU tar's sparse-file support avoids inflating large sparse runtime files:

```bash
OLD_HOME=/absolute/path/to/old-openpalm
BACKUP=/absolute/path/to/new-private-backup
mkdir -m 700 "$BACKUP"
sudo tar --sparse -cpf "$BACKUP/old-home.tar" \
  -C "$(dirname "$OLD_HOME")" "$(basename "$OLD_HOME")"
sudo chmod 600 "$BACKUP/old-home.tar"
sudo tar --compare --file "$BACKUP/old-home.tar" \
  -C "$(dirname "$OLD_HOME")"
sudo sha256sum "$BACKUP/old-home.tar"
```

These are scoped backup operations, not commands to delete or restore data.
Use privilege only when required for root-owned historical state; do not
recursively change the old home's ownership. Retain the checksum privately and
check it again before recovery. Archive each named volume separately using a
read-only source mount or your volume-backup tool; a home archive cannot cover
data stored only in Docker volumes. Account for both allocated disk usage and
logical file sizes, and test readability/integrity before proceeding.

Tar preserves a symlink itself, **not its target's data**. A matching tar
comparison proves the archive matches tar's selection, not that the inventory
is complete. Before calling rollback coverage complete:

1. Inspect each recorded container's actual Docker mounts, not only Compose
   declarations: `docker inspect <exact-container-id> --format '{{json .Mounts}}'`.
2. Record each bind's physical source and each named volume's name. Resolve
   links with `readlink -f /exact/inventoried/source` (or the platform equivalent).
   Do not blanket-follow links or traverse unrelated host folders.
3. Archive each required external physical source separately while stopped,
   using the same private archive, comparison and checksum procedure. Record
   the link, resolved source, owning instance, artifact path, byte size, checksum
   and verification result in a private recovery manifest.
4. Include native data, snapshots and required authored tools/work outside
   `workspace/`; classify generated material rather than blindly copying it.
5. Check both coverage (every required source has an artifact) and integrity
   (each artifact verifies). Preserve source ownership; never run two instances
   against the same writable database or project directory.

Do not claim complete rollback from a home tar plus a volume tar if an external
runtime source remains uncovered. The CLI's folder inventory cannot discover
every Docker mount, remote repository or externally referenced artifact.

Protect backups as secrets: old configuration backups, environment files,
provider tokens, and retired service databases may all contain credentials.
Never place them in agent-searchable knowledge, public artifacts, or Git.

For an already-running 0.14 home, create a portable recovery source with:

```bash
openpalm backup --to /absolute/path/to/new-or-empty-backup
```

The resulting directory follows the same allowlisted layout accepted by the
importer and includes an integrity manifest. Secrets and identity maps remain
explicit opt-ins.

Its manifest and completion receipt explicitly identify `scope: portable` and
the omitted categories. Native history needs its own private archive; a
portable backup is neither a complete runtime snapshot nor full rollback.

## Import contract

The 0.14 CLI provides:

```bash
openpalm import --from /path/to/old-home --dry-run
openpalm import --from /path/to/old-home --dry-run --json
openpalm import --from /path/to/old-home --apply
```

Dry-run is also the default when neither flag is supplied. The implementation:

- dry-run is the first documented action;
- the source is opened read-only and never modified;
- the default preview shows category/action counts, bounded conflict examples,
  and grouped warnings; `--dry-run --json` exposes every candidate source and
  destination path and warning for full review;
- a prominent preservation inventory shows selected portable categories,
  detected runtime sources and skipped links, and categories the folder scan
  cannot discover. High-impact omissions do not disappear in warning groups;
- if runtime data or skipped portable links are detected, apply is blocked
  until `--acknowledge-unrestored` explicitly confirms separate preservation or
  deferred recovery. This acknowledgement does not restore history or prove
  backup coverage; Admin offers the same unchecked acknowledgement;
- portable 0.14 backups are checked against their integrity manifest before
  any candidate is accepted;
- existing destination files are preserved and any non-pristine conflict
  blocks the entire apply;
- imports are restricted to an explicit allowlist;
- secrets require a separate opt-in and never appear in output;
- task definitions are staged outside `knowledge/tasks/` and require review;
  adoption installs them in paused state; and
- the operation is safe to rerun while the destination remains in fresh setup.

Copied files are verified by SHA256. A private portable-import receipt is kept
under `state/import-receipts/`. Selected-file counts do not imply that all old
user data was found or that the whole migration is complete.

### Preservation decisions

| Category | Portable import | Required decision/check |
|---|---|---|
| Authored knowledge and workspace | Selected files, byte counts and hashes | Compare source/destination; inspect Git status, submodules and worktree references |
| Tasks | Staged inactive | Review, adopt paused, run, inspect durable result, then resume |
| Native conversations | Separate `history` operation | Same instance/owner, mapped directories, message/part content and client visibility |
| Runtime snapshots, tools, referenced artifacts | Not portable | Private backup; recover required authored scope only; transcripts do not restore undo state |
| Symlink targets, external binds, named volumes | Not followed/discovered automatically | Exact physical-source inventory and separate verified private artifacts |
| Secrets, identity maps and customization | Reviewed opt-ins/manual recreation | Fresh policies and keys; no automatic executable activation |
| Portal handles and ownership grants | Not restored | Reconnect clients; imported native history is not old portal continuity |
| Generated dependencies/cache | Excluded | Reinstall dependencies separately using lockfiles; verify required projects |

Record restored, privately preserved, pending and deliberately excluded items
in your private acceptance receipt. An unknown or pending category is not
"fully recovered" merely because the portable copy succeeded.

## Native conversation recovery

`openpalm history` is separate from portable import. It works before setup and
for an already initialized 0.14 home, provided that selected stack is stopped.
It does not upgrade an old runtime database in place or import old access grants.

For a same-owner continuation of one instance:

```bash
# Old instance stopped; exact old trusted image already installed locally.
"$OP_CLI" history export --from /absolute/path/to/old-openpalm \
  --image openpalm/assistant:0.13.6 \
  --to /absolute/path/to/private-history
```

Use the source instance's actual image, not the example version. The default
source is `data/assistant/.local/share/opencode/opencode.db`. If its runtime
is linked or externally mounted, select only the inventoried resolved OpenCode
data directory explicitly with `--runtime /exact/resolved/opencode-directory`.
No implicit symlink following or arbitrary old mount activation occurs.

Export creates a consistent standalone SQLite snapshot including committed WAL
data, validates its integrity, and uses the source native engine to export all
sessions into regular private JSON files. The one-off non-root container is
offline, plugins disabled, with no original configuration or project mounts.
The image is resolved to its local immutable ID; recovery never installs
software or starts the old agent. The archive includes raw private transcripts
and a source snapshot: **treat it as a secret, not searchable knowledge**.

Review `history.json` for session/message/part counts and old directories. Create
a private JSON map with one exact entry per old directory, for example:

```json
{
  "/old/assistant/home": "/work",
  "/old/project": "/work/project",
  "/work": "/work"
}
```

Every destination must be `/work` or an existing contained subdirectory with
no symlink. Restore authored files there first. Mapping to an empty folder
allows transcript viewing only; it does not restore project contents or make
the old execution environment usable. Never map an unknown external project
automatically or mount an entire secret-bearing bundle just to resolve a path.

```bash
# OP_HOME still selects the NEW instance.
"$OP_CLI" stop
"$OP_CLI" history restore --from /absolute/path/to/private-history \
  --directory-map /private/path/to/directories.json
"$OP_CLI" history restore --from /absolute/path/to/private-history \
  --directory-map /private/path/to/directories.json --apply --same-instance
"$OP_CLI" start
```

Preview is the default. It retains private verification files and a consistent
target-before snapshot under `state/history-recovery/`; it does not import into
the destination database. Before target writes, both preview and apply run the
entire batch through the target's native importer on a temporary database,
verify transcript content, and check existing target sessions are unchanged.
Old session permissions, sharing, ownership metadata, parent links, system
overrides and revert authority are not activated. Historical tool output and
referenced paths remain transcript content, not restored files or authorization.

Apply requires explicit `--same-instance` confirmation; never mix unrelated
instances' histories. Conflicting session/message/part IDs are rejected rather
than overwritten. A private per-session intent journal permits safe retry of
the same interrupted operation. Verified repeated imports do not duplicate or
overwrite later work in recovered conversations. If content conflicts, stop
and investigate; do not bypass the check or delete target sessions.

Interrupted tool calls are preserved in the private export, but blocked from
restoration for manual review rather than activated as pending work. Unsupported native
formats/engines also fail without modifying the source; retain the private
snapshot and original for recovery. The implemented path supports SQLite-based
OpenCode history, with bounded processing (10,000 sessions per side, 256 MiB
per export and 20 GiB exports/database). It is not an old JSON-storage converter,
undo-snapshot importer or portal-history bridge. Compatibility is checked by
native round-trip, not presumed for every earlier release.

After restart, verify every recovered session's ID, mapped directory, messages,
parts and representative content through the authenticated API and intended
native client. Verify directory/project discovery, not only direct session IDs.
Compare pre-existing destination sessions against the private before exports.
The recovery receipt records counts, mappings and limitations; counts alone are
not sufficient proof of content preservation or resumable project work.

### Repeatable migration verification

Run the portable and native regressions with synthetic homes only:

```bash
bun test packages/lib/src/control-plane/import.test.ts \
  packages/lib/src/control-plane/backup.test.ts \
  packages/cli/src/commands/import.test.ts
OPENPALM_HISTORY_TEST_IMAGE=openpalm/assistant:0.14.0-beta.1 \
OPENPALM_HISTORY_SOURCE_IMAGE=openpalm/assistant:0.13.6 \
  bun test packages/lib/src/control-plane/history.test.ts
OPENPALM_ADMIN_E2E_KEEP_HOME=true bun run admin:e2e
```

Use locally installed images for the exact releases under test. Without the
image environment variable, the two Docker-dependent history tests are skipped;
GitHub's Assistant-image gates explicitly run them against the just-built native
image on amd64 and arm64. Cross-version testing can choose a separate old image
as above; do not presume support for an untested format.

Verified on October 1, 2026 with synthetic 0.13.6 → beta.1 engine data:
WAL-inclusive export, private archive permissions, explicit mappings, whole-batch
native preflight, collision rejection before writes, stripped session permissions,
preserved target conversations, partial-import retry, later-work preservation,
tamper rejection, preservation without activation of unfinished calls, and
authenticated API discovery/content. Evidence was retained
at `/tmp/openpalm-history-e2e-j6j8j8`. The standalone built CLI also passed export,
preview and repeat-apply against a retained synthetic fixture.

The real Admin walkthrough verified visible omitted-history disclosure,
default-blocked apply, explicit acknowledgement and a verified portable-file
copy. Its report is `/tmp/openpalm-admin-e2e-artifacts-9b5mgZ/report.json`, with
the visible review captured in `02c-migration-preservation.png`. The private
synthetic home was retained at `/tmp/openpalm-admin-e2e-tEyvfz/home`; its test
containers were removed. Typechecking, lint, CLI/Admin builds and the full
regression suite passed; the separately enabled native tests also passed.
This is not a new migration of Splinter/Fwdslsh, a provider-authentication signoff,
an undo-snapshot recovery, or proof that every external project builds. Existing
lab instances and their data were not changed. No production originals were
deleted; test containers are disposable and private native recovery files remain
available for inspection.

The refinements respond to the
[lab preservation investigation](https://reports.lab.fwdslsh.dev/incidents/openpalm-migration-data-preservation-20261001.html).

## Default portable data

The default import may copy:

- AKM-authored knowledge, skills, lessons, memories, and other user bundle
  content under `knowledge/`;
- task definitions under `knowledge/tasks/`, staged as disabled;
- user files under `workspace/`; and
- supported non-secret Assistant preferences after validation.

Automatic native OpenCode configuration import/backup accepts only the
top-level `$schema`, `model`, `small_model`, and `provider` fields. If any other
top-level setting is present, the entire config is omitted with a warning,
even with provider-auth opt-in. This prevents automatic activation of old MCP
connections, plugins, or custom instructions and accidental copying of their
credentials. The full old-home backup preserves the original; review and
deliberately reintroduce desired customization before activation. OpenCode's
normal runtime customization remains supported—there is no new registry or
configuration translation layer.

Old `config/akm/` is neither imported nor included in portable backups. Even
historical configuration copies can contain credentials. Fresh installation
regenerates managed AKM runtime/scheduler settings; keep any old configuration
needed for human reference only in the protected full rollback backup, outside
all Assistant mounts. Do not relocate it into searchable knowledge.

Generated `node_modules/` trees are omitted from knowledge/workspace portable
copies with a directory-level warning. Reinstall project dependencies using
each project's lockfile after import. Other symlinks are reported and not
followed. This preserves source files without recreating incomplete linked
dependency trees or filling the plan with thousands of dependency entries.
The source home is untouched. The importer retains safety ceilings of 100,000
files, 256 MiB per file, and 20 GiB total; review the summary before apply rather
than raising limits merely to import generated data.

The bundled AKM 0.9.20 uses host-local scheduler activation rather than
`schedule[].enabled`. An old v4 task containing that retired field needs
reviewed AKM migration before adoption; do not copy old scheduler activation
into the fresh configuration. Adoption removes any stale local activation
before publishing the validated prompt source and leaves it paused.

The importer must distinguish authored knowledge from credentials, environment
files, generated indexes, caches, databases, and run state. Being below
`knowledge/` is not sufficient by itself to make a file safe to activate.

## Explicit opt-ins

The user may separately choose to import:

- OpenCode provider credentials from `knowledge/secrets/auth.json` and supported
  native provider `{file:/stash/secrets/...}` references;
- AKM user environment values from `knowledge/env/user.env`;
- supported Discord and Slack user-to-credential maps; and
- supported Guardian OAuth settings and issuer/subject maps.

Secret import must verify private destination permissions. Portal and OAuth
maps cannot become active until every referenced named credential has been
recreated in the new registry.

Provider re-authentication is the preferred default. Importing `auth.json` is a
convenience for a same-owner, same-trust-machine transition, not an automatic
step. Referenced provider files must be regular files safely contained below
the source `knowledge/secrets/`; external paths and symlink escapes are refused.
Only referenced provider files are included, not the entire secrets directory.
Review the preview for missing or unsupported references; sign in again rather
than broadening the secret boundary or copying unrelated credentials.
Native provider configuration, `auth.json`, and referenced provider files are
limited to 1 MiB each; at most 128 file references are accepted. Native
provider preferences containing inline credentials also require the
provider-auth opt-in even when they otherwise satisfy this allowlist; ordinary
non-secret imports must not carry those values
into searchable knowledge or default backup output.

OpenCode may refresh provider authentication after startup, changing
`auth.json` from its imported checksum. Verify the copy before startup and
distinguish subsequent native authentication updates from import corruption.
Refreshing or rotating a provider token can invalidate the old token: retaining
the old home does not guarantee its provider session will still work on
rollback. Be prepared to sign in again through OpenCode.

The opt-ins are explicit:

```bash
openpalm import --from /path/to/old-home --apply --acknowledge-unrestored \
  --include-provider-auth \
  --include-user-env \
  --include-portal-maps \
  --include-oauth
```

## Never imported

0.14 must not import or infer runtime intent from:

- `system/`;
- `state/`, including old stack intent and delegated keys;
- `data/`, including service databases, caches, logs, and scheduler state;
- old `config/akm/`, configuration backups, or local scheduler activation;
- old Compose files or image pins;
- Docker containers, volumes, or networks;
- UI, voice, model-server, VPN, discovery, Paperclip, A2A, compatibility API,
  or other retired feature settings;
- legacy admin sessions or server state; or
- unknown files merely because an older release created them.

Native OpenCode databases are not wholesale copied by portable import. Recover
transcripts through the separate native-history operation; authored AKM session
snapshots in knowledge are not native history. External host AKM bundles and old custom OpenCode plugins, tools,
skills, themes, instructions, or config-level `AGENTS.md` files are not
automatically mounted or activated. Review and deliberately reintroduce only
what the new agent actually needs; do not copy old configuration wholesale.

Named Guardian credentials are recreated so the operator makes a new policy
decision and clients receive new keys. The importer does not copy old bearer
keys. The native OpenCode password is also fresh. Use `connect opencode` and
`connect mcp --credential <name>` for the new private file paths and update
every client, including the Claude Desktop extension.

## Recreate network and portal access

Fresh defaults are loopback-only, with Guardian and portals disabled. Recreate
the intended access, not the old published port list. Trusted native OpenCode
intentionally bypasses Guardian. If LAN access is required, select the exact
host LAN address, not an accidental wildcard bind:

```bash
"$OP_CLI" config assistant --bind 192.168.1.10 --port 3810 --no-apply
"$OP_CLI" addon enable gateway --no-apply
"$OP_CLI" setup
"$OP_CLI" connect opencode
"$OP_CLI" connect mcp --credential owner
```

Replace the example address with the host's actual address. Native HTTP Basic
authentication is not transport encryption; use only a trusted private network
or operator-managed TLS, never direct public HTTP. Guardian can stay loopback
even when native OpenCode is on the LAN. Test the bind from a second LAN device
and verify unauthenticated native requests are rejected.

Old portal tokens are not an import category. With the operator's approval,
reuse each exact token file through the secret-aware CLI; never print the token
or copy old `state/` wholesale. For owner-only Discord access, obtain the owner's
user ID from Discord and deliberately configure it:

```bash
"$OP_CLI" portal token discord --bot-token-file /private/path/to/old-bot-token --no-apply
"$OP_CLI" portal access discord --users 123456789012345678 --no-apply
"$OP_CLI" config portal discord --credential discord --no-apply
"$OP_CLI" addon enable discord
"$OP_CLI" portal show discord
```

An empty old allowlist must not become unrestricted access: alpha is
default-deny. Owner-only DM access leaves guild/role constraints empty. Bot
ownership does not itself grant access, and team-owned bots require a human
choice of allowed users. Slack likewise requires an explicit user/channel
scope plus bot/app tokens; see the [Discord](../portals/discord-setup.md) and
[Slack](../portals/slack-setup.md) guides.

The default portal credential uses `chat`, which denies tools; connecting a
bot does not grant it knowledge reads or recurring-work management. If a
specific trusted user needs those capabilities, make the policy choice explicit:

```bash
"$OP_CLI" credential add personal-operator full
"$OP_CLI" credential map discord 123456789012345678 personal-operator
```

Mappings never bypass allowlists. Verify gateway login/intents, an allowed
message, a denied user, and the intended policy separately. A healthy container
or connected bot alone is not an end-to-end portal test.

Voice, Paperclip, browser-chat, compatibility API, and other retired services
are not recreated. Stop only the inventoried old services at cutover and retain
their data. Operator-owned reverse-proxy/DNS routes are not changed by the
importer and may return errors until deliberately retired or repointed.

## Schedule review

Schedules can cause network access, file changes, and repeated external side
effects. Imported task definitions therefore remain inactive until the user
can see, for each task:

- its human-readable purpose;
- schedule and timezone;
- agent policy;
- inputs and destinations;
- required secrets;
- commands or tools it may use; and
- where results and errors will be retained.

Unsupported task filenames are reported, not rewritten or enabled silently.
Only declarative `akm/command` prompt tasks can be adopted. Command and
workflow tasks must be manually recreated so imported files cannot introduce
an unattended executable path. Review and adopt a staged prompt task with:

```bash
openpalm task adopt "$OP_HOME/knowledge/imported-tasks/example.yml"
openpalm task show example
openpalm task run example
openpalm task history example
openpalm task resume example
```

Adoption leaves the task paused. A manual run is a real execution: approve its
side effects first, then inspect both history and the retained result before
resuming a recurring schedule. Old `*.bak` or retired task formats remain in
the original home/backup and may be reported as unsupported; recreate their
purpose in ordinary language instead of enabling arbitrary shell/workflow
engines. The number of staged tasks depends on the source, not the release.

## Completion check

Migration is complete only after:

- a provider request succeeds;
- imported knowledge can be found by the agent;
- a reviewed test schedule runs and stores a result;
- a trusted OpenCode client reconnects;
- every enabled MCP or portal identity receives the intended policy; and
- required native history is content-verified and discoverable in its intended
  project/client, with pre-existing destination sessions preserved;
- workspace hashes, Git changes/references, required external authored work,
  dependencies and task activation have separate acceptance results; and
- the private recovery manifest covers every required physical source, with
  verified artifacts and explicit decisions for pending/excluded categories.

Use `status`, `doctor --readiness`, `provider test`, and `connect` with the new
home and verified CLI. Also inspect the actual container mounts and ports:
Assistant must receive neither the Docker socket nor delegated Guardian/portal
keys; no managed service should run as root or add capabilities. Verify a real
knowledge lookup, a bounded task run plus durable result, credential-scoped MCP
access, and any enabled portal using the user-chosen allowlist. Confirm unrelated
instances are unchanged and old scheduled work is not also running.

## Rollback

Keep a private record of the exact old container IDs, volume locations, image
references, CLI path, ports, and verified backup checksums. To return to the
preserved instance:

1. Stop the new instance using its explicit `OP_HOME` and released CLI; do not
   delete its home or volumes.
2. Confirm its published ports and Discord/Slack login are no longer active.
3. Restart only the preserved old containers by their recorded IDs, or use the
   preserved old CLI/Compose configuration if recreation is required.
4. Verify old provider readiness, portal access, and schedules. Reauthenticate
   if provider token refresh/rotation invalidated the old sign-in.

If restoration from the archive is necessary, verify checksums first and
restore into a separate recovery location for inspection. Do not extract over
either home or overwrite a volume without a separately approved recovery plan.

After acceptance, removing the old home is a separate user decision. OpenPalm
never deletes it as part of import.
