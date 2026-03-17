/**
 * Connection mapping builders — re-exported from @openpalm/lib.
 */
export type {
  OpenCodeConnectionMappingInput,
  OpenCodeConnectionMapping,
  Mem0ConnectionMappingInput,
  Mem0ConnectionMapping,
} from "@openpalm/lib";

export {
  buildOpenCodeMapping,
  writeOpenCodeProviderConfig,
  buildMem0Mapping,
  resolveApiKeyRef,
  buildMem0MappingFromProfiles,
} from "@openpalm/lib";
