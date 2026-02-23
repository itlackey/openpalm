/** Shared types for community snippet env var declarations and snippet metadata. */

/** Field types that the UI can render as form inputs. */
export type EnvVarFieldType = "text" | "secret" | "number" | "boolean" | "select" | "url" | "email";

/** A single option for select-type env var fields. */
export type EnvVarSelectOption = {
  label: string;
  value: string;
};

/** Rich metadata for a single environment variable declaration. */
export type EnvVarDef = {
  /** Environment variable name (UPPER_CASE). */
  name: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Help text describing the variable's purpose. */
  description?: string;
  /** Input field type. Defaults to "text". */
  type: EnvVarFieldType;
  /** Whether the field must have a value before the snippet can be enabled. */
  required: boolean;
  /** Default value. */
  default?: string;
  /** URL to external documentation for this field. */
  helpUrl?: string;
  /** Auto-generation hint (e.g. "random(64)", "uuid"). UI may offer to generate a value. */
  generate?: string;
  /** Options for select-type fields. */
  options?: EnvVarSelectOption[];
  /** Minimum value (number fields). */
  min?: number;
  /** Maximum value (number fields). */
  max?: number;
  /** Validation regex pattern. */
  pattern?: string;
};

/** Trust tier indicating the provenance of a snippet. */
export type SnippetTrust = "official" | "curated" | "community";

/** The kind of resource a snippet defines. */
export type SnippetKind = "channel" | "service" | "automation";

/** Snippet metadata block. */
export type SnippetMetadata = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  docUrl?: string;
  icon?: string;
};

/** Container configuration for channel/service snippets. */
export type SnippetContainer = {
  image?: string;
  port: number;
  rewritePath?: string;
  sharedSecretEnv?: string;
  volumes?: string[];
  dependsOn?: string[];
};

/** Automation configuration for automation snippets. */
export type SnippetAutomation = {
  schedule: string;
  script: string;
};

/** Security metadata for a snippet. */
export type SnippetSecurity = {
  risk?: "lowest" | "low" | "medium" | "medium-high" | "highest";
  permissions?: string[];
  notes?: string;
};

/** A fully-resolved snippet definition (parsed from YAML). */
export type SnippetDef = {
  apiVersion: string;
  kind: SnippetKind;
  metadata: SnippetMetadata;
  container?: SnippetContainer;
  automation?: SnippetAutomation;
  env: EnvVarDef[];
  security?: SnippetSecurity;
};

/** A snippet with trust/provenance information attached at runtime. */
export type ResolvedSnippet = SnippetDef & {
  /** Where this snippet was discovered. */
  trust: SnippetTrust;
  /** The source that provided this snippet. */
  sourceId: string;
  /** Display name of the source. */
  sourceName: string;
};

/** GitHub topic conventions for snippet discovery.
 *  Each snippet type uses a dedicated topic so repos can be filtered by kind. */
export const SNIPPET_TOPICS = {
  channel: "openpalm-channel",
  service: "openpalm-service",
  automation: "openpalm-automation",
} as const satisfies Record<SnippetKind, string>;

/** All snippet topics for broad discovery. */
export const ALL_SNIPPET_TOPICS = Object.values(SNIPPET_TOPICS);

/** A configured snippet source (for fetching remote indexes or discovering repos). */
export type SnippetSource = {
  /** Unique identifier for this source. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  /** Discovery method. */
  type: "index-url" | "github-topic";
  /** URL to index.yaml (for index-url type) or GitHub topic string (for github-topic type). */
  target: string;
  /** Trust tier for all snippets from this source. */
  trust: SnippetTrust;
  /** Whether this source is enabled. */
  enabled: boolean;
};

/** Default snippet sources shipped with OpenPalm. */
export const DEFAULT_SNIPPET_SOURCES: SnippetSource[] = [
  {
    id: "openpalm-builtin",
    name: "OpenPalm Built-in",
    type: "index-url",
    target: "",
    trust: "official",
    enabled: true,
  },
  {
    id: "openpalm-community",
    name: "OpenPalm Community",
    type: "index-url",
    target: "https://raw.githubusercontent.com/itlackey/openpalm/main/community/snippets/index.yaml",
    trust: "curated",
    enabled: true,
  },
  {
    id: "github-channels",
    name: "GitHub Community Channels",
    type: "github-topic",
    target: "openpalm-channel",
    trust: "community",
    enabled: true,
  },
  {
    id: "github-services",
    name: "GitHub Community Services",
    type: "github-topic",
    target: "openpalm-service",
    trust: "community",
    enabled: true,
  },
  {
    id: "github-automations",
    name: "GitHub Community Automations",
    type: "github-topic",
    target: "openpalm-automation",
    trust: "community",
    enabled: true,
  },
];
