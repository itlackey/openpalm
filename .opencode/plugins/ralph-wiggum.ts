import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"

const STATE_FILENAME = ".opencode/ralph-loop.local.md"

type RalphState = {
  active: boolean
  sessionId: string | null
  iteration: number
  maxIterations: number
  completionPromise: string | null
  prompt: string
}

// In-memory guard: prevents concurrent event handler execution.
// Without this, multiple session.idle events arriving in quick succession
// can all pass file-based checks and send duplicate prompts.
let processing = false

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

export const RalphWiggumPlugin: Plugin = async ({ directory, client }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return

    // Re-entrancy guard: only one handler execution at a time.
    // This prevents duplicate prompts when multiple idle events arrive
    // before the first handler completes its async work.
    if (processing) return
    processing = true

    try {
      const stateFilePath = join(directory, STATE_FILENAME)
      const state = readState(stateFilePath)

      if (!state || !state.active) {
        // Clean up inactive state files
        if (state && !state.active && existsSync(stateFilePath)) {
          unlinkSync(stateFilePath)
        }
        return
      }

      // Extract session ID — EventSessionIdle.properties.sessionID is the
      // only documented field; no fallback chain needed.
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

      // Only act on the session that started the loop — ignore idle events
      // from other sessions. On first iteration, claim this session.
      if (state.sessionId && state.sessionId !== sessionId) {
        return
      }
      if (!state.sessionId) {
        claimSession(stateFilePath, sessionId)
      }

      // Check max iterations
      if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
        await client.tui.showToast({
          body: {
            message: `Ralph loop: max iterations (${state.maxIterations}) reached`,
            variant: "info",
          },
        })
        unlinkSync(stateFilePath)
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
            message: `Ralph loop: completion promise detected — loop finished`,
            variant: "success",
          },
        })
        unlinkSync(stateFilePath)
        return
      }

      // Re-read state before sending — the loop may have been cancelled
      // while we were checking messages (async gap).
      const freshState = readState(stateFilePath)
      if (!freshState || !freshState.active) return

      // Increment iteration and send prompt
      const nextIteration = freshState.iteration + 1
      updateIteration(stateFilePath, nextIteration)

      const systemMsg =
        freshState.completionPromise
          ? `Ralph iteration ${nextIteration} | To stop: output <promise>${freshState.completionPromise}</promise> (ONLY when TRUE — do not lie to exit!)`
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
      processing = false
    }
  },
})
