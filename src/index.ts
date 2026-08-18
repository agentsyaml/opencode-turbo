import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  INTERNAL_ABORT_GRACE_MS,
  MAX_ATTEMPTS,
  RE_FETCH_WAIT_MS,
  SETTLE_MS,
  TERMINAL_DELAY_MS,
  TRIGGER_DEDUPE_MS,
  buildContinuation,
  candidateAssistant,
  createState,
  isBlockedSession,
  matchesInternalAbort,
  partialText,
  sleep,
  targetAssistant,
  toPromptPart,
  type MessageLike,
  type PromptPart,
  type RecoveryOptions,
  type SessionState,
} from "./core"
import { errorText, isAbortError, isRecoverable } from "./matcher"
import { createNotifications } from "./notify"
import { idleAction, isActiveStatus, isEmptyOutput, stallCandidates, trackAction } from "./stall"
const logPath = join(homedir(), ".local", "share", "opencode", "logs", "auto-recover.log")
const STALL_TIMEOUT_MS = 30 * 60_000
const STALL_CHECK_MS = 30_000 // watchdog scan interval
async function log(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
  }
}
const plugin: Plugin = async ({ client }: PluginInput, options: PluginOptions = {}): Promise<Hooks> => {
  const states = new Map<string, SessionState>()
  const activity = new Map<string, number>()
  const paused = new Set<string>()
  const pendingUser = new Set<string>()
  const pendingRequests = new Map<string, Set<string>>()
  const pendingWithoutID = new Map<string, number>()
  const parentBySession = new Map<string, string>()
  const knownSessions = new Set<string>()
  const unknownParentPending = new Set<string>()
  const stallTimeoutMs = typeof options.stallTimeoutMs === "number" ? options.stallTimeoutMs : STALL_TIMEOUT_MS
  const notify = createNotifications(client)
  void log("PLUGIN LOADED — opencode-turbo ready (recovery + stall watchdog + notifications)")
  const getState = (sessionID: string): SessionState => {
    const state = states.get(sessionID) ?? createState(); states.set(sessionID, state); return state
  }
  function backoff(attempt: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
  }
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
    for (const id of activity.keys()) if (paused.has(id)) activity.delete(id)
  }
  const isBlocked = (sessionID: string) => isBlockedSession(sessionID, paused, unknownParentPending)
  function noteActivity(sessionID: string, now: number): void {
    if (isBlocked(sessionID)) return
    activity.set(sessionID, now)
    let parent = parentBySession.get(sessionID)
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) { if (isBlocked(parent)) break; activity.set(parent, now); seen.add(parent); parent = parentBySession.get(parent) }
  }
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
    drainDeferredRecoveries()
  }
  function clearSessionPending(sessionID: string): void {
    pendingRequests.delete(sessionID); pendingWithoutID.delete(sessionID); pendingUser.delete(sessionID); unknownParentPending.delete(sessionID)
    refreshPauseState(); drainDeferredRecoveries()
  }
  function isInternalAbort(sessionID: string, messageID?: string): boolean { const state = getState(sessionID); return matchesInternalAbort(state.internalAbortGeneration, state.recoveryGeneration, state.internalAbortMessageID, messageID) }
  function consumeInternalAbort(sessionID: string, messageID?: string): boolean { const state = getState(sessionID); if (!isInternalAbort(sessionID, messageID)) return false; state.internalAbortGeneration = undefined; state.internalAbortMessageID = undefined; return true }
  function markInternalAbort(sessionID: string, generation: number, messageID: string): void {
    const state = getState(sessionID)
    state.internalAbortGeneration = generation
    state.internalAbortMessageID = messageID
    const timer = setTimeout(() => { if (state.recoveryGeneration === generation && state.internalAbortGeneration === generation && state.internalAbortMessageID === messageID) { state.internalAbortGeneration = undefined; state.internalAbortMessageID = undefined } }, INTERNAL_ABORT_GRACE_MS)
    timer.unref?.()
  }
  function cancelRecovery(sessionID: string): void {
    const state = getState(sessionID)
    state.recoveryGeneration++; state.internalAbortGeneration = undefined; state.internalAbortMessageID = undefined; state.pendingRecovery = undefined; state.lastRecoveredMessageID = undefined
    state.lastErrorKey = undefined; state.lastErrorTime = 0
    clearSessionPending(sessionID)
  }
  async function readMessages(sessionID: string, phase: string): Promise<MessageLike[] | undefined> {
    const res = await client.session.messages({ path: { id: sessionID } }).catch(async (err) => {
      await log(`${phase} ${sessionID}: messages threw: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    })
    if (res?.error) {
      const { name, message } = errorText(res.error)
      await log(`${phase} ${sessionID}: messages failed: ${name}: ${message}`)
      return undefined
    }
    return res ? ((res.data ?? []) as MessageLike[]) : undefined
  }
  async function serviceStatus(sessionID: string): Promise<{ failed: boolean; type?: string }> { const res = await client.session.status().catch(() => undefined); if (!res || res.error) return { failed: true }; const type = (res.data as Record<string, { type?: unknown }> | undefined)?.[sessionID]?.type; return { failed: false, ...(typeof type === "string" ? { type } : {}) } }
  async function ensureParentChain(requestSession: string): Promise<void> {
    let current = requestSession
    const seen = new Set<string>()
    while (pendingUser.has(requestSession) && current && !seen.has(current)) {
      seen.add(current)
      if (!knownSessions.has(current)) {
        unknownParentPending.add(requestSession)
        refreshPauseState()
        const res = await client.session.get({ path: { id: current } }).catch(() => undefined)
        if (!res || res.error || !res.data) return
        const info = res.data as { id?: string; parentID?: string }
        knownSessions.add(current)
        if (typeof info.parentID === "string" && info.parentID) parentBySession.set(current, info.parentID)
        else parentBySession.delete(current)
      }
      const parent = parentBySession.get(current)
      if (!parent) {
        unknownParentPending.delete(requestSession)
        refreshPauseState()
        drainDeferredRecoveries()
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
    drainDeferredRecoveries()
  }
  async function recover(sessionID: string, reason: string, opts: RecoveryOptions = {}): Promise<void> {
    const state = getState(sessionID)
    const generation = state.recoveryGeneration
    const cancelled = () => state.recoveryGeneration !== generation
    if (state.recovering) {
      state.pendingRecovery = { reason, ...opts }
      return
    }
    if (state.gaveUp) return
    if (isBlocked(sessionID)) {
      state.pendingRecovery = { reason, ...opts }
      return
    }
    state.recovering = true
    try {
      const attempt = state.attempts + 1
      if (attempt > MAX_ATTEMPTS) {
        state.gaveUp = true
        await log(`GIVING UP on ${sessionID} after ${MAX_ATTEMPTS} attempts (last: ${reason})`)
        return
      }
      await log(`RECOVER ${sessionID} attempt ${attempt}/${MAX_ATTEMPTS} — ${reason}`); if (cancelled()) return
      let messages = await readMessages(sessionID, "RECOVER")
      if (cancelled()) return
      if (!messages || messages.length === 0) {
        await log(`RECOVER ${sessionID}: no messages, skipping recovery`)
        return
      }
      let candidate = candidateAssistant(messages, opts)
      if (!candidate) {
        await sleep(RE_FETCH_WAIT_MS)
        if (cancelled()) return
        messages = await readMessages(sessionID, "RECOVER")
        if (cancelled()) return
        candidate = messages ? candidateAssistant(messages, opts) : undefined
      }
      if (!candidate?.info?.id) {
        await log(`RECOVER ${sessionID}: no current interrupted message, skipping recovery`)
        return
      }
      const targetID = opts.targetMessageID ?? candidate.info.id
      messages = await readMessages(sessionID, "RECOVER")
      if (cancelled()) return
      candidate = messages ? targetAssistant(messages, targetID, Boolean(opts.emptyOutput)) : undefined
      if (!messages || !candidate) {
        await log(`RECOVER ${sessionID}: target ${targetID} is stale, skipping recovery`)
        return
      }
      if (isBlocked(sessionID)) {
        state.pendingRecovery = { reason, ...opts }
        return
      }
      const status = await serviceStatus(sessionID)
      if (cancelled()) return
      messages = await readMessages(sessionID, "PREFLIGHT"); candidate = messages ? targetAssistant(messages, targetID, Boolean(opts.emptyOutput)) : undefined
      if (cancelled()) return
      if (!messages || !candidate) { if (opts.stall) activity.delete(sessionID); return }
      if (isBlocked(sessionID)) { state.pendingRecovery = { reason, ...opts }; return }
      const terminalTarget = Boolean(opts.emptyOutput || candidate.info?.error)
      if (status.failed) {
        state.pendingRecovery = { reason, ...opts }
        await sleep(backoff(attempt))
        return
      }
      if (status.type === undefined && !terminalTarget) {
        await log(`RECOVER ${sessionID}: target ${targetID} has no active status`); if (opts.stall) activity.delete(sessionID)
        return
      }
      if (status.type !== undefined && (terminalTarget ? status.type !== "idle" : !isActiveStatus(status.type))) {
        if (!terminalTarget) { await log(`RECOVER ${sessionID}: target ${targetID} is no longer active`); if (opts.stall) activity.delete(sessionID); return }
        state.pendingRecovery = { reason, ...opts }
        await sleep(backoff(attempt))
        return
      }
      if (!opts.emptyOutput && !candidate.info?.error) {
        markInternalAbort(sessionID, generation, targetID)
        const abortRes = await client.session.abort({ path: { id: sessionID } }).catch(async (err) => { await log(`RECOVER ${sessionID}: abort threw: ${err instanceof Error ? err.message : String(err)}`); return undefined })
        if (cancelled()) return
        if (!abortRes || abortRes.error) {
          const { name, message } = errorText(abortRes?.error)
          await log(`RECOVER ${sessionID}: abort failed: ${name}: ${message}`)
          if (!state.pendingRecovery) state.pendingRecovery = { reason, ...opts }; await sleep(backoff(attempt)); return
        }
        await sleep(SETTLE_MS)
        if (cancelled()) return
      }
      if (attempt > 1) { await sleep(backoff(attempt)); if (cancelled()) return }
      if (opts.delay) { await sleep(TERMINAL_DELAY_MS); if (cancelled()) return }
      messages = await readMessages(sessionID, "RECOVER")
      if (cancelled()) return
      const lastAssistant = messages ? targetAssistant(messages, targetID, Boolean(opts.emptyOutput)) : undefined
      if (!messages || !lastAssistant) { await log(`RECOVER ${sessionID}: target ${targetID} changed, skipping recovery`); if (opts.stall) activity.delete(sessionID); return }
      if (cancelled() || isBlocked(sessionID)) { if (!cancelled()) state.pendingRecovery = { reason, ...opts }; return }
      const partial = partialText(lastAssistant)
      const hasModel = Boolean(lastAssistant.info?.providerID && lastAssistant.info.modelID)
      const model = hasModel ? { providerID: lastAssistant.info!.providerID!, modelID: lastAssistant.info!.modelID! } : undefined
      const lastUser = [...messages].reverse().find((m) => m.info?.role === "user")
      if (!lastUser?.info?.id) { await log(`RECOVER ${sessionID}: no user message, aborting recovery`); return }
      state.attempts = attempt
      notify.onRecoveryStart(sessionID, attempt, MAX_ATTEMPTS)
      state.lastRecoveredMessageID = lastAssistant.info?.id
      state.lastErrorKey = undefined
      state.lastErrorTime = 0
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
        .catch(async (err) => { await log(`RECOVER ${sessionID}: prompt threw: ${err instanceof Error ? err.message : String(err)}`); return undefined })
      if (cancelled()) { state.lastRecoveredMessageID = undefined; return }
      if (!promptRes || promptRes.error) {
        const { name, message } = errorText(promptRes?.error)
        await log(`RECOVER ${sessionID}: continuation prompt failed: ${name}: ${message}`)
        if (state.lastRecoveredMessageID === targetID) state.lastRecoveredMessageID = undefined
        if (!state.pendingRecovery) state.pendingRecovery = { reason, ...opts }; await sleep(backoff(attempt)); return
      }
      await log(`RECOVER ${sessionID}: continuation prompt sent (attempt ${attempt})`)
    } catch (err) {
      await log(`RECOVER ${sessionID} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      state.recovering = false
      const pending = state.pendingRecovery
      if (!cancelled() && pending && !isBlocked(sessionID)) { state.pendingRecovery = undefined; void recover(sessionID, pending.reason, pending) }
    }
  }
  function drainDeferredRecoveries(): void {
    for (const [sessionID, state] of states) {
      const pending = state.pendingRecovery
      if (pending && !state.recovering && !isBlocked(sessionID)) { state.pendingRecovery = undefined; void recover(sessionID, pending.reason, pending) }
    }
  }
  function burstGate(state: SessionState, error: unknown): boolean {
    const { name, message } = errorText(error)
    const key = `${name}:${message}`
    const now = Date.now()
    if (state.lastErrorKey === key && now - state.lastErrorTime < TRIGGER_DEDUPE_MS) return false
    state.lastErrorKey = key
    state.lastErrorTime = now
    return true
  }
  const handleTerminalError = async (sessionID: string, error: unknown, targetMessageID?: string) => {
    if (!isRecoverable(error)) {
      const { name, message } = errorText(error); if (message || name) void log(`NOT-RECOVERABLE ${sessionID}: ${name}: ${message}`); return
    }
    const state = getState(sessionID)
    const generation = state.recoveryGeneration
    const { name, message } = errorText(error)
    let targetID = targetMessageID
    if (!targetID) {
      const messages = await readMessages(sessionID, "ERROR"); const last = messages?.[messages.length - 1]
      if (state.recoveryGeneration !== generation) return
      if (last?.info?.role !== "assistant" || !last.info.error || !last.info.id) return; targetID = last.info.id
    }
    if (state.recoveryGeneration !== generation) return
    if (!burstGate(state, error)) return
    void recover(sessionID, message || name, { delay: true, targetMessageID: targetID })
  }
  async function settleFinished(sessionID: string, messageID: string): Promise<void> {
    const state = getState(sessionID)
    const generation = state.recoveryGeneration
    await sleep(TERMINAL_DELAY_MS) // let the message finalize before reading
    if (state.recoveryGeneration !== generation) return
    const messages = await readMessages(sessionID, "SETTLE")
    if (state.recoveryGeneration !== generation) return
    if (!messages) return
    const finished = messages.find((m) => m.info?.id === messageID)
    if (finished && isEmptyOutput(finished)) {
      if (state.recovering) return // recovery in flight; its own event will settle
      void recover(sessionID, `EMPTY_OUTPUT: ${messageID} finished with no output`, { delay: true, emptyOutput: true, targetMessageID: messageID })
      return
    }
    if (!finished) return
    if ((state.attempts > 0 || state.gaveUp) && !state.recovering) {
      state.attempts = 0
      state.gaveUp = false
      state.lastRecoveredMessageID = undefined
      state.lastErrorKey = undefined
      state.lastErrorTime = 0
      await log(`SUCCESS ${sessionID}: recovery chain completed, attempts reset`)
    }
  }
  const stallTimer = stallTimeoutMs > 0
    ? setInterval(() => {
        const now = Date.now()
        for (const id of stallCandidates(activity, now, stallTimeoutMs)) {
          const state = getState(id)
          if (isBlocked(id)) {
            activity.delete(id)
            continue
          }
          if (state.gaveUp) {
            activity.delete(id)
            continue
          }
          const quietFor = Math.round((now - (activity.get(id) ?? now)) / 60_000)
          activity.set(id, now)
          void (async () => {
            const generation = state.recoveryGeneration
            if (isBlocked(id)) return
            const messages = await readMessages(id, "STALL")
            const target = messages?.[messages.length - 1]
            if (state.recoveryGeneration !== generation || activity.get(id) !== now || isBlocked(id)) return
            if (target?.info?.role !== "assistant" || !target.info.id || target.info.error) return
            if (!messages || !targetAssistant(messages, target.info.id, false)) return
            void recover(id, `STALL_TIMEOUT: no events for ~${quietFor}min`, { targetMessageID: target.info.id, stall: true })
          })()
        }
      }, STALL_CHECK_MS)
    : undefined
  stallTimer?.unref?.()
  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      try {
        const track = trackAction(event.type, event.properties)
        if (track.action === "track" && track.sessionID) {
          if (isBlocked(track.sessionID)) { paused.add(track.sessionID); activity.delete(track.sessionID) }
          else { noteActivity(track.sessionID, Date.now()); drainDeferredRecoveries() }
        } else if (track.action === "pause" && track.sessionID) {
          addPending(track.sessionID, track.requestID)
        } else if (track.action === "resume" && track.sessionID) {
          removePending(track.sessionID, track.requestID)
        } else if (track.action === "clear" && track.sessionID) {
          activity.delete(track.sessionID)
          if (event.type === "session.idle" && idleAction(track.sessionID, pendingUser.has(track.sessionID)).action === "pause") paused.add(track.sessionID)
          refreshPauseState(); drainDeferredRecoveries()
          if (event.type === "session.error") {
            const props = event.properties as { error?: unknown }
            if ((props.error === undefined || isAbortError(props.error)) && !consumeInternalAbort(track.sessionID)) cancelRecovery(track.sessionID)
          }
        }
        switch (event.type) {
          case "session.created":
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
            if (typeof props.sessionID === "string") void handleTerminalError(props.sessionID, props.error)
            return
          }
          case "message.updated": {
            const info = (event.properties as { info?: MessageLike["info"] }).info
            if (!info?.sessionID || info.role !== "assistant") return
            if (info.error) {
              if (isAbortError(info.error)) { if (!(info.id && consumeInternalAbort(info.sessionID, info.id))) cancelRecovery(info.sessionID); return }
              const state = getState(info.sessionID)
              if (info.id && info.id === state.lastRecoveredMessageID) return
              void handleTerminalError(info.sessionID, info.error, info.id)
            } else if (info.finish && info.finish !== "tool-calls" && info.finish !== "unknown") {
              const state = getState(info.sessionID)
              if (info.id && info.id === state.lastRecoveredMessageID) return
              if (info.id && info.id === state.lastEmptyCheckMessageID) return
              if (info.id) {
                state.lastEmptyCheckMessageID = info.id
                void settleFinished(info.sessionID, info.id)
              } else if ((state.attempts > 0 || state.gaveUp) && !state.recovering) {
                state.attempts = 0
                state.gaveUp = false
                state.lastRecoveredMessageID = undefined
                state.lastErrorKey = undefined
                state.lastErrorTime = 0
                await log(`SUCCESS ${info.sessionID}: recovery chain completed, attempts reset`)
              }
            }
            return
          }
          case "session.deleted": {
            const info = (event.properties as { info?: { id?: string } }).info
            if (info?.id) {
              states.delete(info.id)
              activity.delete(info.id)
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
              drainDeferredRecoveries()
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
      notify.dispose()
    },
  }
}
export default plugin
