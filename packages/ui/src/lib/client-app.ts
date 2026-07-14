/**
 * Browser-side reachability probe for the "Install OpenPalm app" affordance
 * (#511 D8). The host page renders the install anchor only after this
 * resolves true — the same no-cors reachability trick Electron's
 * `openLocalApp()` and the client transport's `probeCorsBlock()` already use
 * (`packages/client/src/lib/transport/index.ts:571-588`): a `no-cors`
 * request still resolves whenever the server is reachable at the network
 * level, regardless of what CORS headers it sends back, so this never needs
 * to read the response body — only whether the fetch settled.
 */
export async function probeClientApp(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetchImpl(`${url}/`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    return true;
  } catch {
    return false;
  }
}
