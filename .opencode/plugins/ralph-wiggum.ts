import type { Plugin } from "@opencode-ai/plugin"
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
} from "fs"
import { join, resolve } from "path"

const STATE_FILENAME = "ralph-loop.local.md"
const OPENCODE_DIR = ".opencode"
const WORKTREES_DIR = ".worktrees"
const REGISTRY_FILENAME = "worktrees.local.json"

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
      rawSessionId === "null" || rawSessionId === null
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

  return files
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
      const { execSync } = require("child_process")
      branch = execSync(`git -C "${worktreePath}" branch --show-current`, {
        encoding: "utf-8",
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
    if (event.type !== "session.idle") return

    // Extract session ID from the event
    const sessionId = (event as any).properties?.sessionID
    if (!sessionId) {
      await client.app.log({
        body: {
          service: "ralph-wiggum",
          level: "error",
          message: "Could not determine session ID from session.idle event",
        },
      })
      return
    }

    // Per-session re-entrancy guard: only one handler execution per session.
    if (processing.has(sessionId)) return
    processing.add(sessionId)

    try {
      const repoRoot = directory

      // Step 1: Check in-memory cache for this session's state file
      let stateFilePath = sessionStateMap.get(sessionId) ?? null

      // Step 2: If not cached, scan for unclaimed state files
      if (!stateFilePath) {
        // Acquire global claim lock to prevent two sessions racing
        if (claimLock) {
          // Another session is currently scanning — skip this idle event.
          // The next idle will retry.
          return
        }
        claimLock = true
        try {
          stateFilePath = scanAndClaim(repoRoot, sessionId)
          if (stateFilePath) {
            sessionStateMap.set(sessionId, stateFilePath)
          }
        } finally {
          claimLock = false
        }
      }

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

      // Ensure registry entry exists as soon as state is claimed, even before
      // an iteration is advanced. This gives /cancel-ralph and operators a
      // stable session->worktree map immediately after first idle.
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
