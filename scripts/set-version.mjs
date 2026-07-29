#!/usr/bin/env node
// Single source of truth for stamping a package.json's version.
//
// Product workspaces are source-only and use workspace:* references, so release
// stamping changes only each manifest's own version. Used by bump-unit.mjs and
// release workflows so there is exactly one place that writes that field.
import { readFileSync, writeFileSync } from 'node:fs';

const PRERELEASE_IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';

export const SEMVER_RE = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?$`,
);

export function parseSemver(version) {
  const match = String(version).match(SEMVER_RE);
  return match
    ? { ma: Number(match[1]), mi: Number(match[2]), pa: Number(match[3]), pre: match[4] ?? null }
    : null;
}

export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Cannot compare invalid semver: '${a}' and '${b}'`);
  for (const key of ['ma', 'mi', 'pa']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;

  const leftParts = left.pre.split('.');
  const rightParts = right.pre.split('.');
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    if (leftParts[i] === undefined) return -1;
    if (rightParts[i] === undefined) return 1;
    const leftNumeric = /^[0-9]+$/.test(leftParts[i]);
    const rightNumeric = /^[0-9]+$/.test(rightParts[i]);
    if (leftNumeric && rightNumeric) {
      if (Number(leftParts[i]) !== Number(rightParts[i])) {
        return Number(leftParts[i]) > Number(rightParts[i]) ? 1 : -1;
      }
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftParts[i] !== rightParts[i]) {
      return leftParts[i] > rightParts[i] ? 1 : -1;
    }
  }
  return 0;
}

/** Stamp `version` into a package.json file (in place). Returns the new version. */
export function setVersion(file, version) {
  if (!parseSemver(version)) {
    throw new Error(`version must be semver (e.g. 1.2.3 or 1.2.3-rc1), got '${version}'`);
  }
  const pkg = JSON.parse(readFileSync(file, 'utf-8'));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return version;
}
