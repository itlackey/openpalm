/**
 * The Electron thin-harness ↔ control-plane contract (design §5.1).
 *
 * The desktop app is a THIN NATIVE HARNESS. Everything mutable (the @openpalm/ui
 * build, @openpalm/lib, the Docker stack images) self-updates
 * in place over the GitHub host-assets transport / `compose pull` with NO app
 * re-download. The ONE thing whose
 * change forces a re-download is this native contract surface — the boundary
 * between the frozen asar harness and the updatable control plane it spawns.
 *
 * `HARNESS_CONTRACT_VERSION` is a single integer that is bumped ONLY when a member
 * of the surface enumerated in `HARNESS_CONTRACT` changes its NAME, ARGUMENT
 * SHAPE, RETURN SHAPE, or required ENV KEY. It is independent of the app's
 * marketing version (`app.getVersion()`) and of the platform/control-plane version
 * (`PLATFORM_VERSION` in @openpalm/lib, which travels with the data/ui build).
 *
 * A host-assets manifest declares the minimum harness contract it needs;
 * the harness only self-updates the control plane when
 * `ui.minHarnessContract <= HARNESS_CONTRACT_VERSION`, otherwise it prompts a
 * re-download instead of failing at runtime (design §5.3).
 *
 * DISCIPLINE: when you change anything below, bump `HARNESS_CONTRACT_VERSION` and
 * update the `HARNESS_CONTRACT` description in the same commit. A snapshot test
 * fails CI until the bump is intentional.
 */
export const HARNESS_CONTRACT_VERSION = 2;

/**
 * Enumerated description of the §5.1 native contract surface. Kept as data (not
 * just prose) so a snapshot test can detect any drift and force a deliberate
 * `HARNESS_CONTRACT_VERSION` bump.
 */
export const HARNESS_CONTRACT = {
  version: HARNESS_CONTRACT_VERSION,

  /**
   * (a) Renderer IPC bridge — `preload.ts` exposes these on `window.openpalm`;
   * `main.ts` registers the matching `ipcMain` handlers / senders.
   */
  ipc: {
    /** Synchronous bridge reads (no IPC round-trip; read env stamped by main). */
    sync: ['updateStatus'] as const,
    /** Fire-and-forget renderer → main (`ipcRenderer.send`). */
    send: ['notify'] as const,
    /**
     * Request/response renderer → main (`ipcRenderer.invoke` ↔ `ipcMain.handle`).
     * `restartUiServer` (design §6.2) was already live in preload.ts/main.ts
     * before it was added here (remediation 3.2 fixed a contract-drift bug: this
     * enumeration had not been updated to match the real bridge surface) — its
     * addition corrects the record and is not itself a version-N bump because
     * the runtime capability, argument shape, and return shape are unchanged.
     */
    invoke: [
      'restart',
      'restartUiServer',
      'openLocalApp',
      'launchOnLoginStatus',
      'setLaunchOnLogin',
      'setTrayMicRecording',
      'requestMicPermission',
    ] as const,
    /** Push main → renderer; subscribed via the named bridge method. */
    push: [{ channel: 'global-mic-toggle', subscribe: 'onGlobalMicToggle' }] as const,
  },

  /**
   * (b) Spawn env contract — keys `buildUIServerEnv` (main.ts) injects into the
   * UI Node child's `process.env`. The control plane reads these; removing or
   * renaming a REQUIRED key is a contract change. (stack.env passthrough keys are
   * operator data, not part of the fixed contract.)
   */
  env: {
    required: [
      'OP_HOME',
      'HOST',
      'PORT',
      'ORIGIN',
      'OP_INSIDE_ELECTRON',
      'OP_ELECTRON_VERSION',
      'OP_HARNESS_CONTRACT_VERSION',
      'OP_OPENCODE_URL',
      'ELECTRON_RUN_AS_NODE',
    ] as const,
    optional: [
      'OPENPALM_SKELETON_DIR',
      'OP_ELECTRON_LATEST_VERSION',
      'OP_ELECTRON_LATEST_URL',
    ] as const,
  },

  /**
   * (c) Filesystem / path & spawn conventions the harness and control plane
   * agree on. Changing any of these is a contract change.
   */
  conventions: {
    /** Root of all runtime state (also passed as the OP_HOME env key). */
    opHome: 'OP_HOME',
    /** Updatable UI build location under OP_HOME (`resolveUiBuildDir` prefers it). */
    dataUi: 'data/ui',
    /** Bundled skeleton dir passed via OPENPALM_SKELETON_DIR (extraResources). */
    skeletonDir: 'OPENPALM_SKELETON_DIR',
    /** UI child is spawned with Electron's own Node (process.execPath + ELECTRON_RUN_AS_NODE=1). */
    spawn: 'process.execPath + ELECTRON_RUN_AS_NODE',
  },
} as const;
