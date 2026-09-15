// Stall detection for opencode-turbo.
//
// A silent stream stall (TCP alive, SSE silent) produces no error, so opencode
// never retries or times out — the session hangs forever. The watchdog treats
// EVENT SILENCE as the hang signal: any generation-progress event proves the
// stream is alive, so legitimate long reasoning (which keeps streaming
// reasoning parts) is never misjudged. Only sessions that went quiet while
// generating are candidates.

export type TrackAction =
  | { action: "track"; sessionID: string }
  | { action: "clear"; sessionID: string }
  | { action: "pause"; sessionID: string; requestID?: string }
  | { action: "resume"; sessionID: string; requestID?: string }
  | { action: "ignore" }

export function idleAction(sessionID: string, hasPending: boolean): TrackAction {
  return hasPending ? { action: "pause", sessionID } : { action: "clear", sessionID }
}

/** Classify an event for stall tracking. Track = generation is alive. */
export function trackAction(type: string, props: unknown): TrackAction {
  const sessionID = sessionIDOf(props)
  switch (type) {
    // generation-progress events: the stream is alive
    case "message.part.updated":
      // An event without a session id cannot be tracked — ignoring it keeps
      // the activity map free of bogus keys that could stall-trigger later.
      return sessionID ? { action: "track", sessionID } : { action: "ignore" }
    case "message.updated": {
      const info = objectField(props, "info")
      if (!info || (info.role !== "assistant" && info.type !== "assistant")) return { action: "ignore" }
      if (info.error || terminalFinish(info.finish)) return sessionID ? { action: "clear", sessionID } : { action: "ignore" }
      return sessionID ? { action: "track", sessionID } : { action: "ignore" }
    }
    case "session.status": {
      const status = objectField(props, "status")?.type
      if (!sessionID) return { action: "ignore" }
      if (status === "idle" || status === "retry") return { action: "clear", sessionID }
      if (isActiveStatus(status)) return { action: "track", sessionID }
      return { action: "ignore" }
    }
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked":
    case "question.asked":
    case "question.v2.asked":
      return sessionID ? pause(sessionID, requestIDOf(props)) : { action: "ignore" }
    case "permission.replied":
    case "permission.v2.replied":
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected":
      return sessionID ? resume(sessionID, requestIDOf(props)) : { action: "ignore" }
    // terminal events: stop watching this session
    case "session.idle":
    case "session.error":
      return sessionID ? { action: "clear", sessionID } : { action: "ignore" }
    case "session.deleted": {
      const deletedID = sessionID || objectField(props, "info")?.id || ""
      return deletedID ? { action: "clear", sessionID: deletedID } : { action: "ignore" }
    }
    default:
      return { action: "ignore" }
  }
}

const ACTIVE_STATUSES = new Set(["busy", "running", "queued", "working", "generating", "thinking", "streaming"])

export function isActiveStatus(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_STATUSES.has(status)
}

function terminalFinish(finish: unknown): boolean {
  return typeof finish === "string" && finish.length > 0 && finish !== "tool-calls" && finish !== "unknown"
}

function objectField(value: unknown, key: string): Record<string, any> | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "object" && field !== null ? (field as Record<string, any>) : undefined
}

function pause(sessionID: string, requestID: string | undefined): TrackAction {
  return requestID ? { action: "pause", sessionID, requestID } : { action: "pause", sessionID }
}

function resume(sessionID: string, requestID: string | undefined): TrackAction {
  return requestID ? { action: "resume", sessionID, requestID } : { action: "resume", sessionID }
}

function requestIDOf(props: unknown): string | undefined {
  if (typeof props !== "object" || props === null) return undefined
  const p = props as Record<string, unknown>
  const data = typeof p.data === "object" && p.data !== null ? (p.data as Record<string, unknown>) : undefined
  for (const key of ["id", "requestID", "permissionID"]) {
    if (typeof p[key] === "string") return p[key] as string
    if (typeof data?.[key] === "string") return data[key] as string
  }
  return undefined
}

function sessionIDOf(props: unknown): string {
  if (typeof props !== "object" || props === null) return ""
  const p = props as Record<string, unknown>
  const data = (typeof p.data === "object" && p.data !== null ? p.data : {}) as Record<string, unknown>
  const info = (typeof p.info === "object" && p.info !== null ? p.info : {}) as Record<string, unknown>
  const part = (typeof p.part === "object" && p.part !== null ? p.part : {}) as Record<string, unknown>
  return (
    (typeof p.sessionID === "string" ? p.sessionID : "") ||
    (typeof data.sessionID === "string" ? data.sessionID : "") ||
    (typeof info.sessionID === "string" ? info.sessionID : "") ||
    (typeof part.sessionID === "string" ? part.sessionID : "") ||
    ""
  )
}

/** Session IDs whose last activity is older than the timeout. */
export function stallCandidates(activity: ReadonlyMap<string, number>, now: number, timeoutMs: number): string[] {
  const stalled: string[] = []
  for (const [id, last] of activity) {
    if (now - last > timeoutMs) stalled.push(id)
  }
  return stalled
}

// ── Stall watchdog state machine ────────────────────────────────────────────
//
// A silent SSE stall produces no events and therefore no error, so the only
// signal is elapsed time. The watch records the last stream-progress instant
// per session using a monotonic clock (so sleep/wake cannot fake a stall) and
// exposes sweep() for a periodic timer to call. It never acts on its own: the
// entry wires sweep() into recover(), whose status preflight refuses to prompt
// a busy session. A long-running tool is legitimate waiting, never a stall.

export type PartActivity = "stream" | "progress" | "tool-wait" | "ignore"

export function partActivity(part: unknown): PartActivity {
  if (typeof part !== "object" || part === null) return "ignore"
  const p = part as Record<string, unknown>
  if (p.type === "text" || p.type === "reasoning") return "stream"
  if (p.type !== "tool") return "ignore"
  const status = stringField(p.state, "status")
  if (status === "completed" || status === "error") return "progress"
  if (status === "running" || status === "pending") return "tool-wait"
  return "ignore"
}

export function lastPartIsRunningTool(parts: unknown): boolean {
  if (!Array.isArray(parts) || parts.length === 0) return false
  return partActivity(parts[parts.length - 1]) === "tool-wait"
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === "string" ? field : undefined
}

export interface StallSnapshot {
  lastStreamActivity: number
  lastPartIsRunningTool: boolean
  lastMessageID?: string
}

/** Pure eligibility gate. The caller supplies session/state facts. */
export function stallEligible(input: {
  now: number
  lastStreamActivity: number
  timeoutMs: number
  lastPartIsRunningTool: boolean
  blocked: boolean
  recovering: boolean
  pendingRecovery: boolean
  gaveUp: boolean
  recoveryCancelled: boolean
  deleted: boolean
  known: boolean
  lastRecoveredMessageID?: string
  stalledMessageID?: string
}): boolean {
  if (input.lastPartIsRunningTool) return false
  if (input.blocked || input.recovering || input.pendingRecovery || input.gaveUp || input.recoveryCancelled) return false
  if (input.deleted || !input.known) return false
  if (input.stalledMessageID !== undefined && input.lastRecoveredMessageID === input.stalledMessageID) return false
  return input.now - input.lastStreamActivity > input.timeoutMs
}

export interface StallWatch {
  readonly enabled: boolean
  note(type: string, props: unknown): void
  sweep(now: number): string[]
  forget(id: string): void
  snapshot(id: string): StallSnapshot | undefined
  dispose(): void
}

export interface StallWatchOptions {
  timeoutMs: number
  checkMs: number
  maxPerSweep: number
  now?: () => number
  log?: (message: string) => void
  eligible?: (id: string, now: number, snapshot: StallSnapshot) => boolean
}

interface WatchEntry extends StallSnapshot {
  toolWaitLogged: boolean
}

export function createStallWatch(options: StallWatchOptions): StallWatch {
  const enabled = options.timeoutMs > 0
  const clock = options.now ?? (() => performance.now())
  const entries = new Map<string, WatchEntry>()

  function entry(id: string): WatchEntry {
    let value = entries.get(id)
    if (!value) {
      value = { lastStreamActivity: clock(), lastPartIsRunningTool: false, toolWaitLogged: false }
      entries.set(id, value)
    }
    return value
  }
  function touchStream(id: string): void {
    const value = entry(id)
    value.lastStreamActivity = clock()
    value.lastPartIsRunningTool = false
    value.toolWaitLogged = false
  }
  function note(type: string, props: unknown): void {
    if (!enabled) return
    const track = trackAction(type, props)
    if (track.action === "ignore" || track.action === "pause") return
    if (track.action === "clear") {
      entries.delete(track.sessionID)
      return
    }
    if (track.action === "resume") {
      touchStream(track.sessionID)
      return
    }
    const id = track.sessionID
    if (type === "message.part.updated") {
      const part = objectField(props, "part")
      const activity = partActivity(part)
      if (activity === "ignore") return
      const value = entry(id)
      if (part && typeof part.messageID === "string") value.lastMessageID = part.messageID
      if (activity === "tool-wait") {
        value.lastPartIsRunningTool = true
        return
      }
      touchStream(id)
      return
    }
    if (type === "message.updated") {
      const info = objectField(props, "info")
      const value = entry(id)
      if (info && typeof info.id === "string") value.lastMessageID = info.id
      touchStream(id)
      return
    }
    touchStream(id)
  }
  function snapshot(id: string): StallSnapshot | undefined {
    const value = entries.get(id)
    return value ? { lastStreamActivity: value.lastStreamActivity, lastPartIsRunningTool: value.lastPartIsRunningTool, lastMessageID: value.lastMessageID } : undefined
  }
  function sweep(now: number): string[] {
    if (!enabled) return []
    const stale: string[] = []
    for (const [id, value] of entries) {
      if (stale.length >= options.maxPerSweep) break
      if (now - value.lastStreamActivity <= options.timeoutMs) continue
      if (value.lastPartIsRunningTool) {
        if (!value.toolWaitLogged) {
          value.toolWaitLogged = true
          options.log?.(`STALL_TOOL_WAIT ${id}`)
        }
        continue
      }
      const snap: StallSnapshot = { lastStreamActivity: value.lastStreamActivity, lastPartIsRunningTool: value.lastPartIsRunningTool, lastMessageID: value.lastMessageID }
      if (options.eligible && !options.eligible(id, now, snap)) continue
      stale.push(id)
    }
    return stale
  }
  function forget(id: string): void {
    entries.delete(id)
  }
  function dispose(): void {
    entries.clear()
  }
  return { enabled, note, sweep, forget, snapshot, dispose }
}


// ── Empty-output detection ───────────────────────────────────────────────────

interface EmptyMsg {
  parts?: unknown
}

/**
 * A completed assistant message that produced no output: no usable text part
 * (reasoning parts don't count) and no tool call. Models occasionally finish
 * after thinking with nothing to show (repetition loops, truncation) — the
 * response is "successful" from opencode's view, so no error ever fires.
 * Tool/agent parts count as output: the model is acting, not silent.
 */
export function isEmptyOutput(message: EmptyMsg | undefined): boolean {
  if (typeof message !== "object" || message === null || !Array.isArray(message.parts)) return false
  let hasAction = false
  for (const p of message.parts) {
    if (typeof p !== "object" || p === null) return false
    const part = p as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown }
    const type = part.type
    if (type === "tool" || type === "agent") hasAction = true
    else if (type === "reasoning") continue
    else if (STRUCTURAL_PARTS.has(type as string)) continue
    else if (type === "text") {
      if (typeof part.text !== "string") return false
      if (part.text.trim().length > 0 && !part.synthetic && !part.ignored) return false
    } else return false
  }
  return !hasAction
}

const STRUCTURAL_PARTS = new Set(["step-start", "step-finish", "snapshot", "patch", "compaction"])
