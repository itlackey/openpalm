function parseEnvLine(line, options = {}) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return null;
  const [rawKey, ...rest] = trimmed.split("=");
  const key = rawKey.trim();
  if (!key) return null;
  let value = rest.join("=").trim();
  if (options.stripQuotedValues) {
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
  }
  return [key, value];
}
function parseEnvContent(content, options = {}) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line, options);
    if (!parsed) continue;
    out[parsed[0]] = parsed[1];
  }
  return out;
}
const RUNTIME_BIND_KEYS = {
  OPENPALM_INGRESS_BIND_ADDRESS: true,
  OPENPALM_OPENMEMORY_BIND_ADDRESS: true,
  OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS: true,
  OPENPALM_ASSISTANT_BIND_ADDRESS: true,
  OPENPALM_ASSISTANT_SSH_BIND_ADDRESS: true
};
function parseRuntimeEnvContent(content) {
  return parseEnvContent(content);
}
function updateRuntimeEnvContent(content, entries) {
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const managedKeys = new Set(Object.keys(entries));
  const next = [];
  const seen = /* @__PURE__ */ new Set();
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) {
      next.push(line);
      continue;
    }
    const [key] = parsed;
    if (!managedKeys.has(key)) {
      next.push(line);
      continue;
    }
    seen.add(key);
    const value = entries[key];
    if (typeof value === "string" && value.length > 0) {
      next.push(`${key}=${value}`);
    }
  }
  for (const [key, value] of Object.entries(entries)) {
    if (seen.has(key)) continue;
    if (typeof value === "string" && value.length > 0) next.push(`${key}=${value}`);
  }
  return next.join("\n").replace(/\n+$/, "") + "\n";
}
function setRuntimeBindScopeContent(content, scope) {
  const bindAddress = scope === "host" ? "127.0.0.1" : "0.0.0.0";
  const entries = {
    OPENPALM_INGRESS_BIND_ADDRESS: bindAddress,
    OPENPALM_OPENMEMORY_BIND_ADDRESS: bindAddress,
    OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS: bindAddress,
    OPENPALM_ASSISTANT_BIND_ADDRESS: bindAddress,
    OPENPALM_ASSISTANT_SSH_BIND_ADDRESS: bindAddress
  };
  const lines = content.length > 0 ? content.split(/\r?\n/) : [];
  const seen = /* @__PURE__ */ new Set();
  const next = lines.map((line) => {
    const parsed = parseEnvLine(line);
    if (!parsed) return line;
    const [key] = parsed;
    if (key in RUNTIME_BIND_KEYS) {
      seen.add(key);
      return `${key}=${entries[key]}`;
    }
    return line;
  });
  for (const [key, value] of Object.entries(entries)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return next.join("\n").replace(/\n+$/, "") + "\n";
}
function sanitizeEnvScalar(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n]+/g, "").trim();
}
export {
  setRuntimeBindScopeContent as a,
  parseRuntimeEnvContent as p,
  sanitizeEnvScalar as s,
  updateRuntimeEnvContent as u
};
