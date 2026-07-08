import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ClientRuntimeConnection = {
  id: string;
  label: string;
  kind: 'local-opencode';
  url: string;
  auth: { mode: 'none' };
  isDefault: true;
  locked: true;
};

export type ClientRuntimeConfig = {
  connections: ClientRuntimeConnection[];
};

export function buildLockedAssistantRuntimeConfig(url: string): ClientRuntimeConfig {
  return {
    connections: [
      {
        id: 'openpalm-assistant-opencode',
        label: 'This assistant',
        kind: 'local-opencode',
        url,
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ],
  };
}

export function writeClientRuntimeConfig(path: string, assistantUrl: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(buildLockedAssistantRuntimeConfig(assistantUrl), null, 2)}\n`);
}
