import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
import { join } from "path"

const STATE_FILENAME = ".opencode/ralph-loop.local.md"

type RalphState = {
  active: boolean
  iteration: number
  maxIterations: number
  completionPromise: string | null
  prompt: string
}

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

    return {
      active: getField("active") === "true",
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

function checkCompletionPromise(text: string, promise: string | null): boolean {
  if (!promise) return false
  const match = text.match(/<promise>([\s\S]*?)<\/promise>/)
  if (!match) return false
  // Normalize whitespace for comparison
  return match[1].trim().replace(/\s+/g, " ") === promise
}

export const RalphWiggumPlugin: Plugin = async ({ directory, client }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.idle") return

    const stateFilePath = join(directory, STATE_FILENAME)
    if (!existsSync(stateFilePath)) return

    const content = readFileSync(stateFilePath, "utf-8")
    const state = parseStateFile(content)

    if (!state || !state.active) {
      if (existsSync(stateFilePath)) unlinkSync(stateFilePath)
      return
    }

    // Get session ID from event properties
    const sessionId =
      (event as any).properties?.sessionID ??
      (event as any).properties?.id ??
      (event as any).sessionID

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

    // Check max iterations
    if (state.maxIterations > 0 && state.iteration >= state.maxIterations) {
      await client.tui.showToast({
        body: {
          message: `🛑 Ralph loop: Max iterations (${state.maxIterations}) reached.`,
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
      // Continue with loop even if we can't read messages
    }

    if (
      state.completionPromise &&
      checkCompletionPromise(lastAssistantText, state.completionPromise)
    ) {
      await client.tui.showToast({
        body: {
          message: `✅ Ralph loop: Detected <promise>${state.completionPromise}</promise>`,
          variant: "success",
        },
      })
      unlinkSync(stateFilePath)
      return
    }

    // Continue the loop — increment iteration and send same prompt back
    const nextIteration = state.iteration + 1
    updateIteration(stateFilePath, nextIteration)

    const systemMsg =
      state.completionPromise
        ? `🔄 Ralph iteration ${nextIteration} | To stop: output <promise>${state.completionPromise}</promise> (ONLY when TRUE — do not lie to exit!)`
        : `🔄 Ralph iteration ${nextIteration} | No completion promise set`

    await client.tui.showToast({
      body: { message: `🔄 Ralph: starting iteration ${nextIteration}`, variant: "info" },
    })

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: `${systemMsg}\n\n${state.prompt}`,
          },
        ],
      },
    })
  },
})
