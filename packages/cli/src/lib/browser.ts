/**
 * Opens a URL in the user's default browser. Best-effort, never throws.
 *
 * Returns whether the opener process actually exited successfully — a spawn
 * of `xdg-open` (or `open`/`cmd /c start`) can itself fail at runtime (e.g. no
 * DISPLAY, no configured browser on a headless/SSH host) even though spawning
 * it succeeded, so callers must not assume the browser actually opened just
 * because this didn't throw (C5).
 */
export async function openBrowser(url: string): Promise<boolean> {
  const platform = process.platform;
  try {
    const proc =
      platform === 'darwin'
        ? Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
        : platform === 'win32'
          ? Bun.spawn(['cmd', '/c', 'start', url], { stdout: 'ignore', stderr: 'ignore' })
          : Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' });
    // These openers hand off to the real browser and exit almost immediately;
    // bound the wait so a wedged opener can't hang the CLI instead of just
    // reporting "could not confirm".
    const code = await Promise.race([
      proc.exited,
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return code === 0;
  } catch {
    // Missing binary (e.g. xdg-open not installed on a headless server)
    // throws synchronously — best-effort, so just report failure.
    return false;
  }
}
