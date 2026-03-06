#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

const docs = [
  '.plans/connections/model-setup-wizard-prd.md',
  '.plans/connections/model-setup-wizard-ux-spec.md',
  '.plans/connections/model-setup-wizard-ui-copy-deck.md',
];

const canonicalCopyLine = '- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.';
const deckReferenceBanner = '> REFERENCE-ONLY: This file is a duplicate artifact for historical reference.';
const prohibitedScopePhrases = [
  /ollama\s+native\s+.*v1\s+required\s+scope/i,
  /ollama_native\s+.*v1\s+required\s+scope/i,
];

const expectedBlock = [
  '## Scope Decision (v1)',
  '- Connection types in scope: `openai_compatible_remote` and `openai_compatible_local`.',
  '- `ollama_native` is deferred and not required for v1 delivery.',
  '- Required capabilities: LLM and embeddings.',
  '- Optional capabilities: reranking, TTS, and STT.',
  '- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.',
].join('\n');

const pattern = /## Scope Decision \(v1\)\n(?:- .*\n){5}/;
const failures = [];

for (const relativePath of docs) {
  const content = readFileSync(resolve(repoRoot, relativePath), 'utf8');
  const match = content.match(pattern);
  const block = match?.[0]?.trimEnd() ?? '';
  if (!block) {
    failures.push(`${relativePath}: missing Scope Decision (v1) section`);
    continue;
  }
  if (block !== expectedBlock) {
    failures.push(`${relativePath}: Scope Decision (v1) section differs from expected canonical block`);
  }
  if (!content.includes(canonicalCopyLine)) {
    failures.push(`${relativePath}: canonical copy source declaration is missing`);
  }
  for (const phrase of prohibitedScopePhrases) {
    if (phrase.test(content)) {
      failures.push(`${relativePath}: contains prohibited scope phrasing matching ${String(phrase)}`);
    }
  }
}

const copyModulePath = 'core/admin/src/lib/setup-wizard/copy.ts';
const copyModule = readFileSync(resolve(repoRoot, copyModulePath), 'utf8');
if (!copyModule.includes("canonicalSourcePath: WIZARD_CANONICAL_COPY_SOURCE")) {
  failures.push(`${copyModulePath}: canonical source export not found`);
}

const deckPath = '.plans/connections/deck.md';
const deckContent = readFileSync(resolve(repoRoot, deckPath), 'utf8');
if (!deckContent.includes(deckReferenceBanner)) {
  failures.push(`${deckPath}: reference-only banner is missing`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`ERROR: ${failure}`);
  }
  process.exit(1);
}

console.log('Wizard scope docs validation passed.');
