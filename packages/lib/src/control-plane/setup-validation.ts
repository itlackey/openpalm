/**
 * Validation logic for SetupSpec inputs.
 * Extracted from setup.ts to reduce per-file complexity.
 */

const CONNECTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function requireObj(val: unknown, msg: string, errors: string[]): Record<string, unknown> | null {
  if (typeof val !== "object" || val === null) { errors.push(msg); return null; }
  return val as Record<string, unknown>;
}

function requireStr(obj: Record<string, unknown>, key: string, msg: string, errors: string[]): boolean {
  if (typeof obj[key] !== "string" || !obj[key]) { errors.push(msg); return false; }
  return true;
}

export function validateSetupSpec(input: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const body = requireObj(input, "Input must be a non-null object", errors);
  if (!body) return { valid: false, errors };

  validateSecurity(body, errors);
  validateOwner(body, errors);
  validateConnectionsArray(body.connections, errors);
  validateSpecCapabilities(body, errors);
  if (body.channelCredentials !== undefined && (typeof body.channelCredentials !== "object" || body.channelCredentials === null)) {
    errors.push("channelCredentials must be an object if provided");
  }
  return { valid: errors.length === 0, errors };
}

function validateSecurity(body: Record<string, unknown>, errors: string[]): void {
  const security = requireObj(body.security, "security object is required", errors);
  if (!security) return;
  if (!requireStr(security, "adminToken", "security.adminToken is required and must be a non-empty string", errors)) return;
  if ((security.adminToken as string).length < 8) errors.push("security.adminToken must be at least 8 characters");
}

function validateOwner(body: Record<string, unknown>, errors: string[]): void {
  const owner = requireObj(body.owner, "owner is required (name and email)", errors);
  if (!owner) return;
  requireStr(owner, "name", "owner.name is required", errors);
  requireStr(owner, "email", "owner.email is required", errors);
}

function validateSpecCapabilities(body: Record<string, unknown>, errors: string[]): void {
  const spec = requireObj(body.spec, "spec object is required", errors);
  if (!spec) return;
  if (spec.version !== 2) errors.push("spec.version must be 2");
  const caps = requireObj(spec.capabilities, "spec.capabilities is required", errors);
  if (!caps) return;
  requireStr(caps, "llm", "spec.capabilities.llm is required (format: 'provider/model')", errors);
  const emb = requireObj(caps.embeddings, "spec.capabilities.embeddings is required", errors);
  if (emb) {
    requireStr(emb, "provider", "spec.capabilities.embeddings.provider is required", errors);
    requireStr(emb, "model", "spec.capabilities.embeddings.model is required", errors);
    if (emb.dims !== undefined && emb.dims !== 0 && (typeof emb.dims !== "number" || !Number.isInteger(emb.dims) || emb.dims < 1)) {
      errors.push("spec.capabilities.embeddings.dims must be a positive integer or 0 (auto-resolve)");
    }
  }
  const mem = requireObj(caps.memory, "spec.capabilities.memory is required", errors);
  if (!mem) return;
  if (mem.userId !== undefined && typeof mem.userId !== "string") errors.push("spec.capabilities.memory.userId must be a string if provided");
  if (typeof mem.userId === "string" && mem.userId && !/^[A-Za-z0-9_]+$/.test(mem.userId)) {
    errors.push("spec.capabilities.memory.userId contains invalid characters (alphanumeric and underscores only)");
  }
}

function validateConnectionsArray(connections: unknown, errors: string[]): void {
  if (!Array.isArray(connections)) {
    errors.push("connections must be an array");
    return;
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i];
    if (typeof c !== "object" || c === null) { errors.push(`connections[${i}] must be an object`); continue; }
    const conn = c as Record<string, unknown>;
    const id = typeof conn.id === "string" ? conn.id.trim() : "";
    const provider = typeof conn.provider === "string" ? conn.provider.trim() : "";
    const name = typeof conn.name === "string" ? conn.name.trim() : "";

    if (!id) errors.push(`connections[${i}].id is required`);
    else if (!CONNECTION_ID_RE.test(id)) errors.push(`connections[${i}].id must start with a letter or digit (allowed: A-Z, a-z, 0-9, _, -)`);
    else if (seenIds.has(id)) errors.push(`Duplicate connection ID: ${id}`);
    else seenIds.add(id);

    if (!name) errors.push(`connections[${i}].name is required`);
    if (!provider) errors.push(`connections[${i}].provider is required`);
  }
}
