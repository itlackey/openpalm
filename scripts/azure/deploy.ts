#!/usr/bin/env bun
/**
 * Minimal bootstrap for the Bicep deployment.
 *
 * What it does:
 * 1. Creates/updates the resource group.
 * 2. Creates Key Vault early so secrets can be written first.
 * 3. Generates missing internal secrets.
 * 4. Writes external provider secrets from env vars when present.
 * 5. Generates a temporary bicepparam file with concrete Key Vault URIs.
 * 6. Runs az deployment group create.
 *
 * This script intentionally does NOT recreate all Azure infrastructure imperatively.
 * Bicep is the source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

type Dict = Record<string, string>;

const root = process.cwd();
const templateDir = process.env.TEMPLATE_DIR || root;
const mainBicep = join(templateDir, 'main.bicep');
const baseParams = join(templateDir, 'prod.bicepparam');
const outDir = join(templateDir, '.generated');
const generatedParams = join(outDir, 'prod.generated.bicepparam');

const cfg = {
  subscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '',
  resourceGroup: process.env.RESOURCE_GROUP || 'rg-openpalm-prod',
  location: process.env.LOCATION || 'eastus2',
  keyVaultName: process.env.KEYVAULT_NAME || '',
  storageAccountName: process.env.STORAGE_ACCOUNT_NAME || '',
  prefix: process.env.PREFIX || 'openpalm-prod',
  aiFoundryAccountName: process.env.AI_FOUNDRY_ACCOUNT_NAME || '',
  deployAiFoundry: (process.env.DEPLOY_AI_FOUNDRY || 'false').toLowerCase() === 'true',
  deployOpenViking: (process.env.DEPLOY_OPENVIKING || 'false').toLowerCase() === 'true',
};

const internalSecrets: Dict = {
  'op-memory-token': process.env.OP_MEMORY_TOKEN || rand(32),
  'op-assistant-token': process.env.OP_ASSISTANT_TOKEN || rand(32),
  'op-admin-token': process.env.OP_ADMIN_TOKEN || rand(32),
  'op-opencode-password': process.env.OP_OPENCODE_PASSWORD || rand(24),
  'channel-api-secret': process.env.CHANNEL_API_SECRET || rand(32),
  'channel-chat-secret': process.env.CHANNEL_CHAT_SECRET || rand(32),
  ...(cfg.deployOpenViking ? { 'openviking-api-key': process.env.OPENVIKING_API_KEY || rand(32) } : {}),
};

const optionalSecrets: Dict = compact({
  'channel-discord-secret': process.env.CHANNEL_DISCORD_SECRET || '',
  'channel-slack-secret': process.env.CHANNEL_SLACK_SECRET || '',
  'channel-voice-secret': process.env.CHANNEL_VOICE_SECRET || '',
  'openai-api-key': process.env.OPENAI_API_KEY || '',
  'op-cap-llm-api-key': process.env.OP_CAP_LLM_API_KEY || process.env.OPENAI_API_KEY || '',
  'op-cap-embeddings-api-key': process.env.OP_CAP_EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY || '',
});

async function main() {
  ensureDir(outDir);

  if (!existsSync(mainBicep)) {
    throw new Error(`Missing ${mainBicep}`);
  }
  if (!existsSync(baseParams)) {
    throw new Error(`Missing ${baseParams}`);
  }

  await az('version');
  await az('extension', 'add', '--name', 'containerapp', '--upgrade', '--yes');

  await setSubscriptionIfNeeded();

  const keyVaultName = cfg.keyVaultName || uniqueName('openpalmkv', 20);
  const storageAccountName = cfg.storageAccountName || uniqueName('openpalmst', 22);

  await az('group', 'create', '-n', cfg.resourceGroup, '-l', cfg.location);

  const rgId = (await azJson('group', 'show', '-n', cfg.resourceGroup)).id as string;
  const kvExists = await existsKeyVault(keyVaultName);
  if (!kvExists) {
    await az(
      'keyvault', 'create',
      '-g', cfg.resourceGroup,
      '-n', keyVaultName,
      '-l', cfg.location,
      '--enable-rbac-authorization', 'true'
    );
  }

  // Assign Key Vault Secrets Officer to the deployer so secret writes succeed
  const kvScope = `/subscriptions/${cfg.subscriptionId}/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.KeyVault/vaults/${keyVaultName}`;
  try {
    const signedIn = await azJson('ad', 'signed-in-user', 'show');
    await az(
      'role', 'assignment', 'create',
      '--assignee-object-id', signedIn.id,
      '--assignee-principal-type', 'User',
      '--role', 'Key Vault Secrets Officer',
      '--scope', kvScope
    );
  } catch {
    console.warn('Could not auto-assign Key Vault Secrets Officer. Ensure the deployer has permission to write secrets.');
  }

  const allSecrets = Object.entries({ ...internalSecrets, ...optionalSecrets }).filter(([, v]) => !!v);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      for (const [name, value] of allSecrets) {
        const tmpFile = join(outDir, `.secret-${name}.tmp`);
        writeFileSync(tmpFile, value);
        try {
          await az('keyvault', 'secret', 'set', '--vault-name', keyVaultName, '--name', name, '--file', tmpFile, '--encoding', 'utf-8');
        } finally {
          try { unlinkSync(tmpFile); } catch {}
        }
      }
      break;
    } catch (err) {
      if (attempt < 3 && String(err).includes('Forbidden')) {
        const delaySec = attempt * 30;
        console.log(`RBAC not yet propagated, retrying in ${delaySec}s (attempt ${attempt}/3)...`);
        await new Promise(r => setTimeout(r, delaySec * 1000));
      } else {
        throw err;
      }
    }
  }

  const paramText = buildParams({ keyVaultName, storageAccountName });
  writeFileSync(generatedParams, paramText);

  const deployArgs = [
    'deployment', 'group', 'create',
    '-g', cfg.resourceGroup,
    '-f', mainBicep,
    '-p', generatedParams,
    '-p', `location=${cfg.location}`,
    '-p', `prefix=${cfg.prefix}`,
  ];
  if (cfg.deployAiFoundry) {
    deployArgs.push('-p', `deployAiFoundry=true`);
    if (cfg.aiFoundryAccountName) {
      deployArgs.push('-p', `aiFoundryAccountName=${cfg.aiFoundryAccountName}`);
    }
  }
  if (cfg.deployOpenViking) {
    deployArgs.push('-p', `deployOpenViking=true`);
  }
  deployArgs.push('--query', 'properties.outputs', '-o', 'jsonc');

  await az(...deployArgs);

  console.log('Deployment complete.');
  console.log(`Resource group:      ${cfg.resourceGroup}`);
  console.log(`Key Vault:           ${keyVaultName}`);
  console.log(`Storage account:     ${storageAccountName}`);
  if (cfg.deployAiFoundry) {
    const aiName = cfg.aiFoundryAccountName || `ai-${cfg.prefix}`;
    console.log(`AI Foundry account:  ${aiName}`);
    console.log(`AI Foundry endpoint: https://${aiName}.openai.azure.com/`);
  }
  if (cfg.deployOpenViking) {
    console.log(`OpenViking:          enabled`);
  }
  if (optionalSecrets['channel-slack-secret']) {
    console.log(`Slack channel:       enabled`);
  }
  console.log(`Generated params:    ${generatedParams}`);
  console.log(`Resource group id:   ${rgId}`);
}

function buildParams(args: { keyVaultName: string; storageAccountName: string }) {
  let text = readFileSync(baseParams, 'utf8');
  const aiFoundryName = cfg.aiFoundryAccountName || `ai-${cfg.prefix}`;
  const replacements: Dict = {
    'openpalmprod-kv-REPLACE': args.keyVaultName,
    'openpalmprodstREPL': args.storageAccountName,
    'ai-openpalm-prod': aiFoundryName,
  };

  for (const [from, to] of Object.entries(replacements)) {
    text = text.split(from).join(to);
  }

  // Fix the using path — generated file lives in .generated/ subdirectory
  text = text.replace("using './main.bicep'", "using '../main.bicep'");

  return text;
}

async function existsKeyVault(name: string) {
  try {
    await az('keyvault', 'show', '-n', name);
    return true;
  } catch {
    return false;
  }
}

async function setSubscriptionIfNeeded() {
  if (cfg.subscriptionId) {
    await az('account', 'set', '--subscription', cfg.subscriptionId);
    return;
  }
  const account = await azJson('account', 'show');
  cfg.subscriptionId = account.id as string;
}

async function azJson(...args: string[]) {
  const result = await run('az', [...args, '-o', 'json']);
  return JSON.parse(result.stdout);
}

async function az(...args: string[]) {
  return run('az', args);
}

async function run(cmd: string, args: string[]) {
  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${stderr || stdout}`);
  }

  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
  return { stdout, stderr, code };
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function rand(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

function uniqueName(prefix: string, maxLen: number) {
  const suffix = randomBytes(4).toString('hex');
  const base = prefix.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${base}${suffix}`.slice(0, maxLen);
}

function compact(obj: Dict) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => !!v));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
