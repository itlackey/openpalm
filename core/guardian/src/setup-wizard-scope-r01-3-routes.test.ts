import { beforeAll, describe, expect, it, mock } from 'bun:test';
import { resolve } from 'node:path';

type TestState = {
  adminToken: string;
  setupToken: string;
  configDir: string;
  stateDir: string;
  dataDir: string;
  services: Record<string, 'running' | 'stopped'>;
};

let currentState: TestState = {
  adminToken: 'admin-token',
  setupToken: 'setup-token',
  configDir: '/tmp/opalm-config',
  stateDir: '/tmp/opalm-state',
  dataDir: '/tmp/opalm-data',
  services: {},
};

mock.module('$assets/docker-compose.yml?raw', () => ({ default: '' }));
mock.module('$assets/Caddyfile?raw', () => ({ default: '' }));
mock.module('$assets/openmemory-memory.py?raw', () => ({ default: '' }));
mock.module('$assets/opencode.jsonc?raw', () => ({ default: '' }));
mock.module('$assets/AGENTS.md?raw', () => ({ default: '' }));
mock.module('$assets/ollama.yml?raw', () => ({ default: '' }));

const HELPERS_MODULE = {
  safeTokenCompare: (a: string, b: string) => a === b,
  jsonResponse: (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }),
  errorResponse: (status: number, error: string, message: string, details: Record<string, unknown> = {}, requestId = '') => new Response(
    JSON.stringify({ error, message, details, requestId }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    }
  ),
  getRequestId: () => 'req-test',
  requireAdmin: (event: { request: Request }, _requestId: string) => {
    const token = event.request.headers.get('x-admin-token') ?? '';
    if (token !== currentState.adminToken) {
      return new Response(JSON.stringify({ message: 'Missing or invalid x-admin-token' }), { status: 401 });
    }
    return null;
  },
  getActor: () => 'admin',
  getCallerType: () => 'test',
  parseJsonBody: async (request: Request) => {
    try {
      return await request.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  },
  parseCanonicalConnectionProfile: () => ({ ok: false, message: 'unused in test' }),
  parseCapabilityAssignments: () => ({ ok: false, message: 'unused in test' }),
};

mock.module('$lib/server/helpers.js', () => HELPERS_MODULE);
const HELPERS_PATH_TS = resolve(import.meta.dir, '../../admin/src/lib/server/helpers.ts');
const HELPERS_PATH_JS = resolve(import.meta.dir, '../../admin/src/lib/server/helpers.js');
mock.module(HELPERS_PATH_TS, () => HELPERS_MODULE);
mock.module(HELPERS_PATH_JS, () => HELPERS_MODULE);

mock.module('$lib/server/state.js', () => ({
  getState: () => currentState,
}));

const STATE_MODULE = {
  getState: () => currentState,
};
const STATE_PATH_TS = resolve(import.meta.dir, '../../admin/src/lib/server/state.ts');
const STATE_PATH_JS = resolve(import.meta.dir, '../../admin/src/lib/server/state.js');
mock.module(STATE_PATH_TS, () => STATE_MODULE);
mock.module(STATE_PATH_JS, () => STATE_MODULE);

mock.module('$lib/server/setup-status.js', () => ({
  isSetupComplete: () => false,
  detectUserId: () => 'test-user',
  readSecretsKeys: () => ({}),
}));

const SETUP_STATUS_MODULE = {
  isSetupComplete: () => false,
  detectUserId: () => 'test-user',
  readSecretsKeys: () => ({}),
};
const SETUP_STATUS_PATH_TS = resolve(import.meta.dir, '../../admin/src/lib/server/setup-status.ts');
const SETUP_STATUS_PATH_JS = resolve(import.meta.dir, '../../admin/src/lib/server/setup-status.js');
mock.module(SETUP_STATUS_PATH_TS, () => SETUP_STATUS_MODULE);
mock.module(SETUP_STATUS_PATH_JS, () => SETUP_STATUS_MODULE);

mock.module('$lib/server/docker.js', () => ({
  checkDocker: async () => ({ ok: true, stderr: '' }),
  composeUp: async () => ({ ok: true, stderr: '' }),
}));

const DOCKER_MODULE = {
  checkDocker: async () => ({ ok: true, stderr: '' }),
  composeUp: async () => ({ ok: true, stderr: '' }),
};
const DOCKER_PATH_TS = resolve(import.meta.dir, '../../admin/src/lib/server/docker.ts');
const DOCKER_PATH_JS = resolve(import.meta.dir, '../../admin/src/lib/server/docker.js');
mock.module(DOCKER_PATH_TS, () => DOCKER_MODULE);
mock.module(DOCKER_PATH_JS, () => DOCKER_MODULE);

const CONTROL_PLANE_MODULE = {
  createState: () => currentState,
  fetchProviderModels: async () => ({ models: ['gpt-4o-mini'] }),
  LLM_PROVIDERS: ['openai', 'ollama', 'groq', 'anthropic'],
  EMBED_PROVIDERS: ['openai', 'ollama', 'groq', 'anthropic'],

  appendAudit: () => {},
  readSecretsEnvFile: () => ({}),
  patchSecretsEnvFile: () => {},
  readConnectionProfilesDocument: () => ({ profiles: [], assignments: null }),
  writePrimaryConnectionProfile: () => {},
  ensureConnectionProfilesStore: () => {},
  ALLOWED_CONNECTION_KEYS: new Set([
    'SYSTEM_LLM_PROVIDER',
    'SYSTEM_LLM_BASE_URL',
    'SYSTEM_LLM_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENMEMORY_USER_ID',
    'EMBEDDING_MODEL',
    'EMBEDDING_DIMS',
  ]),
  maskConnectionValue: (_key: string, value: string) => value,
  writeOpenMemoryConfig: () => {},
  resolveConfigForPush: () => ({}),
  pushConfigToOpenMemory: async () => ({ ok: true }),
  checkQdrantDimensions: () => ({ match: true, currentDims: 1536, expectedDims: 1536 }),

  updateSecretsEnv: () => {},
  ensureXdgDirs: () => {},
  ensureOpenCodeConfig: () => {},
  ensureOpenCodeSystemConfig: () => {},
  ensureOpenMemoryPatch: () => {},
  ensureSecrets: () => {},
  applyInstall: () => {},
  discoverStagedChannelYmls: () => [],
  buildComposeFileList: () => [],
  buildEnvFiles: () => [],
  buildManagedServices: () => [],
  readOpenMemoryConfig: () => ({ mem0: {}, openmemory: {} }),
  provisionOpenMemoryUser: async () => {},
};

mock.module('$lib/server/control-plane.js', () => CONTROL_PLANE_MODULE);

const CONTROL_PLANE_PATH_TS = resolve(import.meta.dir, '../../admin/src/lib/server/control-plane.ts');
const CONTROL_PLANE_PATH_JS = resolve(import.meta.dir, '../../admin/src/lib/server/control-plane.js');
mock.module(CONTROL_PLANE_PATH_TS, () => CONTROL_PLANE_MODULE);
mock.module(CONTROL_PLANE_PATH_JS, () => CONTROL_PLANE_MODULE);

let setupPost: (event: unknown) => Promise<Response>;
let setupModelsPost: (event: unknown) => Promise<Response>;
let connectionsPost: (event: unknown) => Promise<Response>;

beforeAll(async () => {
  setupPost = (await import('../../admin/src/routes/admin/setup/+server.ts')).POST;
  setupModelsPost = (await import('../../admin/src/routes/admin/setup/models/+server.ts')).POST;
  connectionsPost = (await import('../../admin/src/routes/admin/connections/+server.ts')).POST;
});

function requestEvent(request: Request): { request: Request } {
  return { request };
}

async function responseMessage(response: Response): Promise<string> {
  const payload = await response.json() as { message?: string };
  return payload.message ?? '';
}

describe('R01-3 route behavior: setup POST', () => {
  it('returns 400 for out-of-scope llmProvider', async () => {
    const response = await setupPost(requestEvent(new Request('http://localhost/admin/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({ llmProvider: 'anthropic', capabilities: ['llm', 'embeddings'] }),
    })));

    expect(response.status).toBe(400);
    expect(await responseMessage(response)).toContain('outside setup wizard v1 scope');
  });

  it('returns 400 for capabilities missing required values', async () => {
    const response = await setupPost(requestEvent(new Request('http://localhost/admin/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({ llmProvider: 'openai', capabilities: ['llm'] }),
    })));

    expect(response.status).toBe(400);
    expect(await responseMessage(response)).toContain('capabilities must include required values: embeddings');
  });

  it('returns 200 for in-scope provider with required capabilities', async () => {
    const response = await setupPost(requestEvent(new Request('http://localhost/admin/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({
        llmProvider: 'openai',
        systemModel: 'gpt-4o-mini',
        embeddingModel: 'text-embedding-3-small',
        capabilities: ['llm', 'embeddings'],
      }),
    })));

    expect(response.status).toBe(200);
  });
});

describe('R01-3 route behavior: setup/models POST', () => {
  it('returns 400 for out-of-scope provider', async () => {
    const response = await setupModelsPost(requestEvent(new Request('http://localhost/admin/setup/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({ provider: 'anthropic' }),
    })));

    expect(response.status).toBe(400);
    expect(await responseMessage(response)).toContain('outside setup wizard v1 scope');
  });

  it('returns 400 for invalid capability id', async () => {
    const response = await setupModelsPost(requestEvent(new Request('http://localhost/admin/setup/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({ provider: 'openai', capability: 'vision' }),
    })));

    expect(response.status).toBe(400);
    expect(await responseMessage(response)).toContain('Invalid capability: vision');
  });

  it('returns 200 for in-scope provider and valid capability', async () => {
    const response = await setupModelsPost(requestEvent(new Request('http://localhost/admin/setup/models', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.setupToken,
      },
      body: JSON.stringify({ provider: 'openai', capability: 'llm' }),
    })));

    expect(response.status).toBe(200);
  });
});

describe('R01-3 route behavior: connections POST legacy patch path', () => {
  it('returns 400 for out-of-scope SYSTEM_LLM_PROVIDER', async () => {
    const response = await connectionsPost(requestEvent(new Request('http://localhost/admin/connections', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.adminToken,
      },
      body: JSON.stringify({ SYSTEM_LLM_PROVIDER: 'anthropic' }),
    })));

    expect(response.status).toBe(400);
    expect(await responseMessage(response)).toContain('outside setup wizard v1 scope');
  });

  it('returns 200 for in-scope SYSTEM_LLM_PROVIDER', async () => {
    const response = await connectionsPost(requestEvent(new Request('http://localhost/admin/connections', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': currentState.adminToken,
      },
      body: JSON.stringify({ SYSTEM_LLM_PROVIDER: 'openai' }),
    })));

    expect(response.status).toBe(200);
  });
});
