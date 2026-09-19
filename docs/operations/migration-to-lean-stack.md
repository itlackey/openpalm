# Moving to OpenPalm 0.14

0.14 is a deliberate fresh-install boundary. It does not upgrade a 0.13 or
legacy OpenPalm home in place.

The implemented transition is a dry-run-first, allowlisted copy into a fresh
home. The old home is only a read-only source: OpenPalm neither upgrades it nor
deletes it.

## Why the break exists

Older OpenPalm releases accumulated services, configuration formats, generated
state, migrations, and compatibility code that are unrelated to the personal
agent product. Reconstructing 0.14 from those internals would carry the same
complexity into the new stack.

The valuable data is much smaller: the user's AKM knowledge, schedules,
working files, and a small allowlist of intentional configuration. A fresh
install plus explicit import makes that boundary visible and recoverable.

## Supported flow

1. Stop the old stack.
2. Make and verify a complete backup of the old `OP_HOME`.
3. Leave that home unchanged as the rollback source.
4. Install 0.14 into a different, empty `OP_HOME`.
5. Preview the import from the old home.
6. Recreate any named Guardian credentials referenced by maps you intend to
   import.
7. Apply only the reviewed allowlist.
8. Sign in to the AI provider and pass the 0.14 readiness check.
9. Review imported schedules before enabling them.
10. Verify each access path independently.

Do not run old and new stacks against the same writable directories.

## Import contract

The 0.14 CLI provides:

```bash
openpalm import --from /path/to/old-home --dry-run
openpalm import --from /path/to/old-home --apply
```

Dry-run is also the default when neither flag is supplied. The implementation:

- dry-run is the first documented action;
- the source is opened read-only and never modified;
- every candidate source and destination path is listed before copying;
- existing destination files are preserved and any non-pristine conflict
  blocks the entire apply;
- imports are restricted to an explicit allowlist;
- secrets require a separate opt-in and never appear in output;
- task definitions are staged outside `knowledge/tasks/` and require review;
  adoption installs them in paused state; and
- the operation is safe to rerun.

## Default portable data

The default import may copy:

- AKM-authored knowledge, skills, lessons, memories, and other user bundle
  content under `knowledge/`;
- task definitions under `knowledge/tasks/`, staged as disabled;
- user files under `workspace/`; and
- supported non-secret Assistant preferences after validation.

Old AKM configuration is copied to `knowledge/imported-config/akm/` for manual
reference. It is not activated because 0.14 owns the scheduled engine boundary.

The importer must distinguish authored knowledge from credentials, environment
files, generated indexes, caches, databases, and run state. Being below
`knowledge/` is not sufficient by itself to make a file safe to activate.

## Explicit opt-ins

The user may separately choose to import:

- OpenCode provider credentials from `knowledge/secrets/auth.json`;
- AKM user environment values from `knowledge/env/user.env`;
- supported Discord and Slack user-to-credential maps; and
- supported Guardian OAuth settings and issuer/subject maps.

Secret import must verify private destination permissions. Portal and OAuth
maps cannot become active until every referenced named credential has been
recreated in the new registry.

Provider re-authentication is the preferred default. Importing `auth.json` is a
convenience for a same-owner, same-trust-machine transition, not an automatic
step.

The opt-ins are explicit:

```bash
openpalm import --from /path/to/old-home --apply \
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
- old Compose files or image pins;
- Docker containers, volumes, or networks;
- UI, voice, model-server, VPN, discovery, Paperclip, A2A, compatibility API,
  or other retired feature settings;
- legacy admin sessions or server state; or
- unknown files merely because an older release created them.

Named Guardian credentials are recreated so the operator makes a new policy
decision and clients receive new keys. The importer does not copy old bearer
keys.

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
openpalm task resume example
```

## Completion check

Migration is complete only after:

- a provider request succeeds;
- imported knowledge can be found by the agent;
- a reviewed test schedule runs and stores a result;
- a trusted OpenCode client reconnects;
- every enabled MCP or portal identity receives the intended policy; and
- the complete old home still exists as a restorable backup.

After acceptance, removing the old home is a separate user decision. OpenPalm
never deletes it as part of import.
