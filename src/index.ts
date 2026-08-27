import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, MAX_PREFLIGHT_ATTEMPTS, MAX_ATTEMPTS, RE_FETCH_WAIT_MS, TERMINAL_DELAY_MS, TRIGGER_DEDUPE_MS, buildContinuation, candidateAssistant, createState, discardPendingRecovery, isBlockedSession, isGenuineRecoveryUserMessage, isSuccessfulRecoveryContinuation, isUnfinishedAssistant, messageReadFailed, partialText, recoveryBarrierAllows, recoveryRequestIsCurrent, resetRecoveryAfterSuccess, samePendingRecovery, recoveryRequestIsNewer, startsRecoveryChain, sleep, targetAssistant, toPromptPart, type MessageLike, type PromptPart, type RecoveryOptions, type SessionState } from "./core"
import { errorText, isAbortError, isRecoverable } from "./matcher"
import { createNotifications } from "./notify"
import { trackAction } from "./stall"
const logPath = join(homedir(), ".local", "share", "opencode", "logs", "auto-recover.log")
async function log(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
  }
}
const plugin: Plugin = async ({ client }: PluginInput): Promise<Hooks> => {
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
  void log("PLUGIN LOADED — opencode-turbo ready (recovery + notifications)")
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
    drainDeferredRecoveries()
  }
  function clearSessionPending(sessionID: string): void {
    pendingRequests.delete(sessionID); pendingWithoutID.delete(sessionID); pendingUser.delete(sessionID); unknownParentPending.delete(sessionID)
    refreshPauseState(); drainDeferredRecoveries()
  }
  function cancelRecovery(sessionID: string): void {
    const state = getState(sessionID)
    state.recoveryCancelled = true; state.recoveryGeneration++; state.pendingRecovery = undefined; state.lastRecoveredMessageID = undefined; state.lastRecoveredRequestSequence = undefined; state.preflightAttempts = 0
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
  async function serviceStatus(sessionID: string): Promise<{ failed: boolean; type?: string; error?: unknown }> {
    const result = await client.session.status().then((response) => ({ response })).catch((error: unknown) => ({ error }))
    if ("error" in result) return { failed: true, error: result.error }
    const response = result.response
    if (!response || (response.error !== undefined && response.error !== null)) return { failed: true, error: response?.error }
    const type = (response.data as Record<string, { type?: unknown }> | undefined)?.[sessionID]?.type
    return { failed: false, ...(typeof type === "string" ? { type } : {}) }
  }
  function queuePendingIfCurrent(
    state: SessionState,
    expected: SessionState["pendingRecovery"],
    requestSequence: number,
    reason: string,
    opts: RecoveryOptions,
    current: () => boolean,
  ): void {
    if (!current() || !samePendingRecovery(state.pendingRecovery, expected) || !recoveryRequestIsNewer(expected?.requestSequence, requestSequence)) return
    state.pendingRecovery = { reason, ...opts }
  }
  async function stopAtAttemptLimit(sessionID: string, state: SessionState, reason: string, current: () => boolean): Promise<void> {
    const firstStop = !state.gaveUp
    if (!firstStop) return
    await log(`GIVING UP on ${sessionID} after ${MAX_ATTEMPTS} attempts (last: ${reason})`)
    if (!current()) return
    state.gaveUp = true
    notify.onRecoveryStopped(sessionID, `stopped scheduling after ${MAX_ATTEMPTS} continuation attempts — ${reason}`)
  }
  async function deferPreflight(
    sessionID: string,
    state: SessionState,
    reason: string,
    opts: RecoveryOptions,
    detail: string,
    current: () => boolean,
    expectedPending: SessionState["pendingRecovery"],
  ): Promise<boolean> {
    if (!current()) return false
    const attempt = state.preflightAttempts + 1
    state.preflightAttempts = attempt
    if (attempt >= MAX_PREFLIGHT_ATTEMPTS) {
      await log(`RECOVER ${sessionID}: preflight stopped after ${MAX_PREFLIGHT_ATTEMPTS} attempts — ${detail}`)
      if (!current()) return false
      notify.onRecoveryStopped(sessionID, `stopped scheduling after ${MAX_PREFLIGHT_ATTEMPTS} preflight attempts — ${detail}`)
      return true
    }
    queuePendingIfCurrent(state, expectedPending, opts.requestSequence ?? -1, reason, opts, current)
    await sleep(backoff(attempt))
    return false
  }
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
    const generation = state.recoveryGeneration; const requestSequence = opts.requestSequence ?? ++state.recoveryRequestSequence; if (requestSequence > state.recoveryRequestSequence) state.recoveryRequestSequence = requestSequence; if (opts.requestSequence === undefined) opts = { ...opts, requestSequence }; const pendingAtStart = state.pendingRecovery; const current = () => recoveryRequestIsCurrent(state, generation, requestSequence)
    if (!current()) return
    if (state.recovering) {
      if (recoveryBarrierAllows(state.recoveryCancelled)) queuePendingIfCurrent(state, state.pendingRecovery, requestSequence, reason, opts, current)
      return
    }
    if (state.gaveUp || !recoveryBarrierAllows(state.recoveryCancelled)) return
    if (isBlocked(sessionID)) {
      queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current)
      return
    }
    state.recovering = true
    let stopScheduling = false
    const defer = async (detail: string): Promise<void> => {
      if (await deferPreflight(sessionID, state, reason, opts, detail, current, pendingAtStart)) stopScheduling = true
    }
    const terminalize = (): void => { if (current()) discardPendingRecovery(state, pendingAtStart) }
    try {
      if (state.attempts >= MAX_ATTEMPTS) {
        stopScheduling = true
        await stopAtAttemptLimit(sessionID, state, reason, current)
        return
      }
      await log(`RECOVER ${sessionID} preparing attempt ${state.attempts + 1}/${MAX_ATTEMPTS} — ${reason}`); if (!current()) return
      let messages = await readMessages(sessionID, "RECOVER")
      if (!current()) return
      if (messageReadFailed(messages)) {
        await defer("message read failed")
        return
      }
      if (messages.length === 0) { if (!opts.targetMessageID) { await defer("failed assistant message not ready"); return }; await log(`RECOVER ${sessionID}: no messages, skipping recovery`); terminalize(); return }
      let candidate = candidateAssistant(messages, opts)
      if (!candidate) {
        await sleep(RE_FETCH_WAIT_MS)
        if (!current()) return
        messages = await readMessages(sessionID, "RECOVER")
        if (!current()) return
        if (messageReadFailed(messages)) {
          await defer("message read failed")
          return
        }
        candidate = candidateAssistant(messages, opts)
      }
      if (!candidate?.info?.id) { if (!opts.targetMessageID) { await defer("failed assistant message not ready"); return }; await log(`RECOVER ${sessionID}: no current interrupted message, skipping recovery`); terminalize(); return }
      const targetID = opts.targetMessageID ?? candidate.info.id
      messages = await readMessages(sessionID, "RECOVER")
      if (!current()) return
      if (messageReadFailed(messages)) {
        await defer("message read failed")
        return
      }
      candidate = targetAssistant(messages, targetID)
      if (!candidate) {
        await log(`RECOVER ${sessionID}: target ${targetID} is stale, skipping recovery`)
        terminalize()
        return
      }
      if (isBlocked(sessionID)) {
        queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current)
        return
      }
      const status = await serviceStatus(sessionID)
      if (!current()) return
      messages = await readMessages(sessionID, "PREFLIGHT")
      if (!current()) return
      if (messageReadFailed(messages)) {
        await defer("message read failed during preflight")
        return
      }
      candidate = targetAssistant(messages, targetID)
      if (!candidate) { terminalize(); return }
      if (isBlocked(sessionID)) { queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current); return }
      if (!candidate.info?.error) {
        if (isUnfinishedAssistant(candidate)) { await defer("assistant error not ready"); return }
        await log(`RECOVER ${sessionID}: target ${targetID} has no assistant error, skipping recovery`)
        terminalize()
        return
      }
      if (status.failed) {
        if (isAbortError(status.error)) { cancelRecovery(sessionID); return }
        const { name, message } = errorText(status.error)
        await defer(`status probe failed: ${name}: ${message}`)
        return
      }
      if (status.type !== undefined && status.type !== "idle") {
        await defer(`status is ${status.type}`)
        return
      }
      const attempt = state.attempts + 1
      if (attempt > MAX_ATTEMPTS) {
        stopScheduling = true
        await stopAtAttemptLimit(sessionID, state, reason, current)
        return
      }
      if (attempt > 1) { await sleep(backoff(attempt)); if (!current()) return }
      if (opts.delay) { await sleep(TERMINAL_DELAY_MS); if (!current()) return }
      messages = await readMessages(sessionID, "RECOVER")
      if (!current()) return
      if (messageReadFailed(messages)) {
        await defer("message read failed before continuation")
        return
      }
      const lastAssistant = targetAssistant(messages, targetID)
      if (!lastAssistant) { await log(`RECOVER ${sessionID}: target ${targetID} changed, skipping recovery`); terminalize(); return }
      if (!lastAssistant.info?.error) { if (isUnfinishedAssistant(lastAssistant)) { await defer("assistant error not ready before continuation"); return }; await log(`RECOVER ${sessionID}: target ${targetID} changed, skipping recovery`); terminalize(); return }
      if (!current() || isBlocked(sessionID)) { if (current()) queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current); return }
      const partial = partialText(lastAssistant)
      const hasModel = Boolean(lastAssistant.info?.providerID && lastAssistant.info.modelID)
      const model = hasModel ? { providerID: lastAssistant.info!.providerID!, modelID: lastAssistant.info!.modelID! } : undefined
      const lastUser = [...messages].reverse().find((m) => m.info?.role === "user")
      if (!lastUser?.info?.id) { await log(`RECOVER ${sessionID}: no user message, aborting recovery`); terminalize(); return }
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
      if (!isRecoverable(lastAssistant.info.error)) { await log(`RECOVER ${sessionID}: target ${targetID} became non-recoverable, skipping continuation`); terminalize(); return }
      if (!current()) return
      state.lastRecoveredMessageID = targetID
      state.lastRecoveredRequestSequence = requestSequence
      state.attempts = attempt; state.preflightAttempts = 0
      const promptMessageID = `msg_${crypto.randomUUID()}`; state.activeRecoveryPromptMessageID = promptMessageID; state.recoveryPromptMessageIDs.add(promptMessageID); state.recoveryPromptRequestSequences.set(promptMessageID, requestSequence)
      notify.onRecoveryStart(sessionID, attempt, MAX_ATTEMPTS)
      const promptResult = await client.session
        .prompt({
          path: { id: sessionID },
          body: {
            messageID: promptMessageID,
            model,
            agent: typeof lastUser.info.agent === "string" ? lastUser.info.agent : undefined,
            parts,
          },
        })
        .then((response) => ({ response }))
        .catch((error: unknown) => ({ error }))
      if (!current()) return
      const promptError = "error" in promptResult ? promptResult.error : promptResult.response?.error
      if ("error" in promptResult || !promptResult.response || (promptResult.response.error !== undefined && promptResult.response.error !== null)) {
        if (isAbortError(promptError)) { cancelRecovery(sessionID); return }
        const { name, message } = errorText(promptError)
        await log(`RECOVER ${sessionID}: continuation prompt failed: ${name}: ${message}`)
        if (!current()) return
        if (state.lastRecoveredMessageID === targetID && state.lastRecoveredRequestSequence === requestSequence) { state.lastRecoveredMessageID = undefined; state.lastRecoveredRequestSequence = undefined; state.activeRecoveryPromptMessageID = undefined }
        if (isRecoverable(promptError)) {
          queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current)
          await sleep(backoff(attempt))
        } else terminalize()
        if (!current()) return
        return
      }
      if (!state.recoveryCancelled && state.lastRecoveredRequestSequence === undefined) { state.recoveryPromptMessageIDs.clear(); state.recoveryPromptRequestSequences.clear() }
      await log(`RECOVER ${sessionID}: continuation prompt sent (attempt ${attempt})`)
    } catch (err) {
      await log(`RECOVER ${sessionID} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      state.recovering = false
      if (stopScheduling) discardPendingRecovery(state, pendingAtStart)
      drainPendingRecovery(sessionID, state)
    }
  }
  function drainPendingRecovery(sessionID: string, state: SessionState): void {
    const pending = state.pendingRecovery
    if (!pending || state.recovering || state.gaveUp || isBlocked(sessionID)) return
    if (pending.requestSequence !== undefined && pending.requestSequence < state.recoveryRequestSequence) { discardPendingRecovery(state, pending); return }
    if (state.lastRecoveredMessageID && (state.lastRecoveredRequestSequence === undefined || pending.requestSequence === undefined || pending.requestSequence <= state.lastRecoveredRequestSequence)) return
    if (!recoveryBarrierAllows(state.recoveryCancelled)) { discardPendingRecovery(state, pending); return }
    discardPendingRecovery(state, pending)
    void recover(sessionID, pending.reason, pending)
  }
  function drainDeferredRecoveries(): void {
    for (const [sessionID, state] of states) drainPendingRecovery(sessionID, state)
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
    const state = getState(sessionID); const generation = state.recoveryGeneration
    if (!isRecoverable(error)) { state.recoveryRequestSequence++; const { name, message } = errorText(error); if (message || name) void log(`NOT-RECOVERABLE ${sessionID}: ${name}: ${message}`); return }
    if (!recoveryBarrierAllows(state.recoveryCancelled) || !burstGate(state, error)) return
    const requestSequence = ++state.recoveryRequestSequence
    const current = () => recoveryRequestIsCurrent(state, generation, requestSequence)
    const { name, message } = errorText(error)
    const schedule = (opts: RecoveryOptions) => {
      if (!current() || !recoveryBarrierAllows(state.recoveryCancelled)) return
      if (startsRecoveryChain(state)) state.preflightAttempts = 0
      void recover(sessionID, message || name, { ...opts, requestSequence })
    }
    let targetID = targetMessageID
    if (!targetID) {
      const messages = await readMessages(sessionID, "ERROR")
      if (!current()) return
      if (messageReadFailed(messages)) { if (!recoveryBarrierAllows(state.recoveryCancelled)) return; schedule({ delay: true }); return }
      const last = messages[messages.length - 1]
      if (last?.info?.role !== "assistant" || !last.info.error || !last.info.id) { await log(`ERROR ${sessionID}: no failed assistant message in message list`); schedule({ delay: true }); return }; targetID = last.info.id
    }
    if (!current() || !recoveryBarrierAllows(state.recoveryCancelled)) return
    schedule({ delay: true, targetMessageID: targetID })
  }
  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      try {
        const p = (event.properties ?? {}) as Record<string, any>
        const eventID = (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") && typeof p.info?.id === "string" ? p.info.id : typeof p.sessionID === "string" ? p.sessionID : typeof p.data?.sessionID === "string" ? p.data.sessionID : typeof p.info?.sessionID === "string" ? p.info.sessionID : typeof p.part?.sessionID === "string" ? p.part.sessionID : undefined
        if (event.type !== "session.created" && event.type !== "session.deleted" && typeof eventID === "string" && deletedSessions.has(eventID)) return
        const track = trackAction(event.type, event.properties)
        if (track.action === "track" && track.sessionID) {
          if (isBlocked(track.sessionID)) paused.add(track.sessionID)
          else drainDeferredRecoveries()
        } else if (track.action === "pause" && track.sessionID) {
          addPending(track.sessionID, track.requestID)
        } else if (track.action === "resume" && track.sessionID) {
          removePending(track.sessionID, track.requestID)
        } else if (track.action === "clear" && track.sessionID) {
          if (event.type !== "session.deleted") { refreshPauseState(); drainDeferredRecoveries() }
          if (event.type === "session.error") {
            const props = event.properties as { error?: unknown }
            if (props.error === undefined || isAbortError(props.error)) cancelRecovery(track.sessionID)
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
            if (typeof props.sessionID === "string" && !isAbortError(props.error)) void handleTerminalError(props.sessionID, props.error)
            return
          }
          case "message.updated": {
            const info = (event.properties as { info?: MessageLike["info"] }).info
            if (!info?.sessionID) return
            const state = getState(info.sessionID)
            if (info.role === "user") { if (isGenuineRecoveryUserMessage(state.recoveryPromptMessageIDs, info.id)) { state.recoveryPromptMessageIDs.clear(); state.recoveryPromptRequestSequences.clear(); state.activeRecoveryPromptMessageID = undefined; state.recoveryCancelled = false; drainDeferredRecoveries() }; return }
            if (info.role !== "assistant") return
            if (info.error) {
              if (isAbortError(info.error)) { cancelRecovery(info.sessionID); return }
              if (!recoveryBarrierAllows(state.recoveryCancelled) || (info.id && info.id === state.lastRecoveredMessageID && state.lastRecoveredRequestSequence === state.recoveryRequestSequence)) return
              void handleTerminalError(info.sessionID, info.error, info.id)
            } else if (info.finish && info.finish !== "tool-calls" && info.finish !== "unknown") {
              if (info.id && info.id === state.lastRecoveredMessageID) return
              const continuation = info.parentID === state.activeRecoveryPromptMessageID && isSuccessfulRecoveryContinuation(state.recoveryPromptMessageIDs, state.recoveryPromptRequestSequences, info.parentID, state.recoveryRequestSequence)
              if (continuation && (state.attempts > 0 || state.gaveUp)) {
                resetRecoveryAfterSuccess(state, state.recovering)
                await log(`SUCCESS ${info.sessionID}: recovery chain completed, attempts reset`)
                drainDeferredRecoveries()
              }
            }
            return
          }
          case "session.deleted": {
            const info = (event.properties as { info?: { id?: string } }).info
            if (info?.id) {
              deletedSessions.add(info.id)
              cancelRecovery(info.id)
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
      notify.dispose()
    },
  }
}
export default plugin
