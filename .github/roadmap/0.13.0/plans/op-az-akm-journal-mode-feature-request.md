# Upstream AKM feature request (ready to file)

> Deliverable for the `op-az` ACA plan (§5a / §11). This is the prerequisite that lets
> `data/akm/data` live on the shared NFS volume instead of an ephemeral carve-out.
>
> **Filing status:** NOT yet filed. This session's GitHub write scope is limited to
> `itlackey/openpalm` (read/search to `itlackey/akm` works; issue creation is denied), and
> no `add_repo` tool is available to expand scope. File manually at
> <https://github.com/itlackey/akm/issues/new> by pasting the title + body below.
>
> Duplicate-checked against `itlackey/akm` issues on 2026-06-19: related SQLite robustness
> work exists (#586 → backport #589 raised `busy_timeout` to 30s; #584/#585 fixed
> `index.db` handle / `SQLITE_BUSY`) but **no existing issue covers a configurable journal
> mode / network-filesystem support.**

---

**Title:**

`Configurable SQLite journal mode (e.g. AKM_SQLITE_JOURNAL_MODE) so AKM can run on network filesystems (NFS/SMB)`

**Body:**

## Summary

AKM opens its SQLite databases with `PRAGMA journal_mode = WAL` unconditionally and exposes no way to override it. **WAL mode does not work on any network filesystem** (NFS, SMB/CIFS), so AKM cannot run safely when its data directory is backed by network storage. Please add a way to select a rollback-journal mode (`DELETE`/`TRUNCATE`) — ideally an env knob such as `AKM_SQLITE_JOURNAL_MODE`, and/or auto-detection of a network FS that falls back to `DELETE` with a warning.

## Motivation / where this bites

We're designing **OpenPalm on Azure Container Apps (ACA)**, where the only persistent volume options are ephemeral container storage or **Azure Files** (SMB or NFS) — ACA has no block-disk volumes. To keep OpenPalm's "all state under `OP_HOME` as plain files" model, `OP_HOME` (including `data/akm/data`) is mounted from an Azure Files share. Every other component is network-FS-safe (config/secrets are plain files; OpenCode session state is flat JSON). **AKM's forced WAL is the single blocker** preventing the AKM database subtree from living on the share, which currently forces an awkward carve-out (running the DBs on ephemeral storage and losing `state.db` history on container restart).

This is not ACA-specific — it affects anyone running AKM with `AKM_DATA_DIR` on NFS/SMB (Kubernetes networked PVCs, NAS-backed homes, Docker volumes over a network mount, etc.).

## Why WAL specifically fails on a network FS

WAL requires a `-shm` shared-memory wal-index that **all database connections on the same host mmap together**; a network filesystem cannot back that mmap. This is the SQLite project's documented position:

> "WAL does not work over a network filesystem."
> — SQLite, *Write-Ahead Logging* — https://sqlite.org/wal.html

Related SQLite guidance:
- *SQLite Over a Network* — https://sqlite.org/useovernet.html ("fcntl() file locking is broken on many NFS implementations"; ensure only one client/host accesses the DB)
- *How To Corrupt An SQLite Database File* — https://sqlite.org/howtocorrupt.html
- *File Locking And Concurrency* — https://sqlite.org/lockingv3.html
- `SQLITE_IOERR_SHMMAP` result code — https://sqlite.org/rescode.html

Symptoms when WAL is placed on a network mount range from `disk I/O error` / `SQLITE_IOERR_SHMMAP` at open time to divergent/torn writes. Field reports corroborate this and the common fix:
- "SQLite on Azure Files SMB: A Debugging Story" — https://dev.to/argha_dev/sqlite-on-azure-files-smb-a-debugging-story-with-a-humbling-ending-1p93
- charmbracelet/crush #473 (SQLite fails on SMB) — https://github.com/charmbracelet/crush/issues/473
- Simon Willison, "SQLite WAL across Docker containers sharing a volume" (2026-04-07) — https://simonwillison.net/2026/Apr/7/sqlite-wal-docker-containers/
- GoToSocial — SQLite on networked storage — https://docs.gotosocial.org/en/latest/advanced/sqlite-networked-storage/

The community-standard recommendation for SQLite on network storage is **DELETE (rollback journal) mode**, which uses only `fcntl` byte-range locks (supported as advisory locks on Azure Files NFS v4.1) plus a `-journal` sidecar — no shared-memory segment required.

Microsoft references for the target environment:
- NFS file shares in Azure Files — https://learn.microsoft.com/en-us/azure/storage/files/files-nfs-protocol
- Use storage mounts in Azure Container Apps — https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts

## Why single-process pinning does not fix it

Even pinned to a single host/replica, AKM still hits this, because `akm` is a CLI: an interactive invocation and the scheduler cron run as **separate OS processes opening separate connections** to the same DB. WAL's `-shm` cannot be shared across those co-located processes over a network mount, and AKM does not set `PRAGMA locking_mode = EXCLUSIVE` (which would itself require a single connection total). So the WAL-without-shared-memory escape hatch (SQLite ≥ 3.7.4) does not apply.

## Current behavior in the code (what we verified)

The PRAGMAs are set unconditionally with no override:

- `src/core/state-db.ts` (`openStateDatabase`): `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA busy_timeout = 30000`
- `src/workflows/db.ts` (`openWorkflowDatabase`): `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 30000`, `PRAGMA foreign_keys = ON` (a code comment ties the 30s timeout to #589 and notes it matches `index.db` and `state.db`)
- `src/storage/database.ts` (`openDatabase`) is a thin Bun/Node `bun:sqlite` factory and sets no PRAGMAs — configuration is delegated to the callers above.

DB files affected (under `AKM_DATA_DIR`, per `src/storage/locations.ts`): `state.db`, `workflow.db`, `index.db`.

> Note: `state.db` and `workflow.db` were read directly; `index.db`'s PRAGMAs are **inferred** from the `workflows/db.ts` comment (the `src/indexer/db/*` files weren't accessible at review time). If `index.db` differs, please correct.

This is the same robustness area as the recent busy_timeout work (#586 → backport #589) and the index.db handle/`SQLITE_BUSY` fixes (#584, #585), which all assume a **local** filesystem under the DBs.

## Proposed change

1. Add an env var **`AKM_SQLITE_JOURNAL_MODE`** (accepted values `WAL` | `DELETE` | `TRUNCATE`, default `WAL` to preserve current behavior) applied in `openStateDatabase`, `openWorkflowDatabase`, and the `index.db` opener.
2. Optionally, **auto-detect a network filesystem** for `AKM_DATA_DIR` (e.g. statfs magic / mount type) and, if WAL is requested on one, fall back to `DELETE` and emit a one-line warning rather than failing at runtime. (This mirrors the "detect-and-warn" idea OpenPalm already tracks internally as limitation "I-12 network FS".)
3. Keep `busy_timeout = 30000`; consider `PRAGMA synchronous = FULL` when in rollback-journal mode on a network FS for extra durability.

## Acceptance criteria

- All three DBs honor `AKM_SQLITE_JOURNAL_MODE`; default behavior is unchanged (`WAL`).
- With `AKM_SQLITE_JOURNAL_MODE=DELETE`, AKM opens and operates without `SQLITE_IOERR_SHMMAP` when `AKM_DATA_DIR` is on an NFS mount.
- Concurrent `akm` invocations (interactive + cron) against the same DBs on a single host over NFS do not corrupt data (recommend a load test, given documented NFS `fcntl` caveats).
- Documented in the README alongside `AKM_DATA_DIR`.

## Notes

Happy to open a PR if helpful — the change is small and localized to the three openers. This came out of the OpenPalm "op-az" Azure Container Apps deployment design review; resolving it would let the AKM data subtree live on the same shared volume as the rest of `OP_HOME` instead of requiring an ephemeral-storage carve-out.
