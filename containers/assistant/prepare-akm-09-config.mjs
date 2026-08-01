import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, targetPath] = process.argv.slice(2);
if (!sourcePath || !targetPath) throw new Error('usage: prepare-akm-09-config <source> <target>');

const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
if (!source || typeof source !== 'object' || Array.isArray(source)) {
  throw new Error('AKM config must be a JSON object');
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
const llmNames = new Map();
const agentNames = new Map();

for (const [oldName, raw] of Object.entries(llmProfiles)) {
  const entry = asObject(raw);
  const name = slug(oldName, 'llm');
  if (entry.apiKey && !/^\$[A-Z_][A-Z0-9_]*$|^\$\{[A-Z_][A-Z0-9_]*\}$/.test(entry.apiKey)) {
    throw new Error(`LLM profile ${oldName} has a literal apiKey; move it to an environment variable before upgrading`);
  }
  engines[name] = { ...entry, kind: 'llm' };
  llmNames.set(oldName, name);
}

for (const [oldName, raw] of Object.entries(agentProfiles)) {
  const entry = asObject(raw);
  const base = slug(oldName, 'agent');
  const name = engines[base] ? slug(`${base}-agent`, 'agent') : base;
  engines[name] = { ...entry, kind: 'agent' };
  agentNames.set(oldName, name);
}

const convertProcess = (raw) => {
  const process = { ...asObject(raw) };
  const selected = process.profile;
  if (typeof selected === 'string') process.engine = llmNames.get(selected) ?? agentNames.get(selected) ?? slug(selected, 'llm');
  delete process.profile;
  delete process.mode;
  if (process.judgment) {
    const judgment = { ...asObject(process.judgment) };
    if (typeof judgment.profile === 'string') {
      judgment.engine = llmNames.get(judgment.profile) ?? agentNames.get(judgment.profile) ?? slug(judgment.profile, 'llm');
    }
    delete judgment.profile;
    delete judgment.mode;
    process.judgment = judgment;
  }
  return process;
};

const improve = { ...asObject(source.improve) };
const strategies = { ...asObject(improve.strategies) };
const strategyNames = new Map();
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
  const name = slug(oldName, 'custom');
  const processes = {};
  for (const [processName, rawProcess] of Object.entries(asObject(profile.processes))) {
    processes[processName] = convertProcess(rawProcess);
    if (!supportedProcesses.has(processName) && processes[processName].enabled === true) {
      processes[processName].enabled = false;
      process.stderr.write(
        `warning: disabled removed AKM improve process ${oldName}.${processName}; its configuration was preserved\n`,
      );
    }
  }
  if (Object.keys(processes).length > 0) profile.processes = processes;
  delete profile.autoAccept;
  strategies[name] = profile;
  strategyNames.set(oldName, name);
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

writeFileSync(targetPath, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
