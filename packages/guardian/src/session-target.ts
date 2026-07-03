/**
 * Session targeting — derives the stable cache key / session key / title used to
 * route a principal's requests to a reusable assistant session.
 *
 * A caller may pin a specific conversation by supplying `metadata.sessionKey`;
 * otherwise the principal's userId is used. The derived key is bounded in length
 * to keep it usable as a map key and session title.
 */

import { asRecord } from './utils.ts';

const SESSION_KEY_MAX_LENGTH = 256;

export type SessionTarget = {
  cacheKey: string;
  sessionKey: string;
  title: string;
};

export function resolveSessionTarget(userId: string, portalId: string, metadata: unknown): SessionTarget {
  const meta = asRecord(metadata);
  const metadataSessionKey = typeof meta?.sessionKey === "string"
    ? meta.sessionKey.trim()
    : "";
  const sessionKey = metadataSessionKey && metadataSessionKey.length <= SESSION_KEY_MAX_LENGTH
    ? metadataSessionKey
    : userId;

  return {
    cacheKey: `${portalId}:${sessionKey}`,
    sessionKey,
    title: `${portalId}/${sessionKey}`,
  };
}
