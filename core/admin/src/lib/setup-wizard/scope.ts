export const SUPPORTED_CONNECTION_KINDS_V1 = [
  'openai_compatible_remote',
  'openai_compatible_local',
] as const;

export const WIZARD_CONNECTION_KINDS = SUPPORTED_CONNECTION_KINDS_V1;

export type WizardConnectionKind = (typeof WIZARD_CONNECTION_KINDS)[number];

export const REQUIRED_CAPABILITIES_V1 = [
  'llm',
  'embeddings',
] as const;

export const WIZARD_REQUIRED_CAPABILITIES = REQUIRED_CAPABILITIES_V1;

export const OPTIONAL_CAPABILITIES_V1 = [
  'reranking',
  'tts',
  'stt',
] as const;

export const WIZARD_OPTIONAL_CAPABILITIES = OPTIONAL_CAPABILITIES_V1;

export const WIZARD_CAPABILITIES = [
  ...WIZARD_REQUIRED_CAPABILITIES,
  ...WIZARD_OPTIONAL_CAPABILITIES,
] as const;

export type WizardCapability = (typeof WIZARD_CAPABILITIES)[number];

export const WIZARD_PROVIDER_KIND_MAP = {
  openai: 'openai_compatible_remote',
  groq: 'openai_compatible_remote',
  together: 'openai_compatible_remote',
  mistral: 'openai_compatible_remote',
  deepseek: 'openai_compatible_remote',
  xai: 'openai_compatible_remote',
  ollama: 'openai_compatible_local',
  lmstudio: 'openai_compatible_local',
  'model-runner': 'openai_compatible_local',
} as const satisfies Record<string, WizardConnectionKind>;

export type WizardScopedProvider = keyof typeof WIZARD_PROVIDER_KIND_MAP;

const VALID_CAPABILITIES = new Set<string>(WIZARD_CAPABILITIES);

export function getWizardConnectionKindForProvider(provider: string): WizardConnectionKind | null {
  return WIZARD_PROVIDER_KIND_MAP[provider as WizardScopedProvider] ?? null;
}

export function isWizardProviderInScope(provider: string): provider is WizardScopedProvider {
  return getWizardConnectionKindForProvider(provider) !== null;
}

export function isWizardCapability(value: string): value is WizardCapability {
  return VALID_CAPABILITIES.has(value);
}

type CapabilityValidationResult =
  | { ok: true; capabilities: WizardCapability[] }
  | { ok: false; message: string };

export function validateWizardCapabilitiesInput(value: unknown): CapabilityValidationResult {
  if (value === undefined) {
    return { ok: true, capabilities: [...WIZARD_REQUIRED_CAPABILITIES] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, message: 'capabilities must be an array of capability ids' };
  }

  const deduped = Array.from(new Set(value));
  const invalid = deduped.find((item) => typeof item !== 'string' || !isWizardCapability(item));
  if (invalid !== undefined) {
    return {
      ok: false,
      message: `capabilities includes unsupported value: ${String(invalid)}`,
    };
  }

  const missingRequired = WIZARD_REQUIRED_CAPABILITIES.filter((capability) => !deduped.includes(capability));
  if (missingRequired.length > 0) {
    return {
      ok: false,
      message: `capabilities must include required values: ${missingRequired.join(', ')}`,
    };
  }

  return {
    ok: true,
    capabilities: deduped as WizardCapability[],
  };
}

export function hasRequiredWizardCapabilities(capabilities: readonly string[]): boolean {
  for (const capability of WIZARD_REQUIRED_CAPABILITIES) {
    if (!capabilities.includes(capability)) {
      return false;
    }
  }
  return true;
}
