/**
 * StackSpec v2 validation.
 *
 * Returns structured, actionable error messages with codes
 * so users can quickly identify and fix configuration issues.
 */

import type { StackSpec, StackSpecCapabilities } from "./stack-spec.js";

export type ValidationError = {
  code: string;
  message: string;
  path?: string;
  hint?: string;
};

const IMAGE_NS_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function validateStackSpec(input: unknown): ValidationError[] {
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
  if (spec.version !== 2) {
    errors.push({
      code: "OP-CFG-020",
      message: `Expected version: 2, got: ${spec.version ?? "(missing)"}`,
      path: "version",
      hint: "Set version: 2 at the top of your config file",
    });
    return errors;
  }

  // Capabilities
  if (typeof spec.capabilities !== "object" || spec.capabilities === null) {
    errors.push({
      code: "OP-CFG-001",
      message: "No capabilities defined",
      path: "capabilities",
      hint: "Add capabilities.llm and capabilities.embeddings sections",
    });
  } else {
    validateCapabilities(spec.capabilities as StackSpecCapabilities, errors);
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

function validateCapabilities(
  capabilities: StackSpecCapabilities,
  errors: ValidationError[],
): void {
  // LLM (required, "provider/model" string)
  if (!capabilities.llm || typeof capabilities.llm !== "string") {
    errors.push({
      code: "OP-CFG-008",
      message: "capabilities.llm is required (format: provider/model)",
      path: "capabilities.llm",
      hint: 'Example: "anthropic/claude-sonnet-4-5" or "ollama/qwen2.5-coder:3b"',
    });
  } else if (!capabilities.llm.includes("/")) {
    errors.push({
      code: "OP-CFG-008",
      message: `capabilities.llm "${capabilities.llm}" must be in provider/model format`,
      path: "capabilities.llm",
      hint: 'Example: "anthropic/claude-sonnet-4-5"',
    });
  }

  // SLM (optional, same format)
  if (capabilities.slm !== undefined) {
    if (typeof capabilities.slm !== "string") {
      errors.push({
        code: "OP-CFG-008",
        message: "capabilities.slm must be a string (format: provider/model)",
        path: "capabilities.slm",
      });
    } else if (!capabilities.slm.includes("/")) {
      errors.push({
        code: "OP-CFG-008",
        message: `capabilities.slm "${capabilities.slm}" must be in provider/model format`,
        path: "capabilities.slm",
      });
    }
  }

  // Embeddings (required object)
  if (!capabilities.embeddings || typeof capabilities.embeddings !== "object") {
    errors.push({
      code: "OP-CFG-002",
      message: "capabilities.embeddings is required",
      path: "capabilities.embeddings",
      hint: "Add provider, model, and dims fields",
    });
  } else {
    const emb = capabilities.embeddings;
    if (!emb.provider || typeof emb.provider !== "string") {
      errors.push({
        code: "OP-CFG-004",
        message: "capabilities.embeddings.provider is required",
        path: "capabilities.embeddings.provider",
      });
    }
    if (!emb.model || typeof emb.model !== "string") {
      errors.push({
        code: "OP-CFG-008",
        message: "capabilities.embeddings.model is required",
        path: "capabilities.embeddings.model",
      });
    }
    if (
      emb.dims !== undefined &&
      (typeof emb.dims !== "number" || emb.dims < 1)
    ) {
      errors.push({
        code: "OP-CFG-009",
        message: "capabilities.embeddings.dims must be a positive integer",
        path: "capabilities.embeddings.dims",
        hint: "Common values: nomic-embed-text: 768, text-embedding-3-small: 1536",
      });
    }
  }

  // Memory (required object)
  if (!capabilities.memory || typeof capabilities.memory !== "object") {
    errors.push({
      code: "OP-CFG-002",
      message: "capabilities.memory is required",
      path: "capabilities.memory",
      hint: "Add at minimum a userId field",
    });
  }
}
