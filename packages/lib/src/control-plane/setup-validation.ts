/**
 * Validation logic for SetupSpec inputs.
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

  if (body.version !== 2) errors.push("version must be 2");
  validateSecurity(body, errors);
  validateOwner(body, errors);
  validateConnectionsArray(body.connections, errors);
  validateLlm(body, errors);
  validateEmbedding(body, errors);
  if (body.portalCredentials !== undefined && (typeof body.portalCredentials !== "object" || body.portalCredentials === null)) {
    errors.push("portalCredentials must be an object if provided");
  }
  return { valid: errors.length === 0, errors };
}

function validateSecurity(body: Record<string, unknown>, errors: string[]): void {
  const security = requireObj(body.security, "security object is required", errors);
  if (!security) return;
  if (!requireStr(security, "uiLoginPassword", "security.uiLoginPassword is required and must be a non-empty string", errors)) return;
  if ((security.uiLoginPassword as string).length < 8) errors.push("security.uiLoginPassword must be at least 8 characters");
}

function validateOwner(body: Record<string, unknown>, errors: string[]): void {
  const owner = body.owner as Record<string, unknown> | undefined;
  if (!owner) return;
  if (owner.name !== undefined && typeof owner.name !== "string") errors.push("owner.name must be a string");
  if (owner.email !== undefined && typeof owner.email !== "string") errors.push("owner.email must be a string");
}

function validateLlm(body: Record<string, unknown>, errors: string[]): void {
  if (body.llm === undefined) return;
  const llm = requireObj(body.llm, "llm must be an object if provided", errors);
  if (!llm) return;
  requireStr(llm, "provider", "llm.provider is required", errors);
  requireStr(llm, "model", "llm.model is required", errors);
  if (llm.baseUrl !== undefined && typeof llm.baseUrl !== "string") errors.push("llm.baseUrl must be a string");
}

function validateEmbedding(body: Record<string, unknown>, errors: string[]): void {
  if (body.embedding === undefined) return;
  const emb = requireObj(body.embedding, "embedding must be an object if provided", errors);
  if (!emb) return;
  requireStr(emb, "provider", "embedding.provider is required", errors);
  requireStr(emb, "model", "embedding.model is required", errors);
  if (emb.dims !== undefined && (typeof emb.dims !== "number" || !Number.isInteger(emb.dims) || emb.dims < 1)) {
    errors.push("embedding.dims must be a positive integer");
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
