#!/usr/bin/env node
// bump-unit.mjs — compute next version for a release unit and stamp unit files.
//
// Env in:
//   UNIT    — platform | portals | assistant | guardian | major
//   BUMP    — patch | minor | major  (ignored when UNIT=major)
//   STAMP   — 'true' to write files in place; any other value = compute-only (dry preview)
//
// Out (when GITHUB_OUTPUT is set):
//   new_version=X.Y.Z
//   current_version=X.Y.Z
//   tag_prefix=<unit>   (e.g. 'platform'; 'major' emits all per-unit as JSON in major_tags)
//
// Used by .github/workflows/release.yml.
// Preview locally: UNIT=platform BUMP=patch STAMP=false node scripts/bump-unit.mjs

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { setVersion } from './set-version.mjs';

function bumpVersion(current, type) {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) throw new Error(`Cannot parse version: ${current}`);
  let [, ma, mi, pa] = m;
  ma = +ma; mi = +mi; pa = +pa;
  switch (type) {
    case 'major': return `${ma + 1}.0.0`;
    case 'minor': return `${ma}.${mi + 1}.0`;
    case 'patch': return `${ma}.${mi}.${pa + 1}`;
    default: throw new Error(`Unknown bump type: ${type}`);
  }
}

function readJsonVersion(file) {
  return JSON.parse(readFileSync(file, 'utf8')).version;
}

function readFileVersion(file) {
  return readFileSync(file, 'utf8').trim();
}

function stampJsonFiles(files, version) {
  for (const f of files) {
    if (!existsSync(f)) throw new Error(`Cannot stamp: file not found: ${f}`);
    setVersion(f, version);
    console.log(`  ${f} → ${version}`);
  }
}

function stampSetupScripts(version) {
  for (const [file, pattern, replacement] of [
    ['scripts/setup.sh', /^SCRIPT_VERSION=".*"/m, `SCRIPT_VERSION="${version}"`],
    ['scripts/setup.ps1', /^\$ScriptVersion = '.*'/m, `$ScriptVersion = '${version}'`],
  ]) {
    const content = readFileSync(file, 'utf8');
    const updated = content.replace(pattern, replacement);
    writeFileSync(file, updated);
    console.log(`  ${file} → ${version}`);
  }
}

function stampVersionFile(file, version) {
  if (!existsSync(file)) throw new Error(`Cannot stamp: file not found: ${file}`);
  writeFileSync(file, version + '\n');
  console.log(`  ${file} → ${version}`);
}

// Unit definitions: anchor file (for reading current version) and files to stamp.
//
// IMPORTANT — version anchor semantics:
// Each unit's anchorFn reads that unit's OWN last independent release version,
// NOT the current platform version. It is normal for assistant/guardian/portals
// anchors to lag behind the platform version (e.g. platform=0.12.6, assistant=0.12.5)
// when those units have not had an independent release since the last platform cut.
// DO NOT stamp assistant/guardian/portals anchors during platform CI runs — that
// would couple independent units and generate noisy no-op commits.
// Docker push tags in release.yml come from OP_IMAGE_TAG / v${PLATFORM_VERSION},
// not from these anchors. Anchors are only read here to compute the NEXT version
// for an independent unit release.
const UNITS = {
  platform: {
    anchorFn: () => readJsonVersion('package.json'),
    stamp(version) {
      stampJsonFiles([
        'package.json',
        'packages/lib/package.json',
        'packages/cli/package.json',
        'packages/ui/package.json',
        'packages/electron/package.json',
        'packages/electron/admin-tools/package.json',
      ], version);
      stampSetupScripts(version);
    },
  },
  portals: {
    anchorFn: () => readJsonVersion('portals/discord/package.json'),
    stamp(version) {
      stampJsonFiles([
        'portals/discord/package.json',
        'portals/slack/package.json',
      ], version);
    },
  },
  assistant: {
    anchorFn: () => readFileVersion('containers/assistant/VERSION'),
    stamp(version) {
      stampVersionFile('containers/assistant/VERSION', version);
    },
  },
  guardian: {
    anchorFn: () => readJsonVersion('containers/guardian/package.json'),
    stamp(version) {
      stampJsonFiles(['containers/guardian/package.json'], version);
    },
  },
};

const unit = process.env.UNIT;
const bump = process.env.BUMP || 'patch';
const doStamp = process.env.STAMP === 'true';

if (!unit) {
  console.error('Error: UNIT env var is required (platform|portals|assistant|guardian|major)');
  process.exit(1);
}

let newVersion;
let currentVersion;
const out = process.env.GITHUB_OUTPUT;

if (unit === 'major') {
  // Major cut: increment major of the platform anchor, then stamp ALL units to X.0.0.
  currentVersion = UNITS.platform.anchorFn();
  newVersion = bumpVersion(currentVersion, 'major');
  console.log(`Major cut: ${currentVersion} → ${newVersion}`);
  console.log('Files to stamp:');
  if (doStamp) {
    for (const [name, cfg] of Object.entries(UNITS)) {
      console.log(`\n  [${name}]`);
      cfg.stamp(newVersion);
    }
  } else {
    console.log('  (STAMP=false — preview only)');
    for (const name of Object.keys(UNITS)) {
      const cur = UNITS[name].anchorFn();
      console.log(`  ${name}: ${cur} → ${newVersion}`);
    }
  }
  // Emit per-unit tag list for the major release job
  const majorTags = Object.keys(UNITS).map(n => `${n}-${newVersion}`);
  if (out) {
    appendFileSync(out, [
      `current_version=${currentVersion}`,
      `new_version=${newVersion}`,
      `tag_prefix=major`,
      `major_tags=${JSON.stringify(majorTags)}`,
    ].join('\n') + '\n');
  }
} else {
  const cfg = UNITS[unit];
  if (!cfg) {
    console.error(`Error: Unknown unit '${unit}'. Must be platform|portals|assistant|guardian|major`);
    process.exit(1);
  }
  currentVersion = cfg.anchorFn();
  newVersion = bumpVersion(currentVersion, bump);
  console.log(`${unit}: ${currentVersion} → ${newVersion} (${bump} bump)`);
  if (doStamp) {
    cfg.stamp(newVersion);
  } else {
    console.log('  (STAMP=false — preview only)');
  }
  if (out) {
    appendFileSync(out, [
      `current_version=${currentVersion}`,
      `new_version=${newVersion}`,
      `tag_prefix=${unit}`,
    ].join('\n') + '\n');
  }
}

console.log(`\nResult: ${newVersion}`);
