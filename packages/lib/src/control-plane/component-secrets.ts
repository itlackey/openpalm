import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ControlPlaneState } from './types.js';
import { parseEnvSchema } from './instance-lifecycle.js';
import { secretKeyFromComponentField } from './secret-mappings.js';

export type ComponentSecretRegistration = {
  fieldName: string;
  secretKey: string;
};

type ComponentSecretRegistry = Record<string, ComponentSecretRegistration[]>;

function registryPath(openpalmHome: string): string {
  return `${openpalmHome}/data/secrets/component-secrets.json`;
}

function readRegistry(openpalmHome: string): ComponentSecretRegistry {
  const path = registryPath(openpalmHome);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ComponentSecretRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(openpalmHome: string, registry: ComponentSecretRegistry): void {
  const dir = `${openpalmHome}/data/secrets`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryPath(openpalmHome), JSON.stringify(registry, null, 2) + '\n');
}

export function deriveComponentSecretRegistrations(
  instanceId: string,
  schemaPath: string,
): ComponentSecretRegistration[] {
  return parseEnvSchema(schemaPath)
    .filter((field) => field.sensitive)
    .map((field) => ({
      fieldName: field.name,
      secretKey: secretKeyFromComponentField(instanceId, field.name),
    }));
}

export function registerComponentSensitiveFields(
  openpalmHome: string,
  instanceId: string,
  schemaPath: string,
): ComponentSecretRegistration[] {
  const registrations = deriveComponentSecretRegistrations(instanceId, schemaPath);
  if (registrations.length === 0) return registrations;

  const registry = readRegistry(openpalmHome);
  registry[instanceId] = registrations;
  writeRegistry(openpalmHome, registry);
  return registrations;
}

export function deregisterComponentSensitiveFields(
  openpalmHome: string,
  instanceId: string,
): ComponentSecretRegistration[] {
  const registry = readRegistry(openpalmHome);
  const removed = registry[instanceId] ?? [];
  if (removed.length === 0) return [];
  delete registry[instanceId];
  writeRegistry(openpalmHome, registry);
  return removed;
}

export function listComponentSensitiveFields(
  state: ControlPlaneState,
  instanceId?: string,
): ComponentSecretRegistration[] {
  const registry = readRegistry(state.homeDir);
  if (instanceId) return registry[instanceId] ?? [];
  return Object.values(registry).flat();
}
