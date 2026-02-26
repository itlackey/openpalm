/**
 * Shared types for channel/service env var declarations.
 */

/** A single environment variable declaration. */
export type EnvVarDef = {
  /** Environment variable name (UPPER_CASE). */
  name: string;
  /** Help text describing the variable's purpose. */
  description?: string;
  /** Whether a value or secret reference must be provided. */
  required: boolean;
  /** Default value if none is provided. */
  default?: string;
};
