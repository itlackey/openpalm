import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const writeAtomicDurable = (file, content) => {
  const directory = dirname(file);
  const temporary = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
};

const readConfig = (file) => {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('AKM config must be a JSON object');
  }
  return config;
};

const args = process.argv.slice(2);
if (args[0] === '--stamp-missing') {
  const sourcePath = args[1];
  if (!sourcePath || args.length !== 2) {
    throw new Error('usage: prepare-akm-09-config --stamp-missing <source>');
  }
  const source = readConfig(sourcePath);
  if (source.configVersion !== undefined && source.configVersion !== '0.8.0') {
    throw new Error(`refusing to stamp unsupported AKM config version ${JSON.stringify(source.configVersion)}`);
  }
  if (source.configVersion === undefined) {
    source.configVersion = '0.8.0';
    writeAtomicDurable(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  }
  process.exit(0);
}

const [sourcePath, targetPath] = args;
if (!sourcePath || !targetPath || args.length !== 2) {
  throw new Error('usage: prepare-akm-09-config <source> <target>');
}

const source = readConfig(sourcePath);
if (source.configVersion !== '0.8.0') {
  throw new Error(`refusing to prepare unsupported AKM config version ${JSON.stringify(source.configVersion)}`);
}

const asObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const slug = (value, fallback) => {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return normalized && !normalized.startsWith('akm-') ? normalized : fallback;
};

const profiles = asObject(source.profiles);
const llmProfiles = asObject(profiles.llm);
const agentProfiles = asObject(profiles.agent);
const improveProfiles = asObject(profiles.improve);
const oldDefaults = asObject(source.defaults);
const engines = { ...asObject(source.engines) };
const existingEngineNames = new Set(Object.keys(engines));
const llmNames = new Map();
const agentNames = new Map();
const llmSlugOwners = new Map();
const agentSlugOwners = new Map();

const claimProfileSlug = (owners, oldName, name, profileType, targetType) => {
  if (owners.has(name)) {
    throw new Error(
      `${profileType} profiles ${JSON.stringify(owners.get(name))} and ${JSON.stringify(oldName)} both normalize to ${targetType} ${JSON.stringify(name)}`,
    );
  }
  owners.set(name, oldName);
};

for (const oldName of Object.keys(llmProfiles)) {
  const name = slug(oldName, 'llm');
  claimProfileSlug(llmSlugOwners, oldName, name, 'LLM', 'engine');
  if (existingEngineNames.has(name)) {
    throw new Error(
      `LLM profile ${JSON.stringify(oldName)} normalizes to existing engine ${JSON.stringify(name)}`,
    );
  }
  llmNames.set(oldName, name);
}

for (const oldName of Object.keys(agentProfiles)) {
  const name = slug(oldName, 'agent');
  claimProfileSlug(agentSlugOwners, oldName, name, 'agent', 'engine');
}

const engineOwners = new Map();
for (const name of existingEngineNames) engineOwners.set(name, `existing engine ${JSON.stringify(name)}`);
for (const [oldName, name] of llmNames) {
  engineOwners.set(name, `LLM profile ${JSON.stringify(oldName)}`);
}

for (const oldName of Object.keys(agentProfiles)) {
  const base = slug(oldName, 'agent');
  if (existingEngineNames.has(base)) {
    throw new Error(
      `agent profile ${JSON.stringify(oldName)} normalizes to existing engine ${JSON.stringify(base)}`,
    );
  }
  if (llmSlugOwners.has(base)) {
    throw new Error(
      `LLM and agent profiles both normalize to engine ${JSON.stringify(base)}; rename one before upgrading`,
    );
  }
  const name = base;
  if (engineOwners.has(name)) {
    throw new Error(
      `agent profile ${JSON.stringify(oldName)} normalizes to engine ${JSON.stringify(name)}, which collides with ${engineOwners.get(name)}`,
    );
  }
  agentNames.set(oldName, name);
  engineOwners.set(name, `agent profile ${JSON.stringify(oldName)}`);
}

for (const [oldName, raw] of Object.entries(llmProfiles)) {
  const entry = asObject(raw);
  const name = llmNames.get(oldName);
  if (entry.apiKey && !/^\$[A-Za-z_][A-Za-z0-9_]*$|^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(entry.apiKey)) {
    throw new Error(`LLM profile ${oldName} has a literal apiKey; move it to an environment variable before upgrading`);
  }
  engines[name] = { ...entry, kind: 'llm' };
}

for (const [oldName, raw] of Object.entries(agentProfiles)) {
  const entry = asObject(raw);
  const name = agentNames.get(oldName);
  engines[name] = { ...entry, kind: 'agent' };
}

const resolveProcessEngine = (entry, context) => {
  if (
    entry.profile !== undefined &&
    (typeof entry.profile !== 'string' || entry.profile.length === 0)
  ) {
    throw new Error(`${context} profile must be a non-empty string`);
  }
  const selected = typeof entry.profile === 'string' ? entry.profile : undefined;
  let mode = entry.mode;
  if (mode !== undefined && mode !== 'llm' && mode !== 'agent' && mode !== 'sdk') {
    throw new Error(
      `${context} has unsupported mode ${JSON.stringify(mode)}; expected "llm", "agent", or "sdk"`,
    );
  }

  if (mode === undefined && selected) {
    const matchesLlm = llmNames.has(selected);
    const matchesAgent = agentNames.has(selected);
    if (matchesLlm && matchesAgent) {
      throw new Error(
        `${context} profile ${JSON.stringify(selected)} is ambiguous; set mode to "llm", "agent", or "sdk" before upgrading`,
      );
    }
    if (matchesLlm) mode = 'llm';
    else if (matchesAgent) {
      mode = asObject(agentProfiles[selected]).platform === 'opencode-sdk' ? 'sdk' : 'agent';
    } else {
      throw new Error(`${context} references unknown profile ${JSON.stringify(selected)}`);
    }
  }

  if (mode === undefined) return undefined;
  const profile = selected ?? (mode === 'llm' ? oldDefaults.llm : oldDefaults.agent);
  if (typeof profile !== 'string') {
    throw new Error(`${context} mode ${JSON.stringify(mode)} requires a profile or matching default`);
  }

  if (mode === 'llm') {
    const engine = llmNames.get(profile);
    if (!engine) throw new Error(`${context} references unknown LLM profile ${JSON.stringify(profile)}`);
    return engine;
  }

  const engine = agentNames.get(profile);
  if (!engine) throw new Error(`${context} references unknown agent profile ${JSON.stringify(profile)}`);
  const platform = asObject(agentProfiles[profile]).platform;
  if (mode === 'sdk' && platform !== 'opencode-sdk') {
    throw new Error(
      `${context} mode "sdk" requires an agent profile with platform "opencode-sdk"`,
    );
  }
  if (mode === 'agent' && platform === 'opencode-sdk') {
    throw new Error(
      `${context} mode "agent" cannot use an "opencode-sdk" agent profile; use mode "sdk"`,
    );
  }
  return engine;
};

const convertProcess = (raw, context) => {
  const process = { ...asObject(raw) };
  const engine = resolveProcessEngine(process, context);
  if (engine) process.engine = engine;
  delete process.profile;
  delete process.mode;
  if (process.judgment) {
    const judgment = { ...asObject(process.judgment) };
    const judgmentEngine = resolveProcessEngine(judgment, `${context} judgment`);
    if (judgmentEngine) judgment.engine = judgmentEngine;
    delete judgment.profile;
    delete judgment.mode;
    process.judgment = judgment;
  }
  return process;
};

const improve = { ...asObject(source.improve) };
const strategies = { ...asObject(improve.strategies) };
const strategyNames = new Map();
const strategySlugOwners = new Map();
const existingStrategyNames = new Set(Object.keys(strategies));
for (const oldName of Object.keys(improveProfiles)) {
  const name = slug(oldName, 'custom');
  claimProfileSlug(strategySlugOwners, oldName, name, 'improve', 'strategy');
  if (existingStrategyNames.has(name)) {
    throw new Error(
      `improve profile ${JSON.stringify(oldName)} normalizes to existing strategy ${JSON.stringify(name)}`,
    );
  }
  strategyNames.set(oldName, name);
}
const supportedProcesses = new Set([
  'reflect',
  'distill',
  'consolidate',
  'memoryInference',
  'graphExtraction',
  'extract',
  'validation',
  'triage',
  'proactiveMaintenance',
]);
for (const [oldName, raw] of Object.entries(improveProfiles)) {
  const profile = { ...asObject(raw) };
  const name = strategyNames.get(oldName);
  if (Object.hasOwn(profile, 'autoAccept')) {
    throw new Error(
      `improve profile ${JSON.stringify(oldName)} sets autoAccept, which has no exact AKM 0.9 equivalent; drain existing proposals with \`akm proposal drain --promote --yes\` or explicitly choose triage \`applyMode: "promote"\`, then remove autoAccept and restart`,
    );
  }
  const processes = {};
  for (const [processName, rawProcess] of Object.entries(asObject(profile.processes))) {
    processes[processName] = convertProcess(
      rawProcess,
      `improve profile ${JSON.stringify(oldName)} process ${JSON.stringify(processName)}`,
    );
    if (!supportedProcesses.has(processName) && processes[processName].enabled === true) {
      processes[processName].enabled = false;
      process.stderr.write(
        `warning: disabled removed AKM improve process ${oldName}.${processName}; its configuration was preserved\n`,
      );
    }
  }
  if (Object.keys(processes).length > 0) profile.processes = processes;
  strategies[name] = profile;
}
if (Object.keys(strategies).length > 0) improve.strategies = strategies;

const defaults = { ...oldDefaults };
if (typeof oldDefaults.llm === 'string') defaults.llmEngine = llmNames.get(oldDefaults.llm) ?? slug(oldDefaults.llm, 'llm');
if (typeof oldDefaults.agent === 'string') defaults.engine = agentNames.get(oldDefaults.agent) ?? slug(oldDefaults.agent, 'agent');
else if (!defaults.engine && defaults.llmEngine) defaults.engine = defaults.llmEngine;
if (typeof oldDefaults.improve === 'string') {
  defaults.improveStrategy = strategyNames.get(oldDefaults.improve) ?? slug(oldDefaults.improve, 'custom');
}
delete defaults.llm;
delete defaults.agent;
delete defaults.improve;

const target = {
  ...source,
  configVersion: '0.9.0',
  engines,
  defaults,
  semanticSearchMode: source.semanticSearchMode ?? 'auto',
  improve,
};
for (const key of ['profiles', 'llm', 'agent', 'features', 'stashes', 'bindings', 'writable']) delete target[key];
if (!target.bundles && !target.stashDir) target.stashDir = process.env.AKM_BUNDLE_DIR || '/stash';
if (!target.bundles && typeof source.writable === 'boolean') {
  const sources = Array.isArray(target.sources) ? [...target.sources] : [];
  const primaryIndex = sources.findIndex((entry) => asObject(entry).primary === true);
  if (primaryIndex >= 0) {
    sources[primaryIndex] = { ...asObject(sources[primaryIndex]), writable: source.writable };
  } else {
    sources.unshift({
      type: 'filesystem',
      path: target.stashDir,
      primary: true,
      writable: source.writable,
    });
  }
  target.sources = sources;
}

writeAtomicDurable(targetPath, `${JSON.stringify(target, null, 2)}\n`);
