/**
 * Access status "actual" — what Docker reports for the two containers behind
 * the four access toggles, as the complement to the STORED intent
 * `readAccessToggles()` returns.
 *
 * Stored intent can outrun Compose reality: a toggle save whose recreate
 * failed partway (`AccessApplyResult.ok === false`), a restored backup, or a
 * hand `docker compose restart` all leave the toggle reading ON while nothing
 * is actually listening. This module exists so the Phase 2 access-status
 * endpoint can show that drift instead of assuming a save always took.
 *
 * `compose ps --format json` (via `parseComposePsRows`) exposes container
 * state/health only — no port-publish table any caller in this tree parses.
 * `packages/ui/src/lib/server/landing.ts` stops at the identical two fields
 * for the identical reason. "healthy" is therefore the strongest signal
 * available here for "the listener behind this container is actually up";
 * it is evidence, not a literal port-publish check — see the doc comment on
 * `ContainerActualStatus`.
 *
 * Dependencies are injected (the `access-apply.ts` pattern) rather than
 * module-mocked: a whole-module mock is process-global in Bun and leaks into
 * unrelated files at the aggregate `bun run test` scale.
 */
import { buildComposeOptions } from "./compose-args.js";
import { composePs, isComposePsRowHealthy, parseComposePsRows, type ComposePsRow } from "./docker.js";
import type { ControlPlaneState } from "./types.js";

/**
 * One container's observed state.
 *
 * `deployed: false` means Docker was reachable and simply has no container
 * for this service (never started, or torn down) — a known fact, distinct
 * from `null` at the {@link AccessStatusActual} level, which means Docker
 * itself could not be asked.
 */
export type ContainerActualStatus = {
  deployed: boolean;
  running: boolean;
  healthy: boolean;
};

/** The two containers that back all four access toggles (see access-apply.ts's KEY_OWNER). */
export const ACCESS_STATUS_SERVICES = ["assistant", "guardian"] as const;
export type AccessStatusService = (typeof ACCESS_STATUS_SERVICES)[number];

export type AccessStatusActual = Record<AccessStatusService, ContainerActualStatus | null>;

/** Pure: derive one service's status from already-fetched `compose ps` rows. */
export function resolveContainerActualStatus(
  rows: ComposePsRow[],
  service: AccessStatusService,
): ContainerActualStatus {
  const row = rows.find((r) => r.service === service);
  if (!row) return { deployed: false, running: false, healthy: false };
  return {
    deployed: true,
    running: row.state.trim().toLowerCase() === "running",
    healthy: isComposePsRowHealthy(row),
  };
}

export type AccessStatusDeps = {
  composePs: typeof composePs;
};

export const defaultAccessStatusDeps: AccessStatusDeps = { composePs };

/**
 * Query Docker for the actual state of both access-toggle-owning containers.
 *
 * Never throws: an unreachable daemon (or any other `composePs` failure)
 * degrades BOTH entries to `null` — "unknown", not "down". A daemon that
 * cannot be reached says nothing about whether the containers behind it are
 * healthy, so reporting `false` there would assert a fact this function does
 * not have.
 */
export async function fetchAccessStatusActual(
  state: ControlPlaneState,
  deps: Partial<AccessStatusDeps> = {},
): Promise<AccessStatusActual> {
  const { composePs: composePsFn } = { ...defaultAccessStatusDeps, ...deps };
  try {
    const options = buildComposeOptions(state);
    const result = await composePsFn({ files: options.files, envFiles: options.envFiles });
    if (!result.ok) return { assistant: null, guardian: null };
    const rows = parseComposePsRows(result.stdout);
    return {
      assistant: resolveContainerActualStatus(rows, "assistant"),
      guardian: resolveContainerActualStatus(rows, "guardian"),
    };
  } catch {
    return { assistant: null, guardian: null };
  }
}
