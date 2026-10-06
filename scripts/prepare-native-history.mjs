#!/usr/bin/env node
// Source-side transition only. Never changes original exports or native databases.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, closeSync,
  readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function read(path, limit) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= limit,
      'Expected a bounded regular private history file.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
const inside = (root, path) => {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
};

export function prepareNativeHistory(source, destination) {
  const archive = resolve(source);
  assert.ok(lstatSync(archive).isDirectory() && realpathSync(archive) === archive,
    'Select the exact real archive directory.');
  const prepared = resolve(destination);
  assert.equal(existsSync(prepared), false, 'Prepared archive must not exist.');
  assert.equal(realpathSync(dirname(prepared)), dirname(prepared), 'Select a real existing parent.');
  assert.ok(!inside(archive, prepared) && !inside(prepared, archive), 'Keep archives separate.');
  const manifestBytes = read(join(archive, 'history.json'), 64 * 1024 ** 2);
  const manifest = JSON.parse(manifestBytes);
  assert.ok(manifest.product === 'fhold' && manifest.version === 1 &&
    manifest.scope === 'native-history' && Array.isArray(manifest.sessions) && manifest.sessions.length <= 10_000,
    'Invalid native history manifest.');
  const seen = new Set();
  const normalizations = [];
  let bytes = 0;
  for (const entry of manifest.sessions) {
    assert.ok(typeof entry.id === 'string' && /^ses_[A-Za-z0-9]{1,128}$/.test(entry.id) && !seen.has(entry.id), 'Invalid or duplicate session ID.');
    seen.add(entry.id);
    const raw = read(join(archive, `${entry.id}.json`), 256 * 1024 ** 2);
    bytes += raw.length;
    assert.ok(bytes <= 20 * 1024 ** 3 && digest(raw) === entry.sha256, 'Original export checksum/size mismatch.');
    const data = JSON.parse(raw);
    assert.ok(data.info?.id === entry.id && Array.isArray(data.messages), 'Invalid native session export.');
    for (const message of data.messages) {
      assert.ok(Array.isArray(message.parts), 'Invalid native message parts.');
      for (const part of message.parts) {
        const state = part.state;
        if (part.type !== 'tool' || !state || !['error', 'completed'].includes(state.status)) continue;
        // Native terminal tool states have no parser buffer. Only the exactly
        // empty legacy artifact is safe to omit; meaningful/unknown data blocks.
        if (Object.hasOwn(state, 'raw')) {
          assert.equal(state.raw, '', 'Nonempty or unknown terminal parser data requires manual review; original exports retained.');
          normalizations.push({ session: entry.id, message: message.info.id, part: part.id,
            field: 'state.raw', reason: 'Empty parser buffer is not part of a native terminal tool state' });
        }
        // A failed call can retain its former running-state title. Preserve that
        // text in native free-form metadata, not an unsupported error-state key.
        if (state.status === 'error' && Object.hasOwn(state, 'title')) {
          assert.ok(typeof state.title === 'string' && (state.metadata === undefined ||
            (state.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata))) &&
            !Object.hasOwn(state.metadata ?? {}, 'archivedTitle'),
            'Historical title or metadata conflict requires manual review; original exports retained.');
          normalizations.push({ session: entry.id, message: message.info.id, part: part.id,
            field: 'state.title', destination: 'state.metadata.archivedTitle',
            reason: 'Preserve former running-state title using supported native error metadata' });
        }
      }
    }
  }
  if (!normalizations.length) return { archive, normalizedParts: 0 };
  process.umask(0o077);
  mkdirSync(prepared, { mode: 0o700 });
  for (const entry of manifest.sessions) {
    const raw = read(join(archive, `${entry.id}.json`), 256 * 1024 ** 2);
    assert.equal(digest(raw), entry.sha256, 'Original export changed during preparation.');
    const changed = normalizations.some(item => item.session === entry.id);
    let output = raw;
    if (changed) {
      const data = JSON.parse(raw);
      for (const message of data.messages) for (const part of message.parts) {
        if (part.type === 'tool' && ['error', 'completed'].includes(part.state?.status) && part.state.raw === '')
          delete part.state.raw;
        if (part.type === 'tool' && part.state?.status === 'error' && Object.hasOwn(part.state, 'title')) {
          part.state.metadata = { ...part.state.metadata, archivedTitle: part.state.title };
          delete part.state.title;
        }
      }
      output = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
      entry.sha256 = digest(output);
    }
    writeFileSync(join(prepared, `${entry.id}.json`), output, { flag: 'wx', mode: 0o600 });
  }
  // Preserve optional standard archive companions, including the original cold
  // snapshot. The source archive and every original byte remain unchanged.
  for (const name of ['source.sqlite', 'source.json']) {
    const from = join(archive, name);
    if (!existsSync(from)) continue;
    const stat = lstatSync(from);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Unsafe archive companion.');
    copyFileSync(from, join(prepared, name), constants.COPYFILE_EXCL);
  }
  writeFileSync(join(prepared, 'history.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const receipt = join(prepared, 'normalization.json');
  writeFileSync(receipt, `${JSON.stringify({ sourceArchive: archive,
    sourceManifestSha256: digest(manifestBytes), originalExportsRetained: true,
    normalizations }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { archive: prepared, normalizedParts: new Set(normalizations.map(item => item.part)).size, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
    assert.ok(values.from && values.to, 'Usage: node scripts/prepare-native-history.mjs --from /raw/archive --to /new/prepared/archive');
    console.log(JSON.stringify(prepareNativeHistory(values.from, values.to), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
