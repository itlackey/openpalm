export function isLocalAssistantUrl(url: string | null | undefined): boolean {
  if (!url) return true;

  try {
    const host = new URL(url).hostname;
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'host.docker.internal'
    );
  } catch {
    return true;
  }
}
