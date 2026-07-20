import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const COMPONENT_PATH = fileURLToPath(new URL('./VoiceClientSettings.svelte', import.meta.url));

function componentSource(): string {
  return readFileSync(COMPONENT_PATH, 'utf-8');
}

describe('VoiceClientSettings route presentation', () => {
  test('identifies itself as the provider controls beneath the route heading', () => {
    const source = componentSource();
    expect(source).toMatch(/<h3>Speech providers<\/h3>/);
    expect(source).not.toMatch(/<h2>/);
  });

  test('does not force 280px or 240px columns beyond the mobile container', () => {
    const source = componentSource();
    expect(source).toMatch(/minmax\(min\(100%,\s*280px\),\s*1fr\)/);
    expect(source).toMatch(/minmax\(min\(100%,\s*240px\),\s*1fr\)/);
    expect(source).not.toMatch(/minmax\((?:280|240)px,\s*1fr\)/);
  });

  test('constrains the settings box and its fields to the available width', () => {
    const source = componentSource();
    expect(source).toMatch(/\.voice-settings\s*\{[\s\S]*?box-sizing:\s*border-box[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
    expect(source).toMatch(/\.field\s*\{[\s\S]*?min-width:\s*0/);
    expect(source).toMatch(/\.field input,[\s\S]*?\.field select\s*\{[\s\S]*?box-sizing:\s*border-box[\s\S]*?width:\s*100%[\s\S]*?min-width:\s*0/);
  });
});
