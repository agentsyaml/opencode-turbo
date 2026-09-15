// Shared structural types, constants and pure helpers for opencode-turbo.
//
// Extracted from the plugin entry so the entry module only exports the default
// plugin function: opencode's legacy plugin loader treats every export of the
// entry module as a plugin, so pure helpers must live in a separate module.

export const MAX_ATTEMPTS = 10 // consecutive recoveries per session before giving up
export const BACKOFF_BASE_MS = 1_000 // exponential backoff: 2s, 4s, 8s, ... capped at 30min
export const BACKOFF_MAX_MS = 1_800_000 // 30 minutes
export const PREFLIGHT_GIVE_UP_MS = 600_000 // 10 min wall clock per readiness episode
export const PREFLIGHT_BACKOFF_MAX_MS = 30_000 // cap preflight backoff at 30s
export const TRIGGER_DEDUPE_MS = 10_000 // same error signature within this window is one failure
export const RE_FETCH_WAIT_MS = 500 // re-read messages when the failure is not visible yet
export const TERMINAL_DELAY_MS = 500 // wait before acting on a terminal error so message finalizes
export const STALL_CHECK_MS = 30_000 // stall watchdog sweep interval
export const STALL_TIMEOUT_MS = 1_800_000 // default event silence before a stall is considered
export const STALL_MAX_PER_SWEEP = 3 // recover at most this many stalled sessions per sweep
export const MAX_PARTIAL_CHARS = 12_000 // tail of partial output fed to the continuation prompt

export const CONTINUATION_TEMPLATE =
  "Your previous response was interrupted mid-stream by a provider error. " +
  "Here is exactly what you had generated before the interruption:\n\n" +
  "---BEGIN PARTIAL RESPONSE---\n{{partial_content}}\n---END PARTIAL RESPONSE---\n\n" +
  "Continue your response EXACTLY where it was cut off. Do not repeat any of the content above. " +
  "Do not acknowledge the interruption. Just seamlessly continue from the exact point where the text ends."

// Used when a turn finished "successfully" but produced no visible output.
export const EMPTY_CONTINUATION =
  "Your previous response completed without any output. Respond to the user's last request now and produce the actual answer."

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
    parentID?: string
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
  preflightStartedAt?: number
  recoveryRequestSequence: number
  lastErrorKey?: string
  lastErrorTime: number
  lastRecoveredMessageID?: string
  lastRecoveredRequestSequence?: number
  activeRecoveryPromptMessageID?: string
  recoveryCancelled: boolean
  recoveryPromptMessageIDs: Set<string>
  recoveryPromptRequestSequences: Map<string, number>
  gaveUp: boolean
  lastEmptyOutputMessageID?: string
  pendingRecovery?: RecoveryOptions & { reason: string }
}

export type RecoveryOptions = {
  delay?: boolean
  targetMessageID?: string
  requestSequence?: number
  stall?: boolean
  emptyOutput?: boolean
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bounded preflight backoff: 2s, 4s, 8s, 16s, then capped at 30s. */
export function preflightBackoff(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, PREFLIGHT_BACKOFF_MAX_MS)
}

/** A readiness episode expires 10 minutes after it started. */
export function preflightExpired(startedAt: number | undefined, now: number): boolean {
  return startedAt !== undefined && now - startedAt >= PREFLIGHT_GIVE_UP_MS
}

export function createState(): SessionState {
  return { recovering: false, recoveryGeneration: 0, attempts: 0, preflightAttempts: 0, recoveryRequestSequence: 0, lastErrorTime: 0, recoveryCancelled: false, recoveryPromptMessageIDs: new Set(), recoveryPromptRequestSequences: new Map(), gaveUp: false }
}

/** Terminal recovery transition: queued work must not be drained again. */
export function clearPendingRecovery(state: Pick<SessionState, "pendingRecovery">): void {
  state.pendingRecovery = undefined
}

/** Reset a completed chain without clearing an in-flight prompt marker. */
export function resetRecoveryAfterSuccess(
  state: Pick<SessionState, "attempts" | "preflightAttempts" | "preflightStartedAt" | "gaveUp" | "lastRecoveredMessageID" | "lastRecoveredRequestSequence" | "activeRecoveryPromptMessageID" | "lastErrorKey" | "lastErrorTime" | "recoveryCancelled" | "recoveryPromptMessageIDs" | "recoveryPromptRequestSequences" | "lastEmptyOutputMessageID">,
  preservePromptMarkers = false,
): void {
  state.attempts = 0
  state.preflightAttempts = 0
  state.preflightStartedAt = undefined
  state.gaveUp = false
  state.lastRecoveredMessageID = undefined
  state.lastRecoveredRequestSequence = undefined
  state.activeRecoveryPromptMessageID = undefined
  state.lastErrorKey = undefined
  state.lastErrorTime = 0
  state.lastEmptyOutputMessageID = undefined
  if (!state.recoveryCancelled && !preservePromptMarkers) {
    state.recoveryPromptMessageIDs.clear()
    state.recoveryPromptRequestSequences.clear()
  }
}

export function samePendingRecovery(current: SessionState["pendingRecovery"], expected: SessionState["pendingRecovery"]): boolean {
  return current === expected
}

export function discardPendingRecovery(state: Pick<SessionState, "pendingRecovery">, expected: SessionState["pendingRecovery"]): boolean {
  if (!samePendingRecovery(state.pendingRecovery, expected)) return false
  state.pendingRecovery = undefined
  return true
}

export function startsRecoveryChain(state: Pick<SessionState, "recovering" | "pendingRecovery" | "gaveUp">): boolean {
  return !state.recovering && state.pendingRecovery === undefined && !state.gaveUp
}

export function messageReadFailed(messages: MessageLike[] | undefined): messages is undefined {
  return messages === undefined
}

export function recoveryBarrierAllows(recoveryCancelled: boolean): boolean {
  return !recoveryCancelled
}

export function isRecoveryPromptMessage(promptIDs: ReadonlySet<string>, messageID: string | undefined): boolean {
  return messageID !== undefined && promptIDs.has(messageID)
}

export function isGenuineRecoveryUserMessage(promptIDs: ReadonlySet<string>, messageID: string | undefined): boolean {
  return messageID !== undefined && !promptIDs.has(messageID)
}

export function recoveryRequestIsNewer(currentSequence: number | undefined, requestSequence: number): boolean {
  return requestSequence > (currentSequence ?? -1)
}

export function recoveryRequestIsCurrent(
  state: Pick<SessionState, "recoveryGeneration" | "recoveryRequestSequence">,
  generation: number,
  requestSequence: number,
): boolean {
  return state.recoveryGeneration === generation && state.recoveryRequestSequence === requestSequence
}

export function isRecoveryContinuation(promptIDs: ReadonlySet<string>, messageID: string | undefined): boolean {
  return messageID !== undefined && promptIDs.has(messageID)
}

export function isCurrentRecoveryContinuation(
  promptSequences: ReadonlyMap<string, number>,
  messageID: string | undefined,
  requestSequence: number,
): boolean {
  return messageID !== undefined && promptSequences.get(messageID) === requestSequence
}

export function isSuccessfulRecoveryContinuation(
  promptIDs: ReadonlySet<string>,
  promptSequences: ReadonlyMap<string, number>,
  messageID: string | undefined,
  requestSequence: number,
): boolean {
  return isRecoveryContinuation(promptIDs, messageID) && isCurrentRecoveryContinuation(promptSequences, messageID, requestSequence)
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

/** Last assistant message that failed or is still finalizing. */
export function failedAssistant(messages: MessageLike[]): MessageLike | undefined {
  // Only the last message can be the failure we recover from. If the user has
  // sent something after the failed message (e.g. during a backoff wait), the
  // failure is stale and recovery must back off instead of stomping on it.
  const last = messages[messages.length - 1]
  if (last?.info?.role !== "assistant") return undefined
  if (last.info.error) return last
  if (isUnfinishedAssistant(last)) return last
  return undefined
}

export function isUnfinishedAssistant(message: MessageLike | undefined): boolean {
  const info = message?.info
  return info?.role === "assistant" && !info.error && !info.finish && info.time?.completed === undefined
}

export function targetAssistant(messages: MessageLike[], targetID: string, allowTerminal = false): MessageLike | undefined {
  const index = messages.findIndex((message) => message.info?.id === targetID && message.info.role === "assistant")
  if (index < 0 || messages.slice(index + 1).some((message) => message.info?.role === "user" || message.info?.role === "assistant")) return undefined
  const target = messages[index]
  const info = target.info
  if (!info) return undefined
  if (info.error || info.finish === "tool-calls" || info.finish === "unknown") return target
  if (allowTerminal && typeof info.finish === "string" && info.finish.length > 0) return target
  return isUnfinishedAssistant(target) ? target : undefined
}

export function candidateAssistant(messages: MessageLike[], opts: RecoveryOptions): MessageLike | undefined {
  return opts.targetMessageID ? targetAssistant(messages, opts.targetMessageID, opts.emptyOutput === true) : failedAssistant(messages)
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
