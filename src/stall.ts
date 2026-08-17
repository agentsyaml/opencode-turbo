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
  | { action: "ignore" }

/** Classify an event for stall tracking. Track = generation is alive. */
export function trackAction(type: string, props: unknown): TrackAction {
  const sessionID = sessionIDOf(props)
  switch (type) {
    // generation-progress events: the stream is alive
    case "message.part.updated":
    case "message.updated":
    case "session.status":
      // An event without a session id cannot be tracked — ignoring it keeps
      // the activity map free of bogus keys that could stall-trigger later.
      return sessionID ? { action: "track", sessionID } : { action: "ignore" }
    // terminal events: stop watching this session
    case "session.idle":
    case "session.error":
    case "session.deleted":
      return sessionID ? { action: "clear", sessionID } : { action: "ignore" }
    default:
      return { action: "ignore" }
  }
}

function sessionIDOf(props: unknown): string {
  if (typeof props !== "object" || props === null) return ""
  const p = props as Record<string, unknown>
  const info = (typeof p.info === "object" && p.info !== null ? p.info : {}) as Record<string, unknown>
  const part = (typeof p.part === "object" && p.part !== null ? p.part : {}) as Record<string, unknown>
  return (
    (typeof p.sessionID === "string" ? p.sessionID : "") ||
    (typeof info.sessionID === "string" ? info.sessionID : "") ||
    (typeof info.id === "string" ? info.id : "") ||
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

// ── Empty-output detection ───────────────────────────────────────────────────

interface EmptyMsg {
  parts?: Array<{ type?: string; text?: string; synthetic?: boolean; ignored?: boolean }>
}

/**
 * A completed assistant message that produced no output: no usable text part
 * (reasoning parts don't count) and no tool call. Models occasionally finish
 * after thinking with nothing to show (repetition loops, truncation) — the
 * response is "successful" from opencode's view, so no error ever fires.
 * Tool/agent parts count as output: the model is acting, not silent.
 */
export function isEmptyOutput(message: EmptyMsg | undefined): boolean {
  if (!message?.parts) return true
  let hasAction = false
  for (const p of message.parts) {
    const type = p.type
    if (type === "tool" || type === "agent") hasAction = true
    else if (type === "text" && typeof p.text === "string" && p.text.trim().length > 0 && !p.synthetic && !p.ignored) return false
  }
  return !hasAction
}

