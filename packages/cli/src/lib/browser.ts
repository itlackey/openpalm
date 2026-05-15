/**
 * Opens a URL in the user's default browser. Best-effort, never throws.
 */
export async function openBrowser(url: string): Promise<void> {
  console.log(`Opening ${url} in your browser...`);
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    if (platform === 'win32') {
      Bun.spawn(['cmd', '/c', 'start', url], { stdout: 'ignore', stderr: 'ignore' });
      return;
    }
    Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Best effort
  }
}
