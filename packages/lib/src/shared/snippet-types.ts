/**
 * Shared types for channel/service/automation env var declarations.
 *
 * All environment variables are strings. Values that reference secrets use
 * the ${SECRET_NAME} syntax validated by parseSecretReference() in stack-spec.
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

/** Trust tier indicating the provenance of a snippet. */
export type SnippetTrust = "official" | "curated" | "community";

/** The kind of resource a snippet defines. */
export type SnippetKind = "channel" | "service" | "automation";

/**
 * A community snippet definition (parsed from YAML).
 * Aligns with StackChannelConfig / StackServiceConfig from stack-spec.
 */
export type SnippetDef = {
  kind: SnippetKind;
  name: string;
  description?: string;
  supportsMultipleInstances?: boolean;
  image?: string;
  containerPort?: number;
  rewritePath?: string;
  sharedSecretEnv?: string;
  volumes?: string[];
  dependsOn?: string[];
  env: EnvVarDef[];
};

/** A snippet with trust/provenance information attached at runtime. */
export type ResolvedSnippet = SnippetDef & {
  trust: SnippetTrust;
  sourceId: string;
  sourceName: string;
};

/** GitHub topic conventions for snippet discovery.
 *  Each snippet type uses a dedicated topic so repos can be filtered by kind. */
export const SNIPPET_TOPICS = {
  channel: "openpalm-channel",
  service: "openpalm-service",
  automation: "openpalm-automation",
} as const satisfies Record<SnippetKind, string>;

/** A configured snippet source (for fetching remote indexes or discovering repos). */
export type SnippetSource = {
  /** Unique identifier for this source. */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  /** Discovery method. */
  type: "index-url" | "github-topic";
  /** URL to index (for index-url type) or GitHub topic string (for github-topic type). */
  target: string;
  /** Trust tier for all snippets from this source. */
  trust: SnippetTrust;
  /** Whether this source is enabled. */
  enabled: boolean;
};

/** Default snippet sources shipped with OpenPalm. */
export const DEFAULT_SNIPPET_SOURCES: SnippetSource[] = [
  {
    id: "openpalm-community",
    name: "OpenPalm Community",
    type: "index-url",
    target: "https://raw.githubusercontent.com/itlackey/openpalm/main/community/index.json",
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
  {
    id: "github-openpalm",
    name: "GitHub OpenPalm Repos",
    type: "github-topic",
    target: "openpalm",
    trust: "community",
    enabled: true,
  },
];

/**
 * Return "password" for env var names that look like secrets, "text" otherwise.
 * Convention: names containing SECRET, TOKEN, KEY, or PASSWORD are masked.
 */
export function inferInputType(envName: string): string {
  const upper = envName.toUpperCase();
  if (upper.includes("SECRET") || upper.includes("TOKEN") || upper.includes("KEY") || upper.includes("PASSWORD")) {
    return "password";
  }
  return "text";
}
