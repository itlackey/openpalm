/**
 * GET  /api/host/akm/import-host — what an import would find on this host.
 * POST /api/host/akm/import-host — copy the host's akm engine/embedding config
 *                                  into the assistant's, then prove it loads.
 *
 * The counterpart to `/api/host/providers/import-host`: an operator who already
 * runs akm locally can say "use my local configuration" once instead of
 * re-entering the same endpoints and models by hand.
 *
 * MANUAL, and validated. This import used to fire automatically as a side
 * effect of enabling host STASH sharing, which is how it broke installs: the
 * host and the assistant image are independent akm installs on independent
 * upgrade cycles, so a host running a newer akm wrote keys the container's CLI
 * could not parse, and every akm call in the assistant failed with
 * INVALID_CONFIG_FILE while the UI said only "metrics unavailable".
 *
 * So the write is not trusted on faith. The previous config is kept, the merge
 * is applied, and the RUNNING assistant is asked to load it (`akm health`). If
 * it cannot, the previous config is restored byte-for-byte and the operator is
 * told what akm actually said. An import can therefore leave the assistant
 * working or leave it exactly as it was — never broken and silent.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestHandler } from './$types';
import {
  detectHostAkmConfig,
  hostAkmConfigPath,
  importHostAkmConfig,
  runAssistantAkmCommand,
} from '@openpalm/lib';
import { getState } from '$lib/server/state.js';
import {
  errorResponse,
  getRequestId,
  jsonResponse,
  requireAdmin,
  requireCapability,
  requireInstalledHome
} from '$lib/server/helpers.js';
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';

function assistantAkmConfigPath(configDir: string): string {
  return join(configDir, 'akm', 'config.json');
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:akm-sharing', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  return jsonResponse(200, detectHostAkmConfig(), requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:akm-sharing', requestId);
  if (capabilityError) return capabilityError;
  const authError = requireAdmin(event, requestId);
  if (authError) return authError;

  const state = getState();
  const notInstalled = requireInstalledHome(state.homeDir, requestId);
  if (notInstalled) return notInstalled;
  return withAdminUpdateLock(state, requestId, async () => {
    const host = detectHostAkmConfig();
    if (!host.available) {
      return errorResponse(
        404,
        'host_akm_config_not_found',
        `No readable akm config at ${hostAkmConfigPath()}. Configure akm on this machine first, or set the assistant's engines directly.`,
        {},
        requestId,
      );
    }

    const configPath = assistantAkmConfigPath(state.configDir);
    const previous = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;

    const { imported } = importHostAkmConfig(state, hostAkmConfigPath());
    if (imported.length === 0) {
      return jsonResponse(200, { imported: [], changed: false }, requestId);
    }

    // Prove the assistant's own akm can load what we just wrote. `health`
    // exits non-zero on an unloadable config and names the offending key.
    const check = await runAssistantAkmCommand(state, ['health', '--format', 'json', '--quiet'], 8000, {
      allowExitCodes: [4],
    });
    const rejected = /INVALID_CONFIG_FILE|Invalid config at/i.test(`${check.stdout}${check.stderr}`);

    if (rejected) {
      // Roll back byte-for-byte. A partially-applied import that the assistant
      // cannot read is strictly worse than not importing.
      if (previous === null) writeFileSync(configPath, '');
      else writeFileSync(configPath, previous);
      const detail = [check.stderr, check.stdout].map((s) => s?.trim()).find((s) => s);
      return errorResponse(
        422,
        'host_akm_config_incompatible',
        `The assistant could not load the imported configuration, so nothing was changed. ${detail ?? ''}`.trim(),
        { imported },
        requestId,
      );
    }

    // `missing` means the assistant is not running; the file is written and
    // valid as far as we can tell, and akm will read it when it starts.
    return jsonResponse(
      200,
      { imported, changed: true, verified: !check.missing },
      requestId,
    );
  });
};
