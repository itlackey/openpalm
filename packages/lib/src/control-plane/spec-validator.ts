/**
 * StackSpec v4 validation.
 *
 * Returns structured, actionable error messages with codes
 * so users can quickly identify and fix configuration issues.
 */

import type { StackSpec, StackSpecConnection, StackSpecAssignments } from "./stack-spec.js";

export type ValidationError = {
  code: string;
  message: string;
  path?: string;
  hint?: string;
};

const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMAGE_NS_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateStackSpecV4(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];

  if (typeof input !== "object" || input === null) {
    errors.push({
      code: "OP-CFG-000",
      message: "Configuration must be an object",
      hint: "Check that the YAML file starts with valid configuration keys",
    });
    return errors;
  }

  const spec = input as Record<string, unknown>;

  // Version check
  if (spec.version !== 4) {
    errors.push({
      code: "OP-CFG-020",
      message: `Expected version: 4, got: ${spec.version ?? "(missing)"}`,
      path: "version",
      hint: spec.version === 3
        ? "Run: openpalm config migrate"
        : "Set version: 4 at the top of your config file",
    });
    return errors; // Cannot validate further without correct version
  }

  // Connections
  if (!Array.isArray(spec.connections)) {
    errors.push({
      code: "OP-CFG-001",
      message: "No connections defined",
      path: "connections",
      hint: "Add at least one connection entry",
    });
  } else {
    validateConnections(spec.connections as StackSpecConnection[], errors);
  }

  // Assignments
  if (typeof spec.assignments !== "object" || spec.assignments === null) {
    errors.push({
      code: "OP-CFG-002",
      message: "No model assignments defined",
      path: "assignments",
      hint: "Add assignments.llm and assignments.embeddings sections",
    });
  } else {
    const connectionIds = new Set(
      Array.isArray(spec.connections)
        ? (spec.connections as StackSpecConnection[]).map((c) => c.id)
        : [],
    );
    validateAssignments(
      spec.assignments as StackSpecAssignments,
      connectionIds,
      errors,
    );
  }

  // Ports
  if (spec.ports && typeof spec.ports === "object") {
    validatePorts(spec.ports as Record<string, unknown>, errors);
  }

  // Network
  if (spec.network && typeof spec.network === "object") {
    const net = spec.network as Record<string, unknown>;
    if (
      net.bindAddress !== undefined &&
      typeof net.bindAddress !== "string"
    ) {
      errors.push({
        code: "OP-CFG-011",
        message: "network.bindAddress must be a string",
        path: "network.bindAddress",
      });
    }
  }

  // Image
  if (spec.image && typeof spec.image === "object") {
    const img = spec.image as Record<string, unknown>;
    if (
      typeof img.namespace === "string" &&
      !IMAGE_NS_RE.test(img.namespace)
    ) {
      errors.push({
        code: "OP-CFG-012",
        message: `image.namespace "${img.namespace}" contains invalid characters`,
        path: "image.namespace",
        hint: "Use lowercase letters, numbers, dots, hyphens, or underscores",
      });
    }
  }

  return errors;
}

function validateConnections(
  connections: StackSpecConnection[],
  errors: ValidationError[],
): void {
  if (connections.length === 0) {
    errors.push({
      code: "OP-CFG-001",
      message: "connections list is empty",
      path: "connections",
      hint: "Add at least one connection entry",
    });
    return;
  }

  const ids = new Set<string>();
  for (let i = 0; i < connections.length; i++) {
    const c = connections[i];
    const prefix = `connections[${i}]`;

    if (c === null || typeof c !== "object") {
      errors.push({
        code: "OP-CFG-004",
        message: `${prefix} must be an object`,
        path: prefix,
      });
      continue;
    }

    if (!c.id || typeof c.id !== "string") {
      errors.push({
        code: "OP-CFG-004",
        message: `${prefix} is missing an id`,
        path: `${prefix}.id`,
      });
    } else if (!CONNECTION_ID_RE.test(c.id)) {
      errors.push({
        code: "OP-CFG-005",
        message: `${prefix}.id "${c.id}" is invalid`,
        path: `${prefix}.id`,
        hint: "Use lowercase letters, numbers, and hyphens (1-63 chars)",
      });
    } else if (ids.has(c.id)) {
      errors.push({
        code: "OP-CFG-006",
        message: `Duplicate connection id "${c.id}"`,
        path: `${prefix}.id`,
      });
    } else {
      ids.add(c.id);
    }

    if (!c.provider || typeof c.provider !== "string") {
      errors.push({
        code: "OP-CFG-004",
        message: `${prefix} is missing a provider`,
        path: `${prefix}.provider`,
      });
    }

    if (!c.name || typeof c.name !== "string") {
      errors.push({
        code: "OP-CFG-004",
        message: `${prefix} is missing a name`,
        path: `${prefix}.name`,
      });
    }
  }
}

function validateAssignments(
  assignments: StackSpecAssignments,
  connectionIds: Set<string>,
  errors: ValidationError[],
): void {
  // LLM assignment (required)
  if (!assignments.llm) {
    errors.push({
      code: "OP-CFG-002",
      message: "assignments.llm is required",
      path: "assignments.llm",
    });
  } else if (typeof assignments.llm !== "object" || assignments.llm === null) {
    errors.push({
      code: "OP-CFG-002",
      message: "assignments.llm must be an object",
      path: "assignments.llm",
    });
  } else {
    if (
      assignments.llm.connectionId &&
      !connectionIds.has(assignments.llm.connectionId)
    ) {
      errors.push({
        code: "OP-CFG-003",
        message: `assignments.llm.connectionId "${assignments.llm.connectionId}" does not match any connection`,
        path: "assignments.llm.connectionId",
        hint: `Available connections: ${[...connectionIds].join(", ") || "(none)"}`,
      });
    }
    if (!assignments.llm.model) {
      errors.push({
        code: "OP-CFG-008",
        message: "assignments.llm.model is required",
        path: "assignments.llm.model",
      });
    }
  }

  // Embeddings assignment (required)
  if (!assignments.embeddings) {
    errors.push({
      code: "OP-CFG-002",
      message: "assignments.embeddings is required",
      path: "assignments.embeddings",
    });
  } else if (typeof assignments.embeddings !== "object" || assignments.embeddings === null) {
    errors.push({
      code: "OP-CFG-002",
      message: "assignments.embeddings must be an object",
      path: "assignments.embeddings",
    });
  } else {
    if (
      assignments.embeddings.connectionId &&
      !connectionIds.has(assignments.embeddings.connectionId)
    ) {
      errors.push({
        code: "OP-CFG-003",
        message: `assignments.embeddings.connectionId "${assignments.embeddings.connectionId}" does not match any connection`,
        path: "assignments.embeddings.connectionId",
        hint: `Available connections: ${[...connectionIds].join(", ") || "(none)"}`,
      });
    }
    if (!assignments.embeddings.model) {
      errors.push({
        code: "OP-CFG-008",
        message: "assignments.embeddings.model is required",
        path: "assignments.embeddings.model",
      });
    }
    if (
      assignments.embeddings.dims !== undefined &&
      (typeof assignments.embeddings.dims !== "number" ||
        assignments.embeddings.dims < 1)
    ) {
      errors.push({
        code: "OP-CFG-009",
        message: "assignments.embeddings.dims must be a positive integer",
        path: "assignments.embeddings.dims",
        hint: "Common values: nomic-embed-text: 768, text-embedding-3-small: 1536",
      });
    }
  }

  // Optional assignments — validate connectionId if present
  for (const key of ["reranking", "tts", "stt"] as const) {
    const asgn = assignments[key];
    if (
      asgn &&
      typeof asgn === "object" &&
      asgn !== null &&
      "connectionId" in asgn &&
      asgn.connectionId &&
      !connectionIds.has(asgn.connectionId)
    ) {
      errors.push({
        code: "OP-CFG-003",
        message: `assignments.${key}.connectionId "${asgn.connectionId}" does not match any connection`,
        path: `assignments.${key}.connectionId`,
        hint: `Available connections: ${[...connectionIds].join(", ") || "(none)"}`,
      });
    }
  }
}

function validatePorts(
  ports: Record<string, unknown>,
  errors: ValidationError[],
): void {
  for (const [key, value] of Object.entries(ports)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push({
        code: "OP-CFG-010",
        message: `ports.${key} must be an integer`,
        path: `ports.${key}`,
      });
    } else if (value < 1 || value > 65535) {
      errors.push({
        code: "OP-CFG-010",
        message: `ports.${key} must be between 1 and 65535`,
        path: `ports.${key}`,
      });
    }
  }
}
