type OpenPalmBridge = {
  openLocalApp?: () => Promise<void>;
};

type BrowserOpener = (url?: string | URL, target?: string, features?: string) => Window | null;

export function openLocalClientApp(
  localClientAppUrl: string,
  bridge: OpenPalmBridge | undefined,
  opener: BrowserOpener,
): 'bridge' | 'window' {
  if (typeof bridge?.openLocalApp === 'function') {
    void bridge.openLocalApp();
    return 'bridge';
  }
  opener(localClientAppUrl, '_blank', 'noopener');
  return 'window';
}
