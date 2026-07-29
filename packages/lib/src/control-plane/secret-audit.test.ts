import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditComposeSecrets,
  auditResolvedComposeSecrets,
  auditFileBasedSecrets,
  auditSecretFilesystem,
  auditStackEnv,
  isSecretLikeKey,
} from './secret-audit.js';

const SHIPPED_STACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skeleton', 'system', 'stack');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'secret-audit-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('isSecretLikeKey', () => {
  it('detects secret-like keys but allows file indirection keys', () => {
    expect(isSecretLikeKey('OPENAI_API_KEY')).toBe(true);
    expect(isSecretLikeKey('OP_UI_LOGIN_PASSWORD')).toBe(true);
    expect(isSecretLikeKey('PORTAL_CHAT_SECRET')).toBe(true);
    expect(isSecretLikeKey('OPENAI_API_KEY_FILE')).toBe(false);
    expect(isSecretLikeKey('OP_ASSISTANT_VERSION')).toBe(false);
  });
});

describe('auditStackEnv', () => {
  it('rejects secret-like keys in stack.env', () => {
    const issues = auditStackEnv({
      OP_HOME: '/home/me/.openpalm',
      OP_ASSISTANT_VERSION: 'latest',
      OPENAI_API_KEY: 'sk-test',
      OP_UI_LOGIN_PASSWORD: 'secret',
    });

    expect(issues.map((entry) => entry.code)).toEqual([
      'stack-env-secret-key',
      'stack-env-secret-key',
    ]);
  });

  it('accepts non-secret runtime configuration', () => {
    expect(auditStackEnv({
      OP_HOME: '/home/me/.openpalm',
      OP_UID: '1000',
      OP_GID: '1000',
      OP_ASSISTANT_PORT: '3800',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    })).toEqual([]);
  });
});

describe('auditComposeSecrets', () => {
  it('rejects service env_file and direct secret-like environment values', () => {
    const issues = auditComposeSecrets(`
services:
  guardian:
    env_file:
      - ./service.env
    environment:
      OPENCODE_SERVER_PASSWORD: secret
`);

    expect(issues.map((entry) => entry.code)).toEqual([
      'compose-service-env-file',
      'compose-secret-env-var',
    ]);
  });

  it('accepts *_FILE environment variables and in-boundary secret grants', () => {
    const issues = auditComposeSecrets({
      services: {
        assistant: {
          environment: {
            OPENAI_API_KEY_FILE: '/run/secrets/provider_openai_api_key',
          },
          secrets: ['provider_openai_api_key'],
        },
        guardian: {
          environment: ['GUARDIAN_PORTAL_SECRET_FILE=/run/secrets/guardian_portal_secret'],
          secrets: [{ source: 'guardian_portal_secret' }, { source: 'portal_chat_hmac' }],
        },
        chat: {
          image: 'openpalm/portal:latest',
          secrets: ['portal_chat_hmac'],
        },
      },
    });

    expect(issues).toEqual([]);
  });

  it('rejects cross-boundary secret grants', () => {
    const issues = auditComposeSecrets({
      services: {
        assistant: { secrets: ['guardian_portal_secret'] },
        chat: { image: 'openpalm/portal:latest', secrets: ['portal_slack_hmac'] },
        guardian: { secrets: ['admin_session_key'] },
      },
    });

    expect(issues.map((entry) => entry.code)).toEqual([
      'compose-secret-boundary',
      'compose-secret-boundary',
      'compose-secret-boundary',
    ]);
  });
});

describe('auditComposeSecrets against shipped stack compose files', () => {
  it('reports zero issues auditing the actual shipped compose files', () => {
    const composeFiles = readdirSync(SHIPPED_STACK_DIR).filter((name) => name.endsWith('.compose.yml'));
    expect(composeFiles.length).toBeGreaterThan(0);

    const issues = composeFiles.flatMap((name) => {
      const path = join(SHIPPED_STACK_DIR, name);
      return auditComposeSecrets(readFileSync(path, 'utf-8')).map((entry) => ({ ...entry, path: `${name}:${entry.path}` }));
    });

    // T33 (ordering gate, pin): this sweep goes red the moment #563's compose
    // grant (guardian → opencode_server_password) lands WITHOUT the matching
    // secret-audit allowlist rule below, and green again once both land
    // together. Currently green because neither has landed yet.
    expect(issues).toEqual([]);
  });
});

// #563 — T32: opencode_server_password is grantable to assistant and
// guardian (D2/D3), not to a portal service.
describe('auditComposeSecrets — #563 opencode_server_password (D2/D3)', () => {
  it('T32 (pin): assistant may mount opencode_server_password (matches the existing /^opencode_/ allowance)', () => {
    const issues = auditComposeSecrets({
      services: {
        assistant: {
          environment: { OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password' },
          secrets: ['opencode_server_password'],
        },
      },
    });
    expect(issues).toEqual([]);
  });

  it('T32 (red until the guardian special-case lands): guardian may mount opencode_server_password (upstream Basic auth to the assistant)', () => {
    const issues = auditComposeSecrets({
      services: {
        guardian: {
          environment: { OPENCODE_SERVER_PASSWORD_FILE: '/run/secrets/opencode_server_password' },
          secrets: ['opencode_server_password'],
        },
      },
    });
    expect(issues).toEqual([]);
  });

  it('T32 (pin): a portal service may NOT mount opencode_server_password', () => {
    const issues = auditComposeSecrets({
      services: {
        chat: {
          image: 'openpalm/portal:latest',
          secrets: ['opencode_server_password'],
        },
      },
    });
    expect(issues.map((entry) => entry.code)).toEqual(['compose-secret-boundary']);
  });
});

describe('auditResolvedComposeSecrets adversarial boundary cases', () => {
  it('accepts the shipped named-secret aliases only at their canonical files', () => {
    const issues = auditResolvedComposeSecrets({
      secrets: {
        opencode_server_password: { file: `${tempDir}/private/secrets/op_opencode_password` },
        ui_login_password: { file: `${tempDir}/private/secrets/op_ui_login_password` },
        guardian_auth_json: { file: `${tempDir}/knowledge/secrets/auth.json` },
      },
    }, { homeDir: tempDir });

    expect(issues).toEqual([]);
  });

  it('rejects a top-level source override even when the service grant name is allowed', () => {
    const issues = auditResolvedComposeSecrets({
      secrets: {
        ui_login_password: { file: `${tempDir}/private/secrets/attacker` },
      },
      services: {
        assistant: {
          environment: { OP_UI_LOGIN_PASSWORD_FILE: '/run/secrets/ui_login_password' },
          secrets: ['ui_login_password'],
        },
      },
    }, { homeDir: tempDir });

    expect(issues.map((entry) => entry.code)).toContain('compose-secret-source-boundary');
  });

  it('rejects an assistant private bind mount in the fully merged service view', () => {
    const issues = auditResolvedComposeSecrets({
      services: {
        assistant: {
          volumes: [{ type: 'bind', source: `${tempDir}/private`, target: '/stash/private' }],
        },
      },
    }, { homeDir: tempDir });

    expect(issues.map((entry) => entry.code)).toContain('compose-private-bind-mount');
  });

  it('rejects merged overlay env_file and secret target redirection', () => {
    const issues = auditResolvedComposeSecrets({
      secrets: {
        portal_chat_secret: { file: `${tempDir}/private/secrets/portal_chat_secret` },
      },
      services: {
        chat: {
          image: 'openpalm/portal:latest',
          env_file: ['/merged/base.env', '/merged/overlay.env'],
          environment: { PORTAL_CHAT_SECRET_FILE: '/run/secrets/portal_slack_secret' },
          secrets: [{ source: 'portal_chat_secret', target: '/run/secrets/other_name' }],
        },
      },
    }, { homeDir: tempDir });

    expect(issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'compose-service-env-file',
      'compose-secret-env-redirection',
      'compose-secret-redirection',
    ]));
  });
});

describe('auditSecretFilesystem', () => {
  it('requires a 0700 secrets directory and 0600 secret files', () => {
    const secretsDir = join(tempDir, 'config', 'stack', 'secrets');
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(secretsDir, 0o700);
    const secretPath = join(secretsDir, 'provider_openai_api_key');
    writeFileSync(secretPath, 'sk-test\n', { mode: 0o600 });
    chmodSync(secretPath, 0o600);

    expect(auditSecretFilesystem(secretsDir)).toEqual([]);
  });

  it('reports unsafe directory and file permissions', () => {
    const secretsDir = join(tempDir, 'secrets');
    mkdirSync(secretsDir, { recursive: true, mode: 0o755 });
    chmodSync(secretsDir, 0o755);
    const secretPath = join(secretsDir, 'admin_session_key');
    writeFileSync(secretPath, 'secret\n', { mode: 0o644 });
    chmodSync(secretPath, 0o644);

    expect(auditSecretFilesystem(secretsDir).map((entry) => entry.code)).toEqual([
      'secrets-dir-mode',
      'secret-file-mode',
    ]);
  });
});

describe('auditFileBasedSecrets', () => {
  it('combines stack env, compose, and filesystem checks', () => {
    const secretsDir = join(tempDir, 'secrets');
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(secretsDir, 0o700);
    writeFileSync(join(secretsDir, 'provider_openai_api_key'), 'sk-test\n', { mode: 0o600 });

    const result = auditFileBasedSecrets({
      stackEnvContent: 'OP_HOME=/tmp/openpalm\nOPENAI_API_KEY=bad\n',
      composeConfig: 'services:\n  assistant:\n    environment:\n      OPENAI_API_KEY_FILE: /run/secrets/provider_openai_api_key\n',
      secretsDir,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(['stack-env-secret-key']);
  });
});
