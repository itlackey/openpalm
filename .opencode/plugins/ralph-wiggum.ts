import type { Plugin } from "@opencode-ai/plugin"
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"

const STATE_FILENAME = "ralph-loop.local.md"
const OPENCODE_DIR = ".opencode"
const WORKTREES_DIR = ".worktrees"
const REGISTRY_FILENAME = "worktrees.local.json"
const SESSION_PENDING = "__PENDING_CLAIM__"
const REGISTRY_PENDING_PREFIX = "pending:"

type RalphState = {
  active: boolean
  sessionId: string | null
  iteration: number
  maxIterations: number
  completionPromise: string | null
  prompt: string
}

type RegistryEntry = {
  branch: string
  path: string
  iteration: number
  started_at: string
}

type Registry = Record<string, RegistryEntry>

// Per-session guard: prevents concurrent event handler execution per session.
// Each session gets its own guard so parallel loops don't block each other.
const processing = new Set<string>()

// Global claim lock: prevents two sessions from racing to claim the same
// unclaimed state file during the scan phase.
let claimLock = false

// In-memory cache: session ID -> absolute path to that session's state file.
// Once a session claims a state file, we cache the mapping so subsequent
// idle events skip the scan phase entirely.
const sessionStateMap = new Map<string, string>()

function parseStateFile(content: string): RalphState | null {
  try {
    // Extract YAML frontmatter (between --- markers) and body
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!frontmatterMatch) return null

    const yaml = frontmatterMatch[1]
    const prompt = frontmatterMatch[2].trim()

    const getField = (key: string): string | null => {
      const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
      return match ? match[1].trim() : null
    }

    const iteration = parseInt(getField("iteration") ?? "0", 10)
    const maxIterations = parseInt(getField("max_iterations") ?? "0", 10)
    const rawPromise = getField("completion_promise")
    const completionPromise =
      rawPromise === "null" || rawPromise === null
        ? null
        : rawPromise.replace(/^"(.*)"$/, "$1")

    if (isNaN(iteration) || isNaN(maxIterations)) return null

    const rawSessionId = getField("session_id")
    const sessionId =
      rawSessionId === "null" || rawSessionId === null || rawSessionId === SESSION_PENDING
        ? null
        : rawSessionId.replace(/^"(.*)"$/, "$1")

    return {
      active: getField("active") === "true",
      sessionId,
      iteration,
      maxIterations,
      completionPromise,
      prompt,
    }
  } catch {
    return null
  }
}

function updateIteration(filePath: string, newIteration: number): void {
  const content = readFileSync(filePath, "utf-8")
  const updated = content.replace(/^iteration: .+$/m, `iteration: ${newIteration}`)
  writeFileSync(filePath, updated)
}

function claimSession(filePath: string, sessionId: string): void {
  const content = readFileSync(filePath, "utf-8")
  if (content.match(/^session_id: /m)) {
    const updated = content.replace(/^session_id: .+$/m, `session_id: "${sessionId}"`)
    writeFileSync(filePath, updated)
  } else {
    const updated = content.replace(/^(active: .+)$/m, `$1\nsession_id: "${sessionId}"`)
    writeFileSync(filePath, updated)
  }
}

function checkCompletionPromise(text: string, promise: string | null): boolean {
  if (!promise) return false
  const match = text.match(/<promise>([\s\S]*?)<\/promise>/)
  if (!match) return false
  // Normalize whitespace for comparison
  return match[1].trim().replace(/\s+/g, " ") === promise
}

function readState(stateFilePath: string): RalphState | null {
  if (!existsSync(stateFilePath)) return null
  const content = readFileSync(stateFilePath, "utf-8")
  return parseStateFile(content)
}

/**
 * Scan for all ralph-loop state files: repo root + all worktrees.
 * Returns an array of absolute paths to state files.
 */
function scanForStateFiles(repoRoot: string): string[] {
  const files: string[] = []

  // Check repo root state file
  const rootState = join(repoRoot, OPENCODE_DIR, STATE_FILENAME)
  if (existsSync(rootState)) {
    files.push(resolve(rootState))
  }

  // Check all worktree directories
  const worktreesDir = join(repoRoot, WORKTREES_DIR)
  if (existsSync(worktreesDir)) {
    try {
      const entries = readdirSync(worktreesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const worktreeState = join(worktreesDir, entry.name, OPENCODE_DIR, STATE_FILENAME)
          if (existsSync(worktreeState)) {
            files.push(resolve(worktreeState))
          }
        }
      }
    } catch {
      // If we can't read the worktrees directory, skip it
    }
  }

  // Prefer most recently touched loop files. This reduces accidental claims of
  // stale historical loops when multiple pending state files exist.
  return files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
}

/**
 * Scan for an unclaimed state file and claim it for the given session.
 * Returns the absolute path to the claimed file, or null if none found.
 */
function scanAndClaim(repoRoot: string, sessionId: string): string | null {
  const stateFiles = scanForStateFiles(repoRoot)

  for (const filePath of stateFiles) {
    const state = readState(filePath)
    if (!state || !state.active) continue

    // Already claimed by this session (shouldn't happen if cache is in sync, but be safe)
    if (state.sessionId === sessionId) {
      return filePath
    }

    // Unclaimed — claim it
    if (state.sessionId === null) {
      claimSession(filePath, sessionId)
      return filePath
    }

    // Claimed by another session — skip
  }

  return null
}

function tryClaimStateFile(filePath: string, sessionId: string): boolean {
  const state = readState(filePath)
  if (!state || !state.active) return false
  if (state.sessionId && state.sessionId !== sessionId) return false
  claimSession(filePath, sessionId)
  return true
}

function parseWorktreePathFromText(text: string): string | null {
  const patterns = [
    /--worktree\s+"([^"]+)"/,
    /--worktree\s+'([^']+)'/,
    /--worktree\s+(\S+)/,
    /implement-tasks in worktree\s+([^:\n]+):/,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) return resolve(match[1].trim())
  }

  return null
}

function findWorktreePathHint(event: any): string | null {
  const directCandidates = [
    event?.properties?.worktree,
    event?.worktree,
    event?.properties?.directory,
    event?.directory,
  ]

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return resolve(candidate.trim())
    }
  }

  const textCandidates = [
    event?.properties?.input?.command,
    event?.input?.command,
    event?.properties?.command,
    event?.command,
    (() => {
      try {
        return JSON.stringify(event)
      } catch {
        return ""
      }
    })(),
  ]

  for (const text of textCandidates) {
    if (typeof text !== "string" || text.length === 0) continue
    const parsed = parseWorktreePathFromText(text)
    if (parsed) return parsed
  }

  return null
}

function claimByWorktreeHint(repoRoot: string, sessionId: string, worktreePath: string): string | null {
  const stateFilePath = resolve(join(worktreePath, OPENCODE_DIR, STATE_FILENAME))
  if (!existsSync(stateFilePath)) return null
  if (!tryClaimStateFile(stateFilePath, sessionId)) return null

  sessionStateMap.set(sessionId, stateFilePath)
  const startedAt = getStartedAt(stateFilePath)
  const state = readState(stateFilePath)
  updateRegistryEntry(repoRoot, sessionId, stateFilePath, state?.iteration ?? 0, startedAt)
  return stateFilePath
}

function claimLatestPendingFromRegistry(repoRoot: string, sessionId: string): string | null {
  const registry = readRegistry(repoRoot)

  const pending = Object.entries(registry)
    .filter(([key, value]) => key.startsWith(REGISTRY_PENDING_PREFIX) && !!value?.path)
    .sort((a, b) => {
      const at = Date.parse(a[1].started_at ?? "")
      const bt = Date.parse(b[1].started_at ?? "")
      return (isNaN(bt) ? 0 : bt) - (isNaN(at) ? 0 : at)
    })

  for (const [, entry] of pending) {
    const stateFilePath = resolve(join(entry.path, OPENCODE_DIR, STATE_FILENAME))
    if (!existsSync(stateFilePath)) continue
    if (!tryClaimStateFile(stateFilePath, sessionId)) continue

    sessionStateMap.set(sessionId, stateFilePath)
    const startedAt = getStartedAt(stateFilePath)
    const state = readState(stateFilePath)
    updateRegistryEntry(repoRoot, sessionId, stateFilePath, state?.iteration ?? 0, startedAt)
    return stateFilePath
  }

  return null
}

function claimSessionState(repoRoot: string, sessionId: string, event: any): string | null {
  const cached = sessionStateMap.get(sessionId)
  if (cached) return cached

  const hintedWorktree = findWorktreePathHint(event)
  if (hintedWorktree) {
    const hinted = claimByWorktreeHint(repoRoot, sessionId, hintedWorktree)
    if (hinted) return hinted
  }

  const fromRegistry = claimLatestPendingFromRegistry(repoRoot, sessionId)
  if (fromRegistry) return fromRegistry

  // Fallback: scan and claim first available active/unclaimed state file.
  const claimed = scanAndClaim(repoRoot, sessionId)
  if (!claimed) return null

  sessionStateMap.set(sessionId, claimed)
  const startedAt = getStartedAt(claimed)
  const state = readState(claimed)
  updateRegistryEntry(repoRoot, sessionId, claimed, state?.iteration ?? 0, startedAt)
  return claimed
}

/**
 * Read the registry file, or return empty object if missing/corrupt.
 */
function readRegistry(repoRoot: string): Registry {
  const registryPath = join(repoRoot, OPENCODE_DIR, REGISTRY_FILENAME)
  if (!existsSync(registryPath)) return {}
  try {
    return JSON.parse(readFileSync(registryPath, "utf-8"))
  } catch {
    return {}
  }
}

function findStringByKeyRecursive(
  value: unknown,
  keyPattern: RegExp,
  depth = 0,
  visited = new Set<unknown>()
): string | null {
  if (depth > 6 || value == null) return null
  if (typeof value !== "object") return null
  if (visited.has(value)) return null
  visited.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeyRecursive(item, keyPattern, depth + 1, visited)
      if (found) return found
    }
    return null
  }

  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (keyPattern.test(key) && typeof field === "string" && field.trim().length > 0) {
      return field.trim()
    }
    const nested = findStringByKeyRecursive(field, keyPattern, depth + 1, visited)
    if (nested) return nested
  }

  return null
}

function getSessionIdFromEvent(event: any): string | null {
  const candidates = [
    event?.properties?.sessionID,
    event?.properties?.sessionId,
    event?.properties?.session_id,
    event?.sessionID,
    event?.sessionId,
    event?.session_id,
    event?.path?.id,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim()
    }
  }

  const recursive = findStringByKeyRecursive(event, /^session(?:_?id)?$/i)
  if (recursive) return recursive

  // Last-resort fallback: scan serialized event for a session-like token.
  // OpenCode session IDs are typically prefixed with "ses_".
  try {
    const serialized = JSON.stringify(event)
    const match = serialized.match(/\b(ses_[A-Za-z0-9_-]+)\b/)
    if (match?.[1]) return match[1]
  } catch {
    // ignore
  }

  return null
}

/**
 * Write the registry file with current state of all tracked worktree loops.
 */
function writeRegistry(repoRoot: string, registry: Registry): void {
  const dir = join(repoRoot, OPENCODE_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, REGISTRY_FILENAME), JSON.stringify(registry, null, 2) + "\n")
}

/**
 * Update registry entry for a session with current iteration info.
 * Extracts branch/path from the state file location.
 */
function updateRegistryEntry(
  repoRoot: string,
  sessionId: string,
  stateFilePath: string,
  iteration: number,
  startedAt: string
): void {
  const registry = readRegistry(repoRoot)

  // Determine if this is a worktree loop or repo-root loop
  const worktreesDir = resolve(join(repoRoot, WORKTREES_DIR))
  const resolvedPath = resolve(stateFilePath)
  let branch = "main"
  let worktreePath = repoRoot

  if (resolvedPath.startsWith(worktreesDir)) {
    // Extract worktree directory from state file path
    // stateFilePath: <repo>/.worktrees/<name>/.opencode/ralph-loop.local.md
    // worktreePath:  <repo>/.worktrees/<name>
    const relToWorktrees = resolvedPath.slice(worktreesDir.length + 1)
    const worktreeName = relToWorktrees.split("/")[0]
    worktreePath = join(worktreesDir, worktreeName)

    // Try to read branch from git
    try {
      branch = execSync(`git -C "${worktreePath}" branch --show-current`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    } catch {
      // Derive from directory name as fallback
      branch = `task-impl/${worktreeName}`
    }
  }

  registry[sessionId] = {
    branch,
    path: worktreePath,
    iteration,
    started_at: startedAt,
  }

  // Remove pending placeholders that point to the same worktree now that the
  // loop is claimed by a concrete session ID.
  for (const key of Object.keys(registry)) {
    if (!key.startsWith(REGISTRY_PENDING_PREFIX)) continue
    if (registry[key]?.path === worktreePath) {
      delete registry[key]
    }
  }

  writeRegistry(repoRoot, registry)
}

/**
 * Remove a session from the registry.
 */
function removeRegistryEntry(repoRoot: string, sessionId: string): void {
  const registry = readRegistry(repoRoot)
  delete registry[sessionId]
  writeRegistry(repoRoot, registry)
}

function resolveRepoRoot(baseDir: string): string {
  try {
    let commonDir = execSync(`git -C "${baseDir}" rev-parse --git-common-dir`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()

    if (!commonDir) return resolve(baseDir)
    if (!commonDir.startsWith("/")) {
      commonDir = resolve(baseDir, commonDir)
    }

    // Common dir is usually <repo>/.git; registry should live at <repo>/.opencode.
    return resolve(commonDir, "..")
  } catch {
    return resolve(baseDir)
  }
}

function getStartedAt(stateFilePath: string): string {
  try {
    const content = readFileSync(stateFilePath, "utf-8")
    const match = content.match(/^started_at:\s*"?([^"\n]+)"?/m)
    return match ? match[1] : new Date().toISOString()
  } catch {
    return new Date().toISOString()
  }
}

export const RalphWiggumPlugin: Plugin = async ({ directory, client }) => ({
  event: async ({ event }) => {
    // Extract session ID from the event
    const sessionId = getSessionIdFromEvent(event)
    if (!sessionId) {
      if (event.type !== "session.idle") return

      const eventKeys =
        (() => {
          try {
            return Object.keys((event ?? {}) as Record<string, unknown>)
          } catch {
            return []
          }
        })()

      await client.app.log({
        body: {
          service: "ralph-wiggum",
          level: "error",
          message: "Could not determine session ID from session.idle event",
          extra: {
            eventType: (event as any)?.type,
            topLevelKeys: eventKeys,
          },
        },
      })
      return
    }

    // Per-session re-entrancy guard: only one handler execution per session.
    if (processing.has(sessionId)) return
    processing.add(sessionId)

    try {
      const repoRoot = resolveRepoRoot(directory)

      // Ensure this session is mapped to a concrete state file as early as
      // possible, not only at session.idle. This gives a deterministic
      // session->worktree registry entry immediately after setup.
      let stateFilePath = sessionStateMap.get(sessionId) ?? null

      if (!stateFilePath) {
        if (claimLock) return
        claimLock = true
        try {
          stateFilePath = claimSessionState(repoRoot, sessionId, event as any)
        } finally {
          claimLock = false
        }
      }

      // For non-idle events, claim/update mapping only; don't run the loop body.
      if (event.type !== "session.idle") return

      // No state file found or claimed — nothing to do
      if (!stateFilePath) return

      const state = readState(stateFilePath)

      if (!state || !state.active) {
        // Clean up inactive state files
        if (state && !state.active && existsSync(stateFilePath)) {
          unlinkSync(stateFilePath)
        }
        sessionStateMap.delete(sessionId)
        removeRegistryEntry(repoRoot, sessionId)
        return
      }

      // Verify this session still owns the state file
      if (state.sessionId && state.sessionId !== sessionId) {
        // Someone else claimed it — evict from our cache
        sessionStateMap.delete(sessionId)
        return
      }

      // Refresh mapping metadata on idle so operators always see latest values.
      updateRegistryEntry(repoRoot, sessionId, stateFilePath, state.iteration, getStartedAt(stateFilePath))

      // Check max iterations
      if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
        await client.tui.showToast({
          body: {
            message: `Ralph loop: max iterations (${state.maxIterations}) reached`,
            variant: "info",
          },
        })
        unlinkSync(stateFilePath)
        sessionStateMap.delete(sessionId)
        removeRegistryEntry(repoRoot, sessionId)
        return
      }

      // Check completion promise against the last assistant message
      let lastAssistantText = ""
      try {
        const messages = await client.session.messages({ path: { id: sessionId } })
        const assistantMessages = (messages.data ?? []).filter(
          (m) => (m as any).info?.role === "assistant"
        )
        if (assistantMessages.length > 0) {
          const lastMsg = assistantMessages[assistantMessages.length - 1]
          lastAssistantText = ((lastMsg as any).parts ?? [])
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text ?? "")
            .join("\n")
        }
      } catch (err) {
        await client.app.log({
          body: {
            service: "ralph-wiggum",
            level: "warn",
            message: "Failed to retrieve session messages for completion check",
            extra: { error: String(err) },
          },
        })
      }

      if (
        state.completionPromise &&
        checkCompletionPromise(lastAssistantText, state.completionPromise)
      ) {
        await client.tui.showToast({
          body: {
            message: `Ralph loop: completion promise detected -- loop finished`,
            variant: "success",
          },
        })
        unlinkSync(stateFilePath)
        sessionStateMap.delete(sessionId)
        removeRegistryEntry(repoRoot, sessionId)
        return
      }

      // Re-read state before sending — the loop may have been cancelled
      // while we were checking messages (async gap).
      const freshState = readState(stateFilePath)
      if (!freshState || !freshState.active) {
        sessionStateMap.delete(sessionId)
        removeRegistryEntry(repoRoot, sessionId)
        return
      }

      // Increment iteration and send prompt
      const nextIteration = freshState.iteration + 1
      updateIteration(stateFilePath, nextIteration)

      // Update registry with current iteration
      const startedAt = getStartedAt(stateFilePath)

      updateRegistryEntry(repoRoot, sessionId, stateFilePath, nextIteration, startedAt)

      const systemMsg =
        freshState.completionPromise
          ? `Ralph iteration ${nextIteration} | To stop: output <promise>${freshState.completionPromise}</promise> (ONLY when TRUE -- do not lie to exit!)`
          : `Ralph iteration ${nextIteration} | No completion promise set`

      await client.tui.showToast({
        body: { message: `Ralph: starting iteration ${nextIteration}`, variant: "info" },
      })

      // CRITICAL: Use promptAsync — it queues the message and returns
      // immediately (HTTP 204). The old prompt() call streamed the full
      // AI response, blocking this handler for minutes and causing
      // queued session.idle events to fire duplicate prompts.
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [
            {
              type: "text",
              text: `${systemMsg}\n\n${freshState.prompt}`,
            },
          ],
        },
      })
    } catch (err) {
      // Don't let errors crash the plugin — log and move on so the
      // next session.idle can retry.
      try {
        await client.app.log({
          body: {
            service: "ralph-wiggum",
            level: "error",
            message: "Unhandled error in ralph-wiggum event handler",
            extra: { error: String(err) },
          },
        })
      } catch {
        // If even logging fails, silently continue
      }
    } finally {
      processing.delete(sessionId)
    }
  },
})
