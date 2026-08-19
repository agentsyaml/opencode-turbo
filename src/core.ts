// Shared structural types, constants and pure helpers for opencode-turbo.
//
// Extracted from the plugin entry so the entry module only exports the default
// plugin function: opencode's legacy plugin loader treats every export of the
// entry module as a plugin, so pure helpers must live in a separate module.

export const MAX_ATTEMPTS = 10 // consecutive recoveries per session before giving up
export const BACKOFF_BASE_MS = 1_000 // exponential backoff: 2s, 4s, 8s, ... capped at 30min
export const BACKOFF_MAX_MS = 1_800_000 // 30 minutes
export const TRIGGER_DEDUPE_MS = 10_000 // same error signature within this window is one failure
export const RE_FETCH_WAIT_MS = 500 // re-read messages when the failure is not visible yet
export const MAX_PREFLIGHT_ATTEMPTS = 3 // bounded status/message readiness probes per recovery
export const TERMINAL_DELAY_MS = 500 // wait before acting on a terminal error so message finalizes
export const MAX_PARTIAL_CHARS = 12_000 // tail of partial output fed to the continuation prompt

export const CONTINUATION_TEMPLATE =
  "Your previous response was interrupted mid-stream by a provider error. " +
  "Here is exactly what you had generated before the interruption:\n\n" +
  "---BEGIN PARTIAL RESPONSE---\n{{partial_content}}\n---END PARTIAL RESPONSE---\n\n" +
  "Continue your response EXACTLY where it was cut off. Do not repeat any of the content above. " +
  "Do not acknowledge the interruption. Just seamlessly continue from the exact point where the text ends."

// Structural message types (defensive, tolerant of SDK shape drift).
export interface PartLike {
  type?: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
  synthetic?: boolean
  ignored?: boolean
}

export interface MessageLike {
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

export type PromptPart = { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string }

export interface SessionState {
  recovering: boolean
  recoveryGeneration: number
  attempts: number
  preflightAttempts: number
  lastErrorKey?: string
  lastErrorTime: number
  lastRecoveredMessageID?: string
  gaveUp: boolean
  pendingRecovery?: RecoveryOptions & { reason: string }
}

export type RecoveryOptions = {
  delay?: boolean
  targetMessageID?: string
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function createState(): SessionState {
  return { recovering: false, recoveryGeneration: 0, attempts: 0, preflightAttempts: 0, lastErrorTime: 0, gaveUp: false }
}

export function isBlockedSession(sessionID: string, paused: ReadonlySet<string>, unknownParentPending: ReadonlySet<string>): boolean {
  return paused.has(sessionID) || unknownParentPending.has(sessionID)
}

/** Concatenated text of an assistant message's text parts, or null. */
export function partialText(message: MessageLike | undefined): string | null {
  if (!message?.parts) return null
  const text = message.parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0 && !p.synthetic && !p.ignored)
    .map((p) => p.text as string)
    .join("")
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Last (interrupted) assistant message, only if it actually failed. */
export function failedAssistant(messages: MessageLike[]): MessageLike | undefined {
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

export function targetAssistant(messages: MessageLike[], targetID: string): MessageLike | undefined {
  const index = messages.findIndex((message) => message.info?.id === targetID && message.info.role === "assistant")
  if (index < 0 || messages.slice(index + 1).some((message) => message.info?.role === "user" || message.info?.role === "assistant")) return undefined
  const target = messages[index]
  const info = target.info
  if (!info) return undefined
  if (info.error || info.finish === "tool-calls" || info.finish === "unknown") return target
  return !info.finish && info.time?.completed === undefined ? target : undefined
}

export function candidateAssistant(messages: MessageLike[], opts: RecoveryOptions): MessageLike | undefined {
  return opts.targetMessageID ? targetAssistant(messages, opts.targetMessageID) : failedAssistant(messages)
}

export function buildContinuation(partial: string): string {
  const body = partial.length > MAX_PARTIAL_CHARS ? "[...truncated]\n" + partial.slice(-MAX_PARTIAL_CHARS) : partial
  return CONTINUATION_TEMPLATE.replace("{{partial_content}}", body)
}

export function toPromptPart(part: PartLike): PromptPart | null {
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
