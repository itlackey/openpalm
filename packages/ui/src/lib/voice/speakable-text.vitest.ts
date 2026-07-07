import { describe, expect, test } from 'vitest';
import { toSpeakableText } from './speakable-text.js';

describe('toSpeakableText', () => {
  test('fenced code blocks become a spoken placeholder', () => {
    expect(toSpeakableText('before\n```js\nconst x = 1;\n```\nafter')).toBe(
      'before\nCode omitted.\nafter',
    );
  });

  test('inline code spans keep their text and drop the backticks', () => {
    expect(toSpeakableText('Use `npm install` to set up.')).toBe('Use npm install to set up.');
  });

  test('images become their alt text', () => {
    expect(toSpeakableText('![a cat](http://example.com/cat.png)')).toBe('a cat');
  });

  test('links become their label', () => {
    expect(toSpeakableText('[OpenPalm](https://openpalm.dev)')).toBe('OpenPalm');
  });

  test('bare URLs are reduced to their hostname', () => {
    expect(toSpeakableText('Visit https://example.com/page for more.')).toBe(
      'Visit example.com for more.',
    );
  });

  test('headings drop their leading # markers', () => {
    expect(toSpeakableText('# Title\nBody')).toBe('Title\nBody');
  });

  test('bold, italic, underline, and strikethrough markers are stripped', () => {
    expect(
      toSpeakableText(
        '**bold** and *italic* and __underline bold__ and _underline italic_ and ~~strike~~',
      ),
    ).toBe('bold and italic and underline bold and underline italic and strike');
  });

  test('blockquote markers are stripped', () => {
    expect(toSpeakableText('> quoted text')).toBe('quoted text');
  });

  test('unordered list markers are stripped and items get sentence punctuation', () => {
    expect(toSpeakableText('- item one\n- item two.')).toBe('item one.\nitem two.');
  });

  test('ordered list markers are stripped and items get sentence punctuation', () => {
    expect(toSpeakableText('1. first\n2. second')).toBe('first.\nsecond.');
  });

  test('table separator rows are dropped and cell pipes become commas', () => {
    expect(toSpeakableText('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('A, B\n1, 2');
  });

  test('horizontal rules are removed', () => {
    const result = toSpeakableText('above\n---\nbelow');
    expect(result).not.toContain('---');
    expect(result).toContain('above');
    expect(result).toContain('below');
  });

  test('raw HTML tags are stripped', () => {
    expect(toSpeakableText('Hello <b>world</b>')).toBe('Hello world');
  });

  test('common HTML entities are decoded', () => {
    expect(toSpeakableText('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
  });

  test('3+ newlines collapse to 2 and repeated spaces collapse to 1', () => {
    expect(toSpeakableText('a\n\n\n\nb   c')).toBe('a\n\nb c');
  });

  test('mixed markdown document strips every construct at once', () => {
    const input = [
      '# Report',
      '',
      'Check out [OpenPalm](https://openpalm.dev) or visit https://example.com/page directly.',
      '',
      'Run `npm test` to verify, or see the snippet:',
      '',
      '```js',
      'console.log("hi");',
      '```',
      '',
      '**Important:** the following applies:',
      '- first item',
      '- second item.',
      '',
      '| Name | Score |',
      '|------|-------|',
      '| Ann  | 9 |',
      '',
      '> Remember this note.',
      '',
      '---',
      '',
      'Done!',
    ].join('\n');

    expect(toSpeakableText(input)).toBe(
      [
        'Report',
        '',
        'Check out OpenPalm or visit example.com directly.',
        '',
        'Run npm test to verify, or see the snippet:',
        '',
        'Code omitted.',
        '',
        'Important: the following applies:',
        'first item.',
        'second item.',
        '',
        'Name, Score',
        'Ann, 9',
        '',
        'Remember this note.',
        '',
        'Done!',
      ].join('\n'),
    );
  });

  test('entity decoding cannot reintroduce markup', () => {
    expect(
      toSpeakableText('&lt;b&gt;bold&lt;/b&gt; and &lt;script&gt;alert(1)&lt;/script&gt;'),
    ).toBe('bold and alert(1)');
  });

  test('non-tag angle-bracket text like "<3" survives the post-decode strip', () => {
    expect(toSpeakableText('I &lt;3 markdown')).toBe('I <3 markdown');
    expect(toSpeakableText('I <3 markdown')).toBe('I <3 markdown');
  });
});
