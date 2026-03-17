/**
 * Connection profiles CRUD — re-exported from @openpalm/lib.
 */
export type { WriteConnectionsInput } from "@openpalm/lib";

export {
  getConnectionProfilesDir,
  getConnectionProfilesPath,
  writeConnectionProfilesDocument,
  readConnectionProfilesDocument,
  ensureConnectionProfilesStore,
  writeConnectionsDocument,
  listConnectionProfiles,
  getCapabilityAssignments,
  createConnectionProfile,
  updateConnectionProfile,
  deleteConnectionProfile,
  saveCapabilityAssignments,
} from "@openpalm/lib";
