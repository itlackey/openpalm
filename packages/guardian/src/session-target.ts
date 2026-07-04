/**
 * Session targeting — derives the stable cache key / session key / title used to
 * route a principal's requests to a reusable assistant session.
 *
 * A caller may pin a specific conversation by supplying `metadata.sessionKey`;
 * otherwise the principal's userId is used. The derived key is bounded in length
 * to keep it usable as a map key and session title.
 *
 * SECURITY: the reuse `cacheKey` binds the FULL principal identity
 * (kind + portalId + userId) alongside the sessionKey. `sessionKey` is
 * client-settable (x-openpalm-session-key), so two distinct users under the same
 * portal that share an explicit sessionKey must NOT collide on one cached
 * session — otherwise the second user's create would silently re-point ownership
 * of the first user's live session. The identity segments are JSON-encoded (as in
 * ownership.principalKey) so a userId containing the delimiter cannot forge
 * another principal's key.
 */

import { asRecord } from './http-util.ts';

const SESSION_KEY_MAX_LENGTH = 256;

export type SessionTarget = {
  cacheKey: string;
  sessionKey: string;
  title: string;
};

export function resolveSessionTarget(
  userId: string,
  portalId: string,
  kind: string,
  metadata: unknown,
): SessionTarget {
  const meta = asRecord(metadata);
  const metadataSessionKey = typeof meta?.sessionKey === "string"
    ? meta.sessionKey.trim()
    : "";
  const sessionKey = metadataSessionKey && metadataSessionKey.length <= SESSION_KEY_MAX_LENGTH
    ? metadataSessionKey
    : userId;

  return {
    cacheKey: JSON.stringify([kind, portalId, userId, sessionKey]),
    sessionKey,
    title: `${portalId}/${sessionKey}`,
  };
}
