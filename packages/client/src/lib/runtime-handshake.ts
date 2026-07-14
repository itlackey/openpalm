/**
 * Client-side `/api/runtime` contract-version handshake (#511 D2).
 *
 * A new leaf module, NOT a transport change: the transport
 * (`$lib/transport/index.ts`) is scoped to a connection's OpenCode/guardian
 * API surface; this probes a different, OpenPalm-host contract at the
 * connection's ORIGIN ROOT and treats "endpoint absent" as the normal legacy
 * case (a plain OpenCode/guardian target that doesn't serve `/api/runtime`),
 * not an error. Never throws — graceful degradation is the whole point.
 */

/** Mirrors packages/ui/src/lib/types.ts:36-37 (`ServerRuntimeContext.version`),
 *  pinned compatible by a cross-package source-pin test. */
export const SUPPORTED_RUNTIME_CONTRACT_VERSION = 2;

export type RuntimeContractResult =
  | { state: 'compatible'; version: number }
  | { state: 'newer'; version: number } // server > supported
  | { state: 'older'; version: number } // server < supported
  | { state: 'legacy' }; // endpoint absent/unreadable — plain OpenCode/guardian

export async function checkRuntimeContract(
  connectionUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<RuntimeContractResult> {
  let response: Response;
  try {
    const target = new URL('/api/runtime', connectionUrl);
    response = await fetchImpl(target.toString(), {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { state: 'legacy' };
  }

  if (!response.ok) return { state: 'legacy' };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: 'legacy' };
  }

  if (typeof body !== 'object' || body === null) return { state: 'legacy' };
  const version = (body as Record<string, unknown>).version;
  if (typeof version !== 'number' || !Number.isInteger(version)) return { state: 'legacy' };

  if (version === SUPPORTED_RUNTIME_CONTRACT_VERSION) return { state: 'compatible', version };
  if (version > SUPPORTED_RUNTIME_CONTRACT_VERSION) return { state: 'newer', version };
  return { state: 'older', version };
}
