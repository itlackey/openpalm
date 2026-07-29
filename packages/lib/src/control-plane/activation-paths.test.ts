import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROL_PLANE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(CONTROL_PLANE_DIR, '..', '..', '..', '..');

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('Compose activation path coverage', () => {
  it('keeps the CLI mutation runner on the shared activation gate', () => {
    const cliCompose = source('packages/cli/src/lib/cli-compose.ts');
    expect(cliCompose).toContain('activateComposeCommand');
    expect(cliCompose).toContain('await activateComposeCommand(state, composeSubArgs');
  });

  it('keeps host UI mutation routes on shared activation entry points', () => {
    for (const path of [
      'packages/ui/src/routes/api/host/install/+server.ts',
      'packages/ui/src/routes/api/host/update/+server.ts',
      'packages/ui/src/routes/api/host/containers/pull/+server.ts',
      'packages/ui/src/routes/api/host/containers/up/+server.ts',
      'packages/ui/src/routes/api/host/containers/restart/+server.ts',
      'packages/ui/src/routes/api/host/containers/down/+server.ts',
      'packages/ui/src/routes/api/host/uninstall/+server.ts',
    ]) {
      const text = source(path);
      expect(text).toMatch(/activate(Stack|ComposeCommand)/);
    }
  });

  it('keeps deploy, rollback reapply, addon, and voice activation centralized', () => {
    expect(source('packages/lib/src/control-plane/deploy.ts')).toContain('activateStack');
    expect(source('packages/lib/src/control-plane/lifecycle.ts')).toContain('activateStack');
    expect(source('packages/ui/src/lib/server/addon-helpers.ts')).toContain('activateComposeCommand');
    expect(source('packages/ui/src/lib/server/voice/bring-up.ts')).toContain('activateStack');
  });
});
