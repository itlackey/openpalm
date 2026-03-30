/**
 * Validation logic for SetupSpec inputs.
 * Extracted from setup.ts to reduce per-file complexity.
 */

const CAPABILITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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
  const owner = body.owner as Record<string, unknown> | undefined;
  if (!owner) return; // owner is optional
  if (owner.name !== undefined && typeof owner.name !== "string") errors.push("owner.name must be a string");
  if (owner.email !== undefined && typeof owner.email !== "string") errors.push("owner.email must be a string");
}

function validateSpecCapabilities(body: Record<string, unknown>, errors: string[]): void {
  if (body.version !== 2) errors.push("version must be 2");
  const caps = requireObj(body.capabilities, "capabilities is required", errors);
  if (!caps) return;
  requireStr(caps, "llm", "capabilities.llm is required (format: 'provider/model')", errors);
  const emb = requireObj(caps.embeddings, "capabilities.embeddings is required", errors);
  if (emb) {
    requireStr(emb, "provider", "capabilities.embeddings.provider is required", errors);
    requireStr(emb, "model", "capabilities.embeddings.model is required", errors);
    if (emb.dims !== undefined && emb.dims !== 0 && (typeof emb.dims !== "number" || !Number.isInteger(emb.dims) || emb.dims < 1)) {
      errors.push("capabilities.embeddings.dims must be a positive integer or 0 (auto-resolve)");
    }
  }
  const mem = requireObj(caps.memory, "capabilities.memory is required", errors);
  if (!mem) return;
  if (mem.userId !== undefined && typeof mem.userId !== "string") errors.push("capabilities.memory.userId must be a string if provided");
  if (typeof mem.userId === "string" && mem.userId && !/^[A-Za-z0-9_]+$/.test(mem.userId)) {
    errors.push("capabilities.memory.userId contains invalid characters (alphanumeric and underscores only)");
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
    const cap = c as Record<string, unknown>;
    const id = typeof cap.id === "string" ? cap.id.trim() : "";
    const provider = typeof cap.provider === "string" ? cap.provider.trim() : "";
    const name = typeof cap.name === "string" ? cap.name.trim() : "";

    if (!id) errors.push(`connections[${i}].id is required`);
    else if (!CAPABILITY_ID_RE.test(id)) errors.push(`connections[${i}].id must start with a letter or digit (allowed: A-Z, a-z, 0-9, _, -)`);
    else if (seenIds.has(id)) errors.push(`Duplicate capability ID: ${id}`);
    else seenIds.add(id);

    if (!name) errors.push(`connections[${i}].name is required`);
    if (!provider) errors.push(`connections[${i}].provider is required`);
  }
}
