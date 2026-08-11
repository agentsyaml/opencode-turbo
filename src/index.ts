import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ─────────────────────────────────────────────────────────────────────────────
// @alexsun-top/opencode-turbo
//
// Zero-config recovery for provider errors opencode does not retry by default:
//  - mid-stream closures ("provider closed the stream before sending a
//    completion marker", "upstream connection ended mid-stream") that reach a
//    terminal state (session.error) instead of the retry path
//  - 4xx status codes (400/402/403/405/408/409/422/429) that opencode treats
//    as non-retryable
//  - provider/model-output errors (bad request, reasoning_opaque, malformed
//    tool calls) where a retry lets the model fix itself
//
// The plugin acts ONLY on terminal failures (session.error / message.updated
// with an assistant error). It never interferes with opencode's own retry
// loop: retryable errors keep opencode's unbounded exponential retry
// untouched, and only failures opencode gave up on get recovered here.
//
// Recovery = abort -> capture partial assistant output -> revert to the last
// user message -> re-send a continuation prompt with the partial content so
// the model resumes exactly where it was interrupted. Always retries with the
// same model (no fallback model to configure).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 10 // consecutive recoveries per session before giving up
const BACKOFF_BASE_MS = 1_000 // exponential backoff: 2s, 4s, 8s, ... capped at 30min
const BACKOFF_MAX_MS = 1_800_000 // 30 minutes
const BURST_DEDUPE_MS = 300 // session.error + message.updated fire together for one failure
const SETTLE_MS = 200 // wait after abort before reading messages
const REVERT_WAIT_MS = 500 // wait after revert before re-sending
const TERMINAL_DELAY_MS = 500 // wait before acting on a terminal error so message finalizes
const MAX_PARTIAL_CHARS = 12_000 // tail of partial output fed to the continuation prompt

// Substring patterns (case-insensitive) matched against "Name: message".
// Covers stream closures, connection drops and provider overload that opencode
// may or may not classify as retryable on its own.
const RETRY_PATTERNS = [
  "completion marker",
  "upstream connection",
  "mid-stream",
  "stream closed",
  "stream ended",
  "stream error",
  "stream interrupted",
  "unexpected end",
  "premature close",
  "connection reset",
  "connection closed",
  "connection lost",
  "connection terminated",
  "connection aborted",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "socket hang up",
  "socket closed",
  "network error",
  "reset by peer",
  "broken pipe",
  "upstream connect error",
  "fetch failed",
  "failed to fetch",
  "request timed out",
  "connection timed out",
  "response timeout",
  "idle timeout",
  "sse read timed out",
  "no data received",
  "read timed out",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "internal server error",
  "server error",
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "resource exhausted",
  "try your request again",
  "retry your request",
  // Provider/model-output errors that a retry lets the model fix itself
  "bad request",
  "reasoning_opaque",
  "prefill",
  "expected string, received undefined",
  "invalid diff",
  "json parsing failed",
  "invalid input for tool",
  "tool_use ids were found without tool_result",
  "tried to call unavailable tool",
  "disconnected",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
]

// HTTP status codes that are worth retrying even though opencode does not
// retry them by default (most 4xx are non-retryable in opencode's policy).
// 401 (auth), 404 (not found) and 413 (payload too large) are excluded as
// permanent failures.
const RETRY_STATUS_CODES = [400, 402, 403, 405, 408, 409, 422, 429, 500, 502, 503, 504, 524, 529]

// Never recover on these (user action or permanent failure).
const EXCLUDE_PATTERNS = [
  "MessageAbortedError",
  "operation was aborted",
  "unauthorized",
  "invalid api key",
  "authentication",
  "not authenticated",
  "MessageOutputLengthError",
  "output length",
  "context overflow",
  "too large to compact",
  "not found",
  "does not exist",
  "invalid request body",
  "unsupported",
]

const CONTINUATION_TEMPLATE =
  "Your previous response was interrupted mid-stream by a provider error. " +
  "Here is exactly what you had generated before the interruption:\n\n" +
  "---BEGIN PARTIAL RESPONSE---\n{{partial_content}}\n---END PARTIAL RESPONSE---\n\n" +
  "Continue your response EXACTLY where it was cut off. Do not repeat any of the content above. " +
  "Do not acknowledge the interruption. Just seamlessly continue from the exact point where the text ends."

// ── Logging ────────────────────────────────────────────────────────────────
// File-based only: console output leaks into the TUI as raw terminal noise.

const logPath = join(homedir(), ".local", "share", "opencode", "logs", "auto-recover.log")

async function log(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
    // logging must never break the plugin
  }
}

// ── Pure matching logic (exported for self-check) ──────────────────────────

export function errorText(error: unknown): { name: string; message: string; statusCode?: number } {
  if (!error || typeof error !== "object") return { name: "", message: "" }
  const e = error as Record<string, unknown>
  const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>
  const name = typeof e.name === "string" ? e.name : ""
  const message =
    (typeof data.message === "string" ? data.message : null) ??
    (typeof e.message === "string" ? e.message : "")
  const statusCode =
    typeof data.statusCode === "number"
      ? data.statusCode
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined
  return { name, message, statusCode }
}

/** Decide whether an error is worth recovering from (exported for self-check). */
export function isRecoverable(error: unknown): boolean {
  const { name, message, statusCode } = errorText(error)
  const match = `${name}: ${message}`.toLowerCase()

  for (const pattern of EXCLUDE_PATTERNS) {
    if (match.includes(pattern.toLowerCase())) return false
  }
  if (statusCode !== undefined && RETRY_STATUS_CODES.includes(statusCode)) return true
  for (const pattern of RETRY_PATTERNS) {
    if (match.includes(pattern.toLowerCase())) return true
  }
  return false
}

// ── Structural message types (defensive, tolerant of SDK shape drift) ───────

interface PartLike {
  type?: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
  synthetic?: boolean
  ignored?: boolean
}

interface MessageLike {
  info?: {
    id?: string
    sessionID?: string
    role?: string
    error?: unknown
    agent?: string
    providerID?: string
    modelID?: string
    finish?: string
    time?: { completed?: number }
  }
  parts?: PartLike[]
}

type PromptPart = { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string }

interface SessionState {
  recovering: boolean
  attempts: number
  lastTriggerAt: number
  gaveUp: boolean
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createState(): SessionState {
  return { recovering: false, attempts: 0, lastTriggerAt: 0, gaveUp: false }
}

/** Concatenated text of an assistant message's text parts, or null. */
function partialText(message: MessageLike | undefined): string | null {
  if (!message?.parts) return null
  const text = message.parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0 && !p.synthetic && !p.ignored)
    .map((p) => p.text as string)
    .join("")
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Last (interrupted) assistant message, only if it actually failed. */
function failedAssistant(messages: MessageLike[]): MessageLike | undefined {
  // Only the last message can be the failure we recover from. If the user has
  // sent something after the failed message (e.g. during a backoff wait), the
  // failure is stale and recovery must back off instead of stomping on it.
  const last = messages[messages.length - 1]
  if (last?.info?.role !== "assistant") return undefined
  if (last.info.error) return last
  // No error attached yet (message finalization timing): treat the last
  // message as the interrupted one only while it is still unfinished. A
  // completed response must never be treated as a failure.
  if (!last.info.finish && last.info.time?.completed === undefined) return last
  return undefined
}

function buildContinuation(partial: string): string {
  const body = partial.length > MAX_PARTIAL_CHARS ? "[...truncated]\n" + partial.slice(-MAX_PARTIAL_CHARS) : partial
  return CONTINUATION_TEMPLATE.replace("{{partial_content}}", body)
}

function toPromptPart(part: PartLike): PromptPart | null {
  if (part.synthetic || part.ignored) return null
  switch (part.type) {
    case "text":
      if (typeof part.text === "string" && part.text.length > 0) return { type: "text", text: part.text }
      return null
    case "file":
      if (typeof part.url === "string") {
        return { type: "file", mime: typeof part.mime === "string" ? part.mime : "application/octet-stream", filename: part.filename, url: part.url }
      }
      return null
    case "agent":
      if (typeof part.name === "string") return { type: "agent", name: part.name }
      return null
    default:
      return null
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: Plugin = async ({ client }: PluginInput): Promise<Hooks> => {
  const states = new Map<string, SessionState>()

  const getState = (sessionID: string): SessionState => {
    let state = states.get(sessionID)
    if (!state) {
      state = createState()
      states.set(sessionID, state)
    }
    return state
  }

  function backoff(attempt: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
  }

  /**
   * Single-flight recovery for a session. Increments the attempt counter,
   * aborts any in-flight generation / opencode retry loop, captures the
   * partial assistant output, reverts to the last user message and re-sends a
   * continuation prompt with the same model.
   */
  async function recover(sessionID: string, reason: string, opts: { delay?: boolean } = {}): Promise<void> {
    const state = getState(sessionID)
    if (state.recovering || state.gaveUp) return

    state.recovering = true
    try {
      const attempt = state.attempts + 1
      if (attempt > MAX_ATTEMPTS) {
        state.gaveUp = true
        await log(`GIVING UP on ${sessionID} after ${MAX_ATTEMPTS} attempts (last: ${reason})`)
        return
      }
      state.attempts = attempt
      await log(`RECOVER ${sessionID} attempt ${attempt}/${MAX_ATTEMPTS} — ${reason}`)

      // 1. Stop any in-flight generation FIRST, before any sleep: a live
      //    generation that succeeds during a backoff wait would otherwise get
      //    reverted as a "failed" message. The SDK client resolves HTTP errors
      //    instead of rejecting, so check the result too.
      const abortRes = await client.session.abort({ path: { id: sessionID } }).catch(async (err) => {
        await log(`RECOVER ${sessionID}: abort threw: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      })
      if (abortRes?.error) {
        await log(`RECOVER ${sessionID}: abort failed: ${String(abortRes.error)}`)
      }
      await sleep(SETTLE_MS)

      if (attempt > 1) await sleep(backoff(attempt))
      if (opts.delay) await sleep(TERMINAL_DELAY_MS)

      // 2. Read the conversation.
      const res = await client.session.messages({ path: { id: sessionID } }).catch(() => ({ data: [] as MessageLike[] }))
      const messages = (res.data ?? []) as MessageLike[]
      if (messages.length === 0) {
        await log(`RECOVER ${sessionID}: no messages, aborting recovery`)
        return
      }

      // The failure we are recovering from. If nothing looks failed anymore
      // (e.g. the response actually completed), back off without touching it.
      const lastAssistant = failedAssistant(messages)
      if (!lastAssistant) {
        await log(`RECOVER ${sessionID}: no interrupted message found, skipping recovery`)
        return
      }
      const partial = partialText(lastAssistant)
      const hasModel = Boolean(lastAssistant.info?.providerID && lastAssistant.info.modelID)
      const model = hasModel
        ? { providerID: lastAssistant.info!.providerID!, modelID: lastAssistant.info!.modelID! }
        : undefined

      const lastUser = [...messages].reverse().find((m) => m.info?.role === "user")
      if (!lastUser?.info?.id) {
        await log(`RECOVER ${sessionID}: no user message to revert to, aborting recovery`)
        return
      }

      // 3. Remove the interrupted assistant message. Revert failure is a hard
      //    stop: appending a continuation on top of the still-failed message
      //    would corrupt the history, so bail instead.
      const revertRes = await client.session
        .revert({ path: { id: sessionID }, body: { messageID: lastUser.info.id } })
        .catch(async (err) => {
          await log(`RECOVER ${sessionID}: revert threw: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        })
      if (!revertRes || revertRes.error) {
        await log(`RECOVER ${sessionID}: revert failed (${String(revertRes?.error ?? "request threw")}), abandoning recovery`)
        return
      }
      await sleep(REVERT_WAIT_MS)

      // 4. Re-send: continuation with partial content, the original user parts,
      //    or a generic nudge when nothing resendable is available (e.g. the
      //    last user message only carried tool results).
      let parts: PromptPart[]
      if (partial) {
        parts = [{ type: "text", text: buildContinuation(partial) }]
      } else {
        parts = (lastUser.parts ?? []).map(toPromptPart).filter((p): p is PromptPart => p !== null)
      }
      if (parts.length === 0) {
        parts = [
          {
            type: "text",
            text: "Your previous response was interrupted by a provider error before producing any output. Continue with the current task.",
          },
        ]
      }

      const promptRes = await client.session
        .prompt({
          path: { id: sessionID },
          body: {
            model,
            agent: typeof lastUser.info.agent === "string" ? lastUser.info.agent : undefined,
            parts,
          },
        })
        .catch(async (err) => {
          await log(`RECOVER ${sessionID}: prompt threw: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        })
      if (promptRes?.error) {
        await log(`RECOVER ${sessionID}: continuation prompt failed: ${String(promptRes.error)}`)
      } else {
        await log(`RECOVER ${sessionID}: continuation prompt sent (attempt ${attempt})`)
      }
    } catch (err) {
      await log(`RECOVER ${sessionID} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      state.recovering = false
    }
  }

  /** Rate-limit duplicate triggers from the session.error + message.updated burst. */
  function burstGate(state: SessionState): boolean {
    const now = Date.now()
    if (now - state.lastTriggerAt < BURST_DEDUPE_MS) return false
    state.lastTriggerAt = now
    return true
  }

  const handleTerminalError = (sessionID: string, error: unknown) => {
    if (!isRecoverable(error)) return
    const state = getState(sessionID)
    if (!burstGate(state)) return
    const { name, message } = errorText(error)
    void recover(sessionID, message || name, { delay: true })
  }

  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      try {
        switch (event.type) {
          // NOTE: session.status retry events are deliberately ignored —
          // opencode's own (unbounded, exponential-backoff) retry loop is
          // left untouched. This plugin only acts on terminal failures.

          case "session.error": {
            const props = event.properties as { sessionID?: string; error?: unknown }
            if (typeof props.sessionID === "string") handleTerminalError(props.sessionID, props.error)
            return
          }

          case "message.updated": {
            const info = (event.properties as { info?: MessageLike["info"] }).info
            if (!info?.sessionID || info.role !== "assistant") return
            if (info.error) {
              handleTerminalError(info.sessionID, info.error)
            } else if (info.finish || info.time?.completed !== undefined) {
              // Successful completion: reset the attempt counter so a later
              // failure starts a fresh recovery chain. Never reset while a
              // recovery is in flight (it may have reverted this message).
              const state = getState(info.sessionID)
              if ((state.attempts > 0 || state.gaveUp) && !state.recovering) {
                state.attempts = 0
                state.gaveUp = false
                await log(`SUCCESS ${info.sessionID}: recovery chain completed, attempts reset`)
              }
            }
            return
          }

          case "session.deleted": {
            const info = (event.properties as { info?: { id?: string } }).info
            if (info?.id) states.delete(info.id)
            return
          }
        }
      } catch (err) {
        await log(`event handler error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

export default plugin
