import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeHistory } from './prepare-native-history.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(parts) {
  const root = mkdtempSync(join(tmpdir(), 'openpalm-history-preparation-'));
  const from = join(root, 'original'); mkdirSync(from, { mode: 0o700 });
  const data = { info: { id: 'ses_fixture', directory: '/work' },
    messages: [{ info: { id: 'msg_fixture', sessionID: 'ses_fixture' }, parts }] };
  const raw = Buffer.from(JSON.stringify(data));
  writeFileSync(join(from, 'ses_fixture.json'), raw, { mode: 0o600 });
  const manifest = { product: 'fhold', version: 1, scope: 'native-history', engineVersion: '1.18.21',
    sessions: [{ id: 'ses_fixture', directory: '/work', messages: 1, parts: parts.length, sha256: hash(raw) }] };
  writeFileSync(join(from, 'history.json'), JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(join(from, 'source.sqlite'), 'synthetic cold companion', { mode: 0o600 });
  return { root, from, to: join(root, 'prepared'), data, raw, manifest };
}
const terminal = raw => ({ id: 'prt_fixture', messageID: 'msg_fixture', sessionID: 'ses_fixture',
  type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'synthetic' },
    error: 'synthetic failure', time: { start: 1, end: 2 }, metadata: { retained: true }, raw } });

test('prepares only an empty terminal parser buffer; original bytes and all content remain intact', () => {
  const f = fixture([terminal('')]);
  const result = prepareNativeHistory(f.from, f.to);
  assert.equal(result.archive, f.to); assert.equal(result.normalizedParts, 1);
  assert.deepEqual(readFileSync(join(f.from, 'ses_fixture.json')), f.raw);
  const actual = JSON.parse(readFileSync(join(f.to, 'ses_fixture.json')));
  delete f.data.messages[0].parts[0].state.raw;
  assert.deepEqual(actual, f.data);
  const manifest = JSON.parse(readFileSync(join(f.to, 'history.json')));
  assert.equal(manifest.sessions[0].sha256, hash(readFileSync(join(f.to, 'ses_fixture.json'))));
  assert.equal(manifest.engineVersion, f.manifest.engineVersion);
  assert.equal(manifest.sessions[0].parts, 1);
  assert.deepEqual(readFileSync(join(f.from, 'source.sqlite')), readFileSync(join(f.to, 'source.sqlite')));
  const receipt = JSON.parse(readFileSync(result.receipt));
  assert.equal(receipt.originalExportsRetained, true);
  assert.equal(receipt.normalizations[0].field, 'state.raw');
  assert.equal(statSync(f.to).mode & 0o777, 0o700);
  assert.equal(statSync(result.receipt).mode & 0o777, 0o600);
});

test('leaves all valid and unknown fields untouched when no empty terminal artifact exists', () => {
  const f = fixture([{ ...terminal('unfinished content'), state: { status: 'pending', raw: 'unfinished content', input: {} } },
    { id: 'prt_text', type: 'text', text: '', unfamiliar: { retained: true } }]);
  assert.deepEqual(prepareNativeHistory(f.from, f.to), { archive: f.from, normalizedParts: 0 });
  assert.equal(existsSync(f.to), false);
  assert.deepEqual(readFileSync(join(f.from, 'ses_fixture.json')), f.raw);
});

test('never discards nonempty, null or unknown terminal parser data and creates nothing', () => {
  for (const raw of ['meaningful', null, {}, 0]) {
    const f = fixture([terminal(raw)]);
    assert.throws(() => prepareNativeHistory(f.from, f.to), /requires manual review/);
    assert.equal(existsSync(f.to), false);
    assert.deepEqual(readFileSync(join(f.from, 'ses_fixture.json')), f.raw);
  }
});

test('checksum mismatch, linked files, occupied and overlapping destinations are refused', () => {
  const f = fixture([terminal('')]);
  writeFileSync(join(f.from, 'ses_fixture.json'), 'modified');
  assert.throws(() => prepareNativeHistory(f.from, f.to), /checksum/);
  assert.equal(existsSync(f.to), false);
  const linked = fixture([terminal('')]);
  symlinkSync(linked.from, join(linked.root, 'linked'));
  assert.throws(() => prepareNativeHistory(join(linked.root, 'linked'), linked.to), /real archive/);
  assert.throws(() => prepareNativeHistory(linked.from, join(linked.from, 'child')), /separate/);
  mkdirSync(linked.to);
  assert.throws(() => prepareNativeHistory(linked.from, linked.to), /must not exist/);
});

test('a completed tool preserves output, attachments and metadata exactly', () => {
  const part = terminal('');
  part.state = { status: 'completed', input: { command: 'synthetic' }, output: 'unchanged output',
    title: 'historical result', metadata: { custom: true }, attachments: [], time: { start: 1, end: 2 }, raw: '' };
  const f = fixture([part]); prepareNativeHistory(f.from, f.to);
  const actual = JSON.parse(readFileSync(join(f.to, 'ses_fixture.json')));
  delete f.data.messages[0].parts[0].state.raw;
  assert.deepEqual(actual, f.data);
});

test('preserves a failed tool title in supported metadata without changing its text or other values', () => {
  const part = terminal(''); part.state.title = 'Authored historical title';
  const f = fixture([part]); const result = prepareNativeHistory(f.from, f.to);
  const actual = JSON.parse(readFileSync(join(f.to, 'ses_fixture.json')));
  f.data.messages[0].parts[0].state.metadata.archivedTitle = part.state.title;
  delete f.data.messages[0].parts[0].state.title;
  delete f.data.messages[0].parts[0].state.raw;
  assert.deepEqual(actual, f.data);
  assert.equal(result.normalizedParts, 1);
  assert.equal(JSON.parse(readFileSync(result.receipt)).normalizations.length, 2);
  assert.deepEqual(readFileSync(join(f.from, 'ses_fixture.json')), f.raw);
});

test('refuses non-string titles and conflicting metadata instead of overwriting historical values', () => {
  for (const patch of [{ title: null }, { title: 'original', metadata: { archivedTitle: 'existing' } }]) {
    const part = terminal(''); Object.assign(part.state, patch);
    const f = fixture([part]);
    assert.throws(() => prepareNativeHistory(f.from, f.to), /requires manual review/);
    assert.equal(existsSync(f.to), false);
    assert.deepEqual(readFileSync(join(f.from, 'ses_fixture.json')), f.raw);
  }
});
