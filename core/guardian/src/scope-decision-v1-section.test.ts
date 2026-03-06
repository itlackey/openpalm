import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

const FILES = [
  '.plans/connections/model-setup-wizard-prd.md',
  '.plans/connections/model-setup-wizard-ux-spec.md',
  '.plans/connections/model-setup-wizard-ui-copy-deck.md',
] as const;

const EXPECTED_SCOPE_BLOCK = [
  '## Scope Decision (v1)',
  '- Connection types in scope: `openai_compatible_remote` and `openai_compatible_local`.',
  '- `ollama_native` is deferred and not required for v1 delivery.',
  '- Required capabilities: LLM and embeddings.',
  '- Optional capabilities: reranking, TTS, and STT.',
  '- Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.',
].join('\n');

const scopeDecisionPattern = /## Scope Decision \(v1\)\n(?:- .*\n){5}/;

function readSectionBlock(relativePath: string): string {
  const content = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  const match = content.match(scopeDecisionPattern);
  expect(match).not.toBeNull();
  return match![0].trimEnd();
}

describe('Scope Decision (v1) docs alignment', () => {
  it('uses the exact same Scope Decision (v1) section block in all three files', () => {
    const blocks = FILES.map(readSectionBlock);

    expect(blocks[0]).toBe(EXPECTED_SCOPE_BLOCK);
    expect(blocks[1]).toBe(blocks[0]);
    expect(blocks[2]).toBe(blocks[0]);
  });

  it('includes the expected scope lines for kinds, capabilities, and canonical source', () => {
    const block = readSectionBlock(FILES[0]);

    expect(block).toContain('`openai_compatible_remote` and `openai_compatible_local`.');
    expect(block).toContain('`ollama_native` is deferred and not required for v1 delivery.');
    expect(block).toContain('Required capabilities: LLM and embeddings.');
    expect(block).toContain('Optional capabilities: reranking, TTS, and STT.');
    expect(block).toContain('Canonical UX copy source: `.plans/connections/model-setup-wizard-ui-copy-deck.md`.');
  });
});
