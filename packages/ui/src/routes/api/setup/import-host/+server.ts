/**
 * POST /api/setup/import-host
 *
 * Setup-phase equivalent of POST /api/host/providers/import-host.
 * No admin auth required — the admin login password is not set yet during setup.
 *
 * Copies host OpenCode config + auth into OP_HOME and live-pushes credentials
 * to the running OpenCode subprocess so providers appear connected immediately.
 */
import { existsSync, readFileSync } from 'node:fs';
import { json } from '@sveltejs/kit';
import {
  importHostOpenCode,
  detectHostOpenCode,
  authJsonPath,
  createLogger,
  restartProviderConsumers,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import { pushImportedAuth } from '$lib/server/provider-import.js';
import { errorResponse, getRequestId } from '$lib/server/helpers.js';
import type { RequestHandler } from './$types';

const logger = createLogger('setup:import-host');

/** Read the provider ids present in an auth.json, ignoring read/parse errors. */
function providerIdsFromAuth(authPath: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf-8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.keys(raw as Record<string, unknown>);
    }
  } catch {
    // ignore — caller falls back to an empty list
  }
  return [];
}

export const POST: RequestHandler = async (event) => {
  const state = getState();

  // Copy host config + auth into OP_HOME. This is the only step that must
  // succeed for the import to be meaningful — guard it so a filesystem error
  // surfaces as a clear failure rather than a generic 500.
  let result: ReturnType<typeof importHostOpenCode>;
  try {
    result = importHostOpenCode(state, { overwriteConflicts: false });
  } catch (err) {
    // W15: previously `error` carried the full human sentence with no
    // machine code and no requestId — the standard envelope splits those out.
    // handleHostImport (setup-state.svelte.ts) already prefers `message`, so
    // this is additive for that caller.
    return errorResponse(
      500,
      'host_import_failed',
      `Could not copy host OpenCode config: ${err instanceof Error ? err.message : String(err)}`,
      {},
      getRequestId(event),
    );
  }

  // Provider ids that now have credentials in OP_HOME.
  // Primary source: the copy result's credential count tells us something was
  // copied, but it doesn't give us provider names. Read the imported auth.json
  // for names. If that post-copy read fails but the copy DID report credentials,
  // we warn and fall back to the host-side auth.json so we don't silently hide
  // providers that ARE on disk.
  const importedAuthPath = authJsonPath(state);
  let importedProviderIds: string[] = [];
  if (result.imported.credentials > 0 || existsSync(importedAuthPath)) {
    const fromDestination = providerIdsFromAuth(importedAuthPath);
    if (fromDestination.length > 0) {
      importedProviderIds = fromDestination;
    } else if (result.imported.credentials > 0) {
      // Post-copy read returned nothing despite a reported copy — warn and fall
      // back to the host-side auth.json so providers aren't silently hidden.
      const hostStatus = detectHostOpenCode();
      const hostFallback = hostStatus.authPath ? providerIdsFromAuth(hostStatus.authPath) : [];
      logger.warn('post-copy auth.json read returned no providers despite credentials being reported; falling back to host auth.json', {
        importedAuthPath,
        importedCredentials: result.imported.credentials,
        fallbackCount: hostFallback.length,
      });
      importedProviderIds = hostFallback;
    }
  }

  // Conflict provider ids — provider entries that already existed in OP_HOME
  // and were NOT overwritten. Exposed so the UI can show "X was skipped".
  const conflictProviders: string[] = result.conflicts;

  const authPathToUse = existsSync(importedAuthPath) ? importedAuthPath : null;

  // Best-effort live push to a running OpenCode so providers appear connected
  // immediately. A per-provider push error (or OpenCode not being reachable
  // during setup) is NON-FATAL — it never fails the whole import.
  let pushResult = { pushed: [] as string[], errors: [] as { provider: string; error: string }[] };
  if (authPathToUse) {
    pushResult = await pushImportedAuth(authPathToUse);
  }
  // authPathToUse is only null when nothing was imported — skip the live push.

  // Restart provider-consuming services. During setup the stack may not be
  // running yet, so restart failures are non-fatal (credentials are already
  // on disk and will be read on first start).
  const restart = await restartProviderConsumers(state, result.changed);

  return json({
    ok: true,
    imported: result.imported,
    importedProviders: importedProviderIds,
    conflicts: result.conflicts.length,
    conflictProviders,
    livePushed: pushResult.pushed.length,
    pushedProviders: pushResult.pushed,
    errors: pushResult.errors,
    restarted: restart.restarted,
    restartFailed: restart.failed,
  });
};
