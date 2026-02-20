#!/usr/bin/env bun
/**
 * Version management for OpenPalm
 *
 * Usage: bun run scripts/version.ts <command> [args]
 *
 * Commands:
 *   status                             Show all component versions
 *   bump  <component|platform> <type>  Bump version (patch | minor | major)
 *   set   <component|platform> <ver>   Set an exact version string
 *   sync                               Sync every component to the platform version
 *   tag   [component|platform]          Create git tag(s) for current versions
 *   release <component|platform> <type> Bump → commit → tag (all-in-one)
 *
 * "platform" bumps the platform version AND every component together.
 * A specific component name bumps only that component.
 *
 * Examples:
 *   bun run scripts/version.ts status
 *   bun run scripts/version.ts bump platform patch
 *   bun run scripts/version.ts bump gateway minor
 *   bun run scripts/version.ts release cli patch
 *   bun run scripts/version.ts tag platform
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(SCRIPT_DIR, "..");
const VERSIONS_PATH = resolve(ROOT, "versions.json");
const ROOT_PKG_PATH = resolve(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Component registry
// ---------------------------------------------------------------------------

interface ComponentMeta {
  /** Docker build context (relative to repo root) */
  context: string;
  /** package.json to update version in (relative to repo root) */
  packageJson?: string;
  /** Extra files containing version strings to patch */
  extraFiles?: { path: string; pattern: RegExp; replacement: (v: string) => string }[];
  /** Whether this component produces a Docker image */
  image: boolean;
}

const COMPONENTS: Record<string, ComponentMeta> = {
  "opencode-core": { context: "opencode", image: true },
  gateway: { context: "gateway", image: true },
  admin: { context: "admin", image: true },
  "channel-chat": { context: "channels/chat", image: true },
  "channel-discord": { context: "channels/discord", image: true },
  "channel-voice": { context: "channels/voice", image: true },
  "channel-telegram": { context: "channels/telegram", image: true },
  cli: {
    context: "packages/cli",
    packageJson: "packages/cli/package.json",
    image: false,
    extraFiles: [
      {
        path: "packages/cli/src/main.ts",
        pattern: /const VERSION = "[^"]+"/,
        replacement: (v: string) => `const VERSION = "${v}"`,
      },
    ],
  },
};

const COMPONENT_NAMES = Object.keys(COMPONENTS);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Versions {
  platform: string;
  components: Record<string, string>;
}

type BumpType = "patch" | "minor" | "major";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: any): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function readVersions(): Versions {
  return readJson(VERSIONS_PATH);
}

function writeVersions(v: Versions): void {
  writeJson(VERSIONS_PATH, v);
}

function bumpSemver(version: string, type: BumpType): string {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${version}`);
  }
  const [major, minor, patch] = parts;
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function log(msg: string): void {
  console.log(msg);
}

function error(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}

function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// File patching
// ---------------------------------------------------------------------------

/**
 * Update the version field in a package.json file.
 */
function patchPackageJson(relPath: string, version: string): void {
  const absPath = resolve(ROOT, relPath);
  if (!existsSync(absPath)) return;
  const pkg = readJson(absPath);
  pkg.version = version;
  writeJson(absPath, pkg);
  log(`  ${dim("updated")} ${relPath} → ${version}`);
}

/**
 * Patch extra files (e.g. hardcoded VERSION constants).
 */
function patchExtraFiles(component: string, version: string): void {
  const meta = COMPONENTS[component];
  if (!meta?.extraFiles) return;
  for (const ef of meta.extraFiles) {
    const absPath = resolve(ROOT, ef.path);
    if (!existsSync(absPath)) continue;
    let content = readFileSync(absPath, "utf-8");
    content = content.replace(ef.pattern, ef.replacement(version));
    writeFileSync(absPath, content);
    log(`  ${dim("patched")} ${ef.path} → ${version}`);
  }
}

/**
 * Apply version changes for a single component to all relevant files.
 */
function applyComponentVersion(component: string, version: string): void {
  const meta = COMPONENTS[component];
  if (!meta) error(`Unknown component: ${component}`);

  // Update the component's own package.json if it has one
  if (meta.packageJson) {
    patchPackageJson(meta.packageJson, version);
  }

  // Patch any extra files
  patchExtraFiles(component, version);
}

/**
 * Apply a platform-wide version: updates versions.json, root package.json,
 * and every component's files.
 */
function applyPlatformVersion(version: string): void {
  const versions = readVersions();
  versions.platform = version;
  for (const name of COMPONENT_NAMES) {
    versions.components[name] = version;
    applyComponentVersion(name, version);
  }
  writeVersions(versions);
  patchPackageJson("package.json", version);
  log(`  ${dim("updated")} versions.json (platform + all components) → ${version}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdStatus(): void {
  const v = readVersions();
  log(bold("OpenPalm Version Status"));
  log("");
  log(`  ${bold("Platform:")}  ${green(v.platform)}`);
  log("");
  log(bold("  Components:"));

  const maxLen = Math.max(...COMPONENT_NAMES.map((n) => n.length));
  for (const name of COMPONENT_NAMES) {
    const ver = v.components[name] ?? dim("(not set)");
    const synced = ver === v.platform ? dim(" ✓ synced") : yellow(" ✗ differs");
    const type = COMPONENTS[name].image ? dim("[image]") : dim("[npm]  ");
    log(`    ${name.padEnd(maxLen)}  ${type}  ${green(ver)}${synced}`);
  }
  log("");
}

function cmdBump(target: string, type: BumpType): void {
  const versions = readVersions();

  if (target === "platform" || target === "all") {
    const newVer = bumpSemver(versions.platform, type);
    log(bold(`Bumping platform: ${versions.platform} → ${newVer} (${type})`));
    applyPlatformVersion(newVer);
  } else {
    if (!COMPONENTS[target]) error(`Unknown component: ${target}`);
    const oldVer = versions.components[target] ?? versions.platform;
    const newVer = bumpSemver(oldVer, type);
    log(bold(`Bumping ${target}: ${oldVer} → ${newVer} (${type})`));
    versions.components[target] = newVer;
    writeVersions(versions);
    applyComponentVersion(target, newVer);
    log(`  ${dim("updated")} versions.json → ${target}: ${newVer}`);
  }

  log(green("\nVersion bump complete."));
}

function cmdSet(target: string, version: string): void {
  // Validate semver format
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    error(`Invalid version format: ${version}  (expected: X.Y.Z)`);
  }

  const versions = readVersions();

  if (target === "platform" || target === "all") {
    log(bold(`Setting platform version to ${version}`));
    applyPlatformVersion(version);
  } else {
    if (!COMPONENTS[target]) error(`Unknown component: ${target}`);
    log(bold(`Setting ${target} version to ${version}`));
    versions.components[target] = version;
    writeVersions(versions);
    applyComponentVersion(target, version);
    log(`  ${dim("updated")} versions.json → ${target}: ${version}`);
  }

  log(green("\nVersion set complete."));
}

function cmdSync(): void {
  const versions = readVersions();
  log(bold(`Syncing all components to platform version: ${versions.platform}`));
  applyPlatformVersion(versions.platform);
  log(green("\nSync complete."));
}

function cmdTag(target: string): void {
  const versions = readVersions();

  if (target === "platform" || target === "all") {
    const tag = `v${versions.platform}`;
    log(bold(`Creating platform tag: ${tag}`));
    try {
      git(`tag -a ${tag} -m "Release ${tag}"`);
      log(green(`  Created tag: ${tag}`));
    } catch {
      log(yellow(`  Tag ${tag} already exists, skipping.`));
    }

    // Also create component-specific tags if versions differ from platform
    for (const name of COMPONENT_NAMES) {
      const compVer = versions.components[name];
      if (compVer && compVer !== versions.platform) {
        const compTag = `${name}/v${compVer}`;
        try {
          git(`tag -a ${compTag} -m "Release ${name} ${compTag}"`);
          log(green(`  Created tag: ${compTag}`));
        } catch {
          log(yellow(`  Tag ${compTag} already exists, skipping.`));
        }
      }
    }
  } else {
    if (!COMPONENTS[target]) error(`Unknown component: ${target}`);
    const ver = versions.components[target];
    if (!ver) error(`No version set for ${target}`);
    const tag = `${target}/v${ver}`;
    log(bold(`Creating component tag: ${tag}`));
    try {
      git(`tag -a ${tag} -m "Release ${target} ${tag}"`);
      log(green(`  Created tag: ${tag}`));
    } catch {
      log(yellow(`  Tag ${tag} already exists, skipping.`));
    }
  }

  log(dim("\nPush tags with: git push origin --tags"));
}

function cmdRelease(target: string, type: BumpType): void {
  // 1. Bump
  cmdBump(target, type);

  const versions = readVersions();

  // 2. Stage changed files
  log(bold("\nStaging changes..."));
  git("add versions.json package.json");

  if (target === "platform" || target === "all") {
    // Stage all component files
    for (const name of COMPONENT_NAMES) {
      const meta = COMPONENTS[name];
      if (meta.packageJson) git(`add ${meta.packageJson}`);
      if (meta.extraFiles) {
        for (const ef of meta.extraFiles) git(`add ${ef.path}`);
      }
    }
  } else {
    const meta = COMPONENTS[target];
    if (meta.packageJson) git(`add ${meta.packageJson}`);
    if (meta.extraFiles) {
      for (const ef of meta.extraFiles) git(`add ${ef.path}`);
    }
  }

  // 3. Commit
  const commitTarget = target === "platform" || target === "all" ? "platform" : target;
  const newVer =
    commitTarget === "platform" ? versions.platform : versions.components[target];
  const commitMsg =
    commitTarget === "platform"
      ? `release: bump platform to v${newVer}`
      : `release(${target}): bump to v${newVer}`;

  log(bold(`Committing: ${commitMsg}`));
  git(`commit -m "${commitMsg}"`);

  // 4. Tag
  log("");
  cmdTag(target);

  log(green("\nRelease prepared. Push with:"));
  log(`  git push origin HEAD --follow-tags`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const BUMP_TYPES = new Set(["patch", "minor", "major"]);
const VALID_TARGETS = new Set(["platform", "all", ...COMPONENT_NAMES]);

function printUsage(): void {
  log(bold("openpalm version manager"));
  log("");
  log(bold("Usage:") + " bun run scripts/version.ts <command> [args]");
  log("");
  log(bold("Commands:"));
  log("  status                              Show all component versions");
  log("  bump  <component|platform> <type>   Bump version (patch | minor | major)");
  log("  set   <component|platform> <ver>    Set an exact version (X.Y.Z)");
  log("  sync                                Sync all components to platform version");
  log("  tag   [component|platform]           Create git tag(s) for current versions");
  log("  release <component|platform> <type> Bump + commit + tag (all-in-one)");
  log("");
  log(bold("Components:"));
  for (const name of COMPONENT_NAMES) {
    const meta = COMPONENTS[name];
    log(`  ${name.padEnd(20)} ${meta.image ? "[Docker image]" : "[npm package]"}`);
  }
  log("");
  log(bold("Examples:"));
  log("  bun run scripts/version.ts status");
  log("  bun run scripts/version.ts bump platform patch");
  log("  bun run scripts/version.ts bump gateway minor");
  log("  bun run scripts/version.ts set cli 1.0.0");
  log("  bun run scripts/version.ts release platform minor");
  log("  bun run scripts/version.ts tag cli");
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "status":
    cmdStatus();
    break;

  case "bump": {
    const [target, type] = args;
    if (!target || !type) error("Usage: bump <component|platform> <patch|minor|major>");
    if (!VALID_TARGETS.has(target)) error(`Unknown target: ${target}. Use: ${[...VALID_TARGETS].join(", ")}`);
    if (!BUMP_TYPES.has(type)) error(`Unknown bump type: ${type}. Use: patch, minor, major`);
    cmdBump(target, type as BumpType);
    break;
  }

  case "set": {
    const [target, version] = args;
    if (!target || !version) error("Usage: set <component|platform> <X.Y.Z>");
    if (!VALID_TARGETS.has(target)) error(`Unknown target: ${target}. Use: ${[...VALID_TARGETS].join(", ")}`);
    cmdSet(target, version);
    break;
  }

  case "sync":
    cmdSync();
    break;

  case "tag": {
    const target = args[0] ?? "platform";
    if (!VALID_TARGETS.has(target)) error(`Unknown target: ${target}. Use: ${[...VALID_TARGETS].join(", ")}`);
    cmdTag(target);
    break;
  }

  case "release": {
    const [target, type] = args;
    if (!target || !type) error("Usage: release <component|platform> <patch|minor|major>");
    if (!VALID_TARGETS.has(target)) error(`Unknown target: ${target}. Use: ${[...VALID_TARGETS].join(", ")}`);
    if (!BUMP_TYPES.has(type)) error(`Unknown bump type: ${type}. Use: patch, minor, major`);
    cmdRelease(target, type as BumpType);
    break;
  }

  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;

  default:
    error(`Unknown command: ${command}\nRun with --help for usage.`);
}
