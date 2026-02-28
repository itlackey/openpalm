import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { p as parseRuntimeEnvContent, u as updateRuntimeEnvContent, a as setRuntimeBindScopeContent } from "./runtime-env.js";
import { dirname } from "node:path";
import { D as DATA_ENV_PATH, S as SECRETS_ENV_PATH, R as RUNTIME_ENV_PATH } from "./config.js";
const MAX_SECRETS_RAW_SIZE = 64 * 1024;
const fileLocks = /* @__PURE__ */ new Map();
async function withFileLock(path, fn) {
  const existing = fileLocks.get(path) ?? Promise.resolve();
  let resolve;
  const next = new Promise((r) => {
    resolve = r;
  });
  fileLocks.set(path, next);
  await existing;
  try {
    return await fn();
  } finally {
    resolve();
  }
}
function readRuntimeEnv() {
  if (!existsSync(RUNTIME_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(RUNTIME_ENV_PATH, "utf8"));
}
function updateRuntimeEnv(entries) {
  return withFileLock(RUNTIME_ENV_PATH, async () => {
    const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    mkdirSync(dirname(RUNTIME_ENV_PATH), { recursive: true });
    writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
  });
}
function setRuntimeBindScope(scope) {
  return withFileLock(RUNTIME_ENV_PATH, async () => {
    const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
    const next = setRuntimeBindScopeContent(current, scope);
    mkdirSync(dirname(RUNTIME_ENV_PATH), { recursive: true });
    writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
  });
}
function readSecretsEnv() {
  if (!existsSync(SECRETS_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(SECRETS_ENV_PATH, "utf8"));
}
function updateSecretsEnv(entries) {
  return withFileLock(SECRETS_ENV_PATH, async () => {
    const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
    writeFileSync(SECRETS_ENV_PATH, next, "utf8");
  });
}
function readSecretsRaw() {
  if (!existsSync(SECRETS_ENV_PATH)) return "";
  return readFileSync(SECRETS_ENV_PATH, "utf8");
}
function writeSecretsRaw(content) {
  void withFileLock(SECRETS_ENV_PATH, async () => {
    mkdirSync(dirname(SECRETS_ENV_PATH), { recursive: true });
    writeFileSync(SECRETS_ENV_PATH, content, "utf8");
  });
}
function validateSecretsRawContent(content) {
  if (content.length > MAX_SECRETS_RAW_SIZE) return "content exceeds maximum size (64 KB)";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("="))
      return `invalid env line (missing '='): ${trimmed.slice(0, 40)}`;
    const key = trimmed.split("=")[0].trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `invalid env key: ${key.slice(0, 40)}`;
  }
  return null;
}
function readDataEnv() {
  if (!existsSync(DATA_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(DATA_ENV_PATH, "utf8"));
}
function updateDataEnv(entries) {
  return withFileLock(DATA_ENV_PATH, async () => {
    const current = existsSync(DATA_ENV_PATH) ? readFileSync(DATA_ENV_PATH, "utf8") : "";
    const next = updateRuntimeEnvContent(current, entries);
    mkdirSync(dirname(DATA_ENV_PATH), { recursive: true });
    writeFileSync(DATA_ENV_PATH, next, "utf8");
  });
}
export {
  updateRuntimeEnv as a,
  updateSecretsEnv as b,
  readSecretsEnv as c,
  readSecretsRaw as d,
  readRuntimeEnv as e,
  readDataEnv as r,
  setRuntimeBindScope as s,
  updateDataEnv as u,
  validateSecretsRawContent as v,
  writeSecretsRaw as w
};
