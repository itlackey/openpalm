# AKM 0.9 Migration

OpenPalm images pin `akm-cli` `0.9.0-rc.13`. AKM 0.9 changes its config,
reference, task, scheduler, and durable-state formats, so an existing 0.8 home
must cross the boundary through AKM's journaled migrator.

## Normal OpenPalm Update

Use the normal OpenPalm update command. When the recreated assistant first
starts, its entrypoint runs this sequence before cron or OpenCode starts:

1. Build a separate 0.9 target config from the live 0.8 config.
2. Run `akm migrate status --config <target>`.
3. Run `akm migrate apply --config <target> --dry-run`.
4. Run `akm migrate apply --config <target>`.
5. Run the idempotent legacy storage copy with `akm-migrate storage --from 0.8 --yes`.
6. Run `akm task sync --rebind`, `akm index`, and `akm health`.

AKM creates and verifies its own migration recovery run before replacing config
or databases. The apply journal is crash-resumable. OpenPalm does not overwrite
existing user task files; AKM migrates eligible writable v1 tasks as part of
the coordinated apply.

If an old OpenPalm config has no `configVersion` because AKM 0.8 never opened
it, the entrypoint first snapshots the config and AKM databases under
`data/akm/state/openpalm-pre-0.9-missing-version/`, then atomically adds the
`0.8.0` sentinel required for migration eligibility. Existing snapshots are
never overwritten.

The assistant fails startup if migration or health verification fails. This is
intentional: the stack update remains unhealthy and can use its normal rollback
path rather than starting cron and OpenCode against partially migrated state.

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

## Inspection And Recovery

Inspect container logs and the migration state:

```bash
docker compose logs assistant
docker compose exec assistant akm migrate status
docker compose exec assistant akm task doctor
docker compose exec assistant akm health
```

Do not delete migration journals manually. To retry a prepared or interrupted
operation, restart the assistant. If AKM reports that restoration is required,
follow the run id and exact restore command printed by AKM. The underlying
command is:

```bash
akm-migrate restore --for 0.9.0 --run <run-id> --confirm
```

Restore the migration recovery run before reinstalling a 0.8 binary.
