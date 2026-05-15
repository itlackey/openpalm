import type { OpenCodeModelInfo } from '$lib/types.js';
import { asRecord } from '$lib/server/coercion.js';

export function sanitizeOpenCodeModels(
  models: unknown,
  fallbackProviderId: string,
): OpenCodeModelInfo[] {
  if (!models || typeof models !== 'object') {
    return [];
  }

  return Object.values(models)
    .map((value) => asRecord(value))
    .filter((model): model is Record<string, unknown> & { id: string } => typeof model?.id === 'string')
    .map((model) => {
      const id = model.id;
      return {
        id,
        name: typeof model.name === 'string' ? model.name : id,
        family: typeof model.family === 'string' ? model.family : '',
        providerID: typeof model.providerID === 'string' ? model.providerID : fallbackProviderId,
        status: typeof model.status === 'string' ? model.status : 'active',
        capabilities: asRecord(model.capabilities) ?? {},
      };
    });
}
