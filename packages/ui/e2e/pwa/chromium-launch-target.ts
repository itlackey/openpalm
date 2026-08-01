import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type ChromiumLaunchTarget = { executablePath: string } | { channel: 'chrome' };

type ResolutionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
};

export function resolveChromiumLaunchTarget(
  configuredPath: string | undefined,
  bundledPath: string,
  options: ResolutionOptions = {},
): ChromiumLaunchTarget {
  const explicitPath = configuredPath?.trim();
  if (explicitPath) return { executablePath: explicitPath };

  const exists = options.exists ?? existsSync;
  if (exists(bundledPath)) return { executablePath: bundledPath };

  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const separator = platform === 'win32' ? ';' : ':';
  const executableNames = platform === 'win32' ? ['chromium.exe'] : ['chromium', 'chromium-browser'];
  const candidates = (env.PATH ?? '')
    .split(separator)
    .filter(Boolean)
    .flatMap((directory) => executableNames.map((name) => join(directory, name)));

  if (platform === 'darwin') {
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    if (env.HOME) candidates.push(join(env.HOME, 'Applications/Chromium.app/Contents/MacOS/Chromium'));
  } else if (platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'));
  }

  const installedChromium = candidates.find(exists);
  return installedChromium ? { executablePath: installedChromium } : { channel: 'chrome' };
}
