/**
 * StackSpec v2 validation.
 *
 * Returns structured, actionable error messages with codes
 * so users can quickly identify and fix configuration issues.
 */

import type { StackSpec } from "./stack-spec.js";

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

  void (spec as unknown as StackSpec); // reserved for future validations
  return errors;
}
