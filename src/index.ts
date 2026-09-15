import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { STALL_CHECK_MS, STALL_MAX_PER_SWEEP, STALL_TIMEOUT_MS, createState, isBlockedSession, isGenuineRecoveryUserMessage, isSuccessfulRecoveryContinuation, recoveryBarrierAllows, resetRecoveryAfterSuccess, type MessageLike, type SessionState } from "./core"
import { errorText, isAbortError } from "./matcher"
import { createNotifications } from "./notify"
import { createRecovery } from "./recovery"
import { createStallWatch, isEmptyOutput, stallEligible, trackAction } from "./stall"
const logPath = join(homedir(), ".local", "share", "opencode", "logs", "auto-recover.log")
async function log(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
  }
}
const plugin: Plugin = async ({ client }: PluginInput, options: PluginOptions = {}): Promise<Hooks> => {
  const stallTimeoutMs = typeof options.stallTimeoutMs === "number" && options.stallTimeoutMs >= 0 ? options.stallTimeoutMs : STALL_TIMEOUT_MS
  const emptyOutputEnabled = options.emptyOutput !== false
  const states = new Map<string, SessionState>()
  const paused = new Set<string>()
  const pendingUser = new Set<string>()
  const pendingRequests = new Map<string, Set<string>>()
  const pendingWithoutID = new Map<string, number>()
  const parentBySession = new Map<string, string>()
  const knownSessions = new Set<string>()
  const deletedSessions = new Set<string>()
  const unknownParentPending = new Set<string>()
  const notify = createNotifications(client)
  void log("PLUGIN LOADED — opencode-turbo ready (recovery + stall watchdog + notifications)")
  const getState = (sessionID: string): SessionState => {
    const state = states.get(sessionID) ?? createState(); states.set(sessionID, state); return state
  }
  // Assigned after the recovery engine is created; the pending-state helpers
  // below call it at runtime, so the indirection avoids a circular dependency.
  let drainDeferred: () => void = () => {}
  function refreshPauseState(): void {
    paused.clear()
    for (const child of pendingUser) {
      const seen = new Set<string>()
      let current = child
      while (current && !seen.has(current)) {
        seen.add(current)
        paused.add(current)
        current = parentBySession.get(current) ?? ""
      }
    }
  }
  const isBlocked = (sessionID: string) => isBlockedSession(sessionID, paused, unknownParentPending)
  function hasDirectPending(sessionID: string): boolean {
    return (pendingWithoutID.get(sessionID) ?? 0) > 0 || (pendingRequests.get(sessionID)?.size ?? 0) > 0
  }
  function addPending(sessionID: string, requestID?: string): void {
    if (requestID) {
      const requests = pendingRequests.get(sessionID) ?? new Set<string>(); requests.add(requestID); pendingRequests.set(sessionID, requests)
    } else pendingWithoutID.set(sessionID, (pendingWithoutID.get(sessionID) ?? 0) + 1)
    pendingUser.add(sessionID)
    refreshPauseState()
    void ensureParentChain(sessionID)
  }
  function removePending(sessionID: string, requestID?: string): void {
    if (requestID) {
      const requests = pendingRequests.get(sessionID)
      requests?.delete(requestID)
      if (requests?.size === 0) pendingRequests.delete(sessionID)
    } else { pendingRequests.delete(sessionID); pendingWithoutID.delete(sessionID) }
    if (!hasDirectPending(sessionID)) {
      pendingUser.delete(sessionID)
      unknownParentPending.delete(sessionID)
    }
    refreshPauseState()
    drainDeferred()
  }
  function clearSessionPending(sessionID: string): void {
    pendingRequests.delete(sessionID); pendingWithoutID.delete(sessionID); pendingUser.delete(sessionID); unknownParentPending.delete(sessionID)
    refreshPauseState(); drainDeferred()
  }
  function cancelRecovery(sessionID: string, cause: string): void {
    void log(`CANCELLED ${sessionID}: ${cause}`)
    const state = getState(sessionID)
    state.recoveryCancelled = true; state.recoveryGeneration++; state.pendingRecovery = undefined; state.lastRecoveredMessageID = undefined; state.lastRecoveredRequestSequence = undefined; state.preflightAttempts = 0; state.preflightStartedAt = undefined; state.lastEmptyOutputMessageID = undefined
    state.lastErrorKey = undefined; state.lastErrorTime = 0
    clearSessionPending(sessionID)
  }
  const recovery = createRecovery({ client, log, notify, getState, isBlocked, cancelRecovery, states })
  drainDeferred = recovery.drainDeferredRecoveries
  const watch = createStallWatch({
    timeoutMs: stallTimeoutMs,
    checkMs: STALL_CHECK_MS,
    maxPerSweep: STALL_MAX_PER_SWEEP,
    log: (message) => void log(message),
    eligible: (id, now, snapshot) => {
      const state = states.get(id)
      if (!state) return false
      return stallEligible({
        now,
        lastStreamActivity: snapshot.lastStreamActivity,
        timeoutMs: stallTimeoutMs,
        lastPartIsRunningTool: snapshot.lastPartIsRunningTool,
        blocked: isBlocked(id),
        recovering: state.recovering,
        pendingRecovery: state.pendingRecovery !== undefined,
        gaveUp: state.gaveUp,
        recoveryCancelled: state.recoveryCancelled,
        deleted: deletedSessions.has(id),
        known: knownSessions.has(id),
        lastRecoveredMessageID: state.lastRecoveredMessageID,
        stalledMessageID: snapshot.lastMessageID,
      })
    },
  })
  const stallTimer = stallTimeoutMs > 0 ? setInterval(() => {
    const now = performance.now()
    for (const id of watch.sweep(now)) {
      const snapshot = watch.snapshot(id)
      watch.forget(id)
      const quietMs = snapshot ? now - snapshot.lastStreamActivity : stallTimeoutMs
      void recovery.recover(id, `STALL_TIMEOUT: no events for ~${Math.round(quietMs / 60000)}min`, { stall: true })
    }
  }, STALL_CHECK_MS) : undefined
  stallTimer?.unref?.()
  async function ensureParentChain(requestSession: string): Promise<void> {
    let current = requestSession
    const seen = new Set<string>()
    while (pendingUser.has(requestSession) && current && !seen.has(current)) {
      seen.add(current)
      if (!knownSessions.has(current)) {
        unknownParentPending.add(requestSession)
        refreshPauseState()
        let lookupError: unknown
        const res = await client.session.get({ path: { id: current } }).catch((error: unknown) => { lookupError = error; return undefined })
        if (!pendingUser.has(requestSession)) { unknownParentPending.delete(requestSession); refreshPauseState(); return }
        if (!res || res.error || !res.data) {
          const { name, message } = errorText(lookupError ?? res?.error)
          await log(`PARENT ${requestSession}: session lookup ${current} failed: ${name || "no response"}: ${message || "no session data"}`)
          unknownParentPending.delete(requestSession)
          refreshPauseState()
          return
        }
        const info = res.data as { id?: string; parentID?: string }
        knownSessions.add(current)
        if (typeof info.parentID === "string" && info.parentID) parentBySession.set(current, info.parentID)
        else parentBySession.delete(current)
      }
      const parent = parentBySession.get(current)
      if (!parent) {
        unknownParentPending.delete(requestSession)
        refreshPauseState()
        recovery.drainDeferredRecoveries()
        return
      }
      current = parent
      unknownParentPending.add(requestSession)
      refreshPauseState()
    }
  }
  function rememberSession(info: unknown): void {
    if (typeof info !== "object" || info === null) return
    const value = info as { id?: unknown; parentID?: unknown }
    if (typeof value.id !== "string") return
    knownSessions.add(value.id)
    if (typeof value.parentID === "string" && value.parentID) parentBySession.set(value.id, value.parentID)
    else parentBySession.delete(value.id)
    refreshPauseState()
    for (const pending of pendingUser) void ensureParentChain(pending)
    recovery.drainDeferredRecoveries()
  }
  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      try {
        const p = (event.properties ?? {}) as Record<string, any>
        const eventID = (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") && typeof p.info?.id === "string" ? p.info.id : typeof p.sessionID === "string" ? p.sessionID : typeof p.data?.sessionID === "string" ? p.data.sessionID : typeof p.info?.sessionID === "string" ? p.info.sessionID : typeof p.part?.sessionID === "string" ? p.part.sessionID : undefined
        if (event.type !== "session.created" && event.type !== "session.deleted" && typeof eventID === "string" && deletedSessions.has(eventID)) return
        watch.note(event.type, event.properties)
        const track = trackAction(event.type, event.properties)
        if (track.action === "track" && track.sessionID) {
          if (isBlocked(track.sessionID)) paused.add(track.sessionID)
          else recovery.drainDeferredRecoveries()
        } else if (track.action === "pause" && track.sessionID) {
          addPending(track.sessionID, track.requestID)
        } else if (track.action === "resume" && track.sessionID) {
          removePending(track.sessionID, track.requestID)
        } else if (track.action === "clear" && track.sessionID) {
          if (event.type !== "session.deleted") { refreshPauseState(); recovery.drainDeferredRecoveries() }
          if (event.type === "session.error") {
            const props = event.properties as { error?: unknown }
            if (props.error === undefined || isAbortError(props.error)) cancelRecovery(track.sessionID, `session.error ${props.error === undefined ? "empty error" : "abort"}`)
          }
        }
        switch (event.type) {
          case "session.created":
            deletedSessions.delete(((event.properties as { info?: { id?: string } }).info?.id) ?? "")
          case "session.updated":
            rememberSession((event.properties as { info?: unknown }).info)
            return
          case "session.status": {
            const props = event.properties as { sessionID: string; status: { type: string; attempt?: number; message?: string } }
            if (props.status?.type === "retry" && typeof props.sessionID === "string") notify.onSessionStatusRetry(props.sessionID, props.status.attempt ?? 0, props.status.message ?? "")
            return
          }
          case "session.error": {
            const props = event.properties as { sessionID?: string; error?: unknown }
            if (typeof props.sessionID === "string" && !isAbortError(props.error)) void recovery.handleTerminalError(props.sessionID, props.error)
            return
          }
          case "message.updated": {
            const info = (event.properties as { info?: MessageLike["info"] }).info
            if (!info?.sessionID) return
            const state = getState(info.sessionID)
            if (info.role === "user") { if (isGenuineRecoveryUserMessage(state.recoveryPromptMessageIDs, info.id)) { state.recoveryPromptMessageIDs.clear(); state.recoveryPromptRequestSequences.clear(); state.activeRecoveryPromptMessageID = undefined; state.recoveryCancelled = false; void log(`REVIVED ${info.sessionID}: genuine user message cleared abort barrier`); recovery.drainDeferredRecoveries() }; return }
            if (info.role !== "assistant") return
            if (info.error) {
              if (isAbortError(info.error)) { cancelRecovery(info.sessionID, "assistant message abort"); return }
              if (!recoveryBarrierAllows(state.recoveryCancelled) || (info.id && info.id === state.lastRecoveredMessageID && state.lastRecoveredRequestSequence === state.recoveryRequestSequence)) return
              void recovery.handleTerminalError(info.sessionID, info.error, info.id)
            } else if (info.finish && info.finish !== "tool-calls" && info.finish !== "unknown") {
              if (info.id && info.id === state.lastRecoveredMessageID) return
              if (emptyOutputEnabled && info.id && !state.recoveryCancelled && !state.gaveUp && state.lastEmptyOutputMessageID !== info.id) {
                const messages = await recovery.readMessages(info.sessionID, "EMPTY")
                const target = messages?.find((message) => message.info?.id === info.id)
                if (target && isEmptyOutput(target)) {
                  state.lastEmptyOutputMessageID = info.id
                  await log(`EMPTY_OUTPUT: ${info.id} finished with no output`)
                  recovery.scheduleSilentRecovery(info.sessionID, `EMPTY_OUTPUT: ${info.id} finished with no output`, { targetMessageID: info.id, emptyOutput: true })
                  return
                }
              }
              const continuation = info.parentID === state.activeRecoveryPromptMessageID && isSuccessfulRecoveryContinuation(state.recoveryPromptMessageIDs, state.recoveryPromptRequestSequences, info.parentID, state.recoveryRequestSequence)
              if (continuation && (state.attempts > 0 || state.gaveUp)) {
                resetRecoveryAfterSuccess(state, state.recovering)
                await log(`SUCCESS ${info.sessionID}: recovery chain completed, attempts reset`)
                recovery.drainDeferredRecoveries()
              }
            }
            return
          }
          case "session.deleted": {
            const info = (event.properties as { info?: { id?: string } }).info
            if (info?.id) {
              deletedSessions.add(info.id)
              cancelRecovery(info.id, "session deleted")
              states.delete(info.id)
              pendingRequests.delete(info.id)
              pendingWithoutID.delete(info.id)
              pendingUser.delete(info.id)
              unknownParentPending.delete(info.id)
              knownSessions.delete(info.id)
              parentBySession.delete(info.id)
              for (const [child, parent] of parentBySession) {
                if (parent === info.id) {
                  parentBySession.delete(child)
                  knownSessions.delete(child)
                  if (pendingUser.has(child)) { unknownParentPending.add(child); void ensureParentChain(child) }
                }
              }
              refreshPauseState()
              recovery.drainDeferredRecoveries()
            }
            return
          }
        }
      } catch (err) {
        await log(`event handler error: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    dispose: async () => {
      if (stallTimer) clearInterval(stallTimer)
      watch.dispose()
      notify.dispose()
    },
  }
}
export default plugin
