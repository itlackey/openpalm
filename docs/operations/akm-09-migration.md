# AKM 0.9 Migration

OpenPalm images pin `akm-cli` `0.9.0-rc.15`. AKM 0.9 changes its config,
reference, task, scheduler, and durable-state formats, so an existing 0.8 home
must cross the boundary through AKM's journaled migrator.

Both images bake AKM into npm's global root. The Assistant's scheduler can
therefore reconstruct missing registrations with plain `akm task sync`; the
explicit `--rebind` below replaces pre-0.9 scheduler bindings during migration.

## Normal OpenPalm Update

Use the normal OpenPalm update command. When the recreated assistant first
starts, its entrypoint runs this sequence before cron or OpenCode starts:

1. Build a separate 0.9 target config from the live 0.8 config.
2. Run `akm migrate status --config <target>`.
3. Run `akm migrate apply --config <target> --dry-run`.
4. Run `akm migrate apply --config <target>`.
5. Run the idempotent legacy storage copy with `akm-migrate storage --from 0.8 --yes`.
6. Run `akm task sync --rebind`, `akm index`, and `akm health`. When
   `/stash/env/user.env` exists, the index step runs as
   `akm env run env/user -- /usr/local/bin/akm index` so configured embedding
   credentials are scoped to that command.

The complete migration/bootstrap sequence has one fixed two-hour outer
deadline. The supervisor sends `TERM`, waits five seconds, then sends `KILL`;
ordinary command exit codes and timeout failures propagate so startup stays
blocked and the retained phase can retry on restart.

AKM creates and verifies its own migration recovery run before replacing config
or databases. The apply journal is crash-resumable. OpenPalm does not overwrite
existing user task files; AKM migrates eligible writable v1 tasks as part of
the coordinated apply.

If an old OpenPalm config has no `configVersion` because AKM 0.8 never opened
it, the entrypoint first snapshots the config and AKM databases under
`data/akm/state/openpalm-pre-0.9-missing-version/`, then atomically adds the
`0.8.0` sentinel required for migration eligibility. The snapshot is assembled
in one deterministic `.stage` directory and atomically published only after all
copies are durable. Interrupted copies resume in that same stage; symlinks and
non-regular stage artifacts fail closed. Existing snapshots are never
overwritten.

The assistant accepts only a missing config version, exact `0.8.0`, or current
`0.9.0`. Any other version fails before target preparation or migration-state
writes. Both the missing-version sentinel and prepared target are written by
same-directory atomic rename after file fsync, followed by parent-directory
fsync. A pending apply always regenerates the target from the live exact-0.8
config, so a torn target cannot wedge restart recovery.

When the old config explicitly sets top-level `writable` to either `true` or
`false`, target preparation materializes that value on the old-shape primary
source. The pinned AKM migrator then carries the exact boolean into the primary
bundle instead of applying its `writable: true` synthetic-stash default.

The assistant fails startup if apply or post-apply verification fails. Once
`akm migrate apply` succeeds, OpenPalm persists `post-apply` and never invokes
AKM restore automatically: apply can rewrite eligible v1 files under
`/stash/tasks/`, while AKM's recovery manifest covers config and databases but
not task files. Restoring only that manifest would create a mixed-version home.
Legacy storage copy, task rebind, index, and health are idempotently retried from
`post-apply` on every restart. Non-empty task-sync `skipped` results remain a
warning; other failures keep startup blocked without undoing the successful
apply.

## Blockers

The automatic target preparation preserves unknown settings but does not move a
literal `profiles.llm.*.apiKey` into an environment variable. AKM 0.9 accepts
only symbolic values such as `${OPENAI_API_KEY}`. If startup reports a literal
API-key blocker, move that credential to `knowledge/env/user.env`, reference the
variable from the AKM config, and restart the assistant.

AKM also blocks migration while another writer or workflow claim is active. Stop
those processes and restart; the retained journal resumes instead of starting
over.

AKM 0.9 removed improve processes such as `recombine` without an equivalent
replacement. Target preparation preserves those process blocks but changes
`enabled: true` to `enabled: false` and logs a warning, preventing an unsupported
process from blocking the rest of the migration or appearing to keep running.

Improve process and judgment `profile` references are resolved according to
their old `mode`: `llm` selects `profiles.llm`, while `agent` and `sdk` select
`profiles.agent` and retain the old SDK platform checks. If the same profile
name exists in both pools, set an explicit mode before restarting. Unsupported
modes, ambiguous references, and mode/platform mismatches fail target
preparation instead of selecting a different engine.

An improve profile containing `autoAccept` also blocks automatic migration.
AKM 0.9 has no exact replacement for the old confidence threshold, so silently
dropping it would change promotion behavior. Before removing the setting,
choose one explicit policy: drain current proposals with
`akm proposal drain --promote --yes`, or configure the migrated strategy's
triage process with `applyMode: "promote"` for future unconditional promotion.
Review the behavioral difference, remove `autoAccept`, and restart.

## Inspection And Recovery

Inspect container logs and the migration state:

```bash
docker compose logs assistant
docker compose exec --user node assistant /usr/local/bin/akm migrate status
assistant_gid="$(docker compose exec -T --user root assistant /usr/bin/id -g node)"
docker compose exec --user root assistant /usr/bin/setpriv --reuid=node --regid="$assistant_gid" --groups=crontab --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- /usr/bin/env PATH=/opt/openpalm/tools/node_modules/.bin:/usr/local/bin:/opt/assistant-tools/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin /usr/local/bin/akm task doctor --format json --quiet
docker compose exec --user node assistant /usr/local/bin/akm health
```

Task reconciliation health is stored in the root-owned
`/run/openpalm/task-sync.status` as bounded status, timestamp, and reason tokens.
The reason is `ok`, `skipped`, or `exit-N`; the assistant healthcheck reports
that reason on failure without persisting AKM output.

Do not delete migration journals manually. To retry a prepared or interrupted
operation, restart the assistant. A retained `apply` phase re-runs AKM's
journaled apply; a retained `post-apply` phase retries storage, reconciliation,
index, and health in order.

Do not run `akm-migrate restore` in response to a post-apply storage, sync,
index, or health failure. AKM's manifest does not restore migrated task files.
A manual downgrade requires an independent, coherent backup that includes
`/stash/tasks/` as well as AKM config and databases; preserve the current home
and obtain operator-specific recovery guidance if that backup is unavailable.
