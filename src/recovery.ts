// Recovery engine for opencode-turbo.
//
// Extracted from the plugin entry so the entry module stays within the LOC
// budget and only exports the default plugin function. All behavior here is the
// same code that previously lived inline in index.ts; the entry passes in the
// shared state maps, logging, notifications, block predicate and cancellation.

import type { PluginInput } from "@opencode-ai/plugin"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  EMPTY_CONTINUATION,
  MAX_ATTEMPTS,
  RE_FETCH_WAIT_MS,
  TERMINAL_DELAY_MS,
  TRIGGER_DEDUPE_MS,
  buildContinuation,
  candidateAssistant,
  discardPendingRecovery,
  isUnfinishedAssistant,
  messageReadFailed,
  partialText,
  preflightBackoff,
  preflightExpired,
  recoveryBarrierAllows,
  recoveryRequestIsCurrent,
  recoveryRequestIsNewer,
  samePendingRecovery,
  sleep,
  startsRecoveryChain,
  targetAssistant,
  toPromptPart,
  type MessageLike,
  type PromptPart,
  type RecoveryOptions,
  type SessionState,
} from "./core"
import { errorText, isAbortError, isRecoverable } from "./matcher"
import type { Notifications } from "./notify"

export interface RecoveryDeps {
  client: PluginInput["client"]
  log: (message: string) => Promise<void>
  notify: Notifications
  getState: (sessionID: string) => SessionState
  isBlocked: (sessionID: string) => boolean
  cancelRecovery: (sessionID: string, cause: string) => void
  states: Map<string, SessionState>
}

export function createRecovery({ client, log, notify, getState, isBlocked, cancelRecovery, states }: RecoveryDeps) {
  function backoff(attempt: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
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
    const attempt = ++state.preflightAttempts
    const now = Date.now()
    if (state.preflightStartedAt === undefined) state.preflightStartedAt = now
    else if (preflightExpired(state.preflightStartedAt, now)) {
      await log(`GIVING UP on ${sessionID} after ~10min preflight — ${detail}`)
      if (!current()) return false
      state.gaveUp = true
      notify.onRecoveryStopped(sessionID, `stopped scheduling after ~10min preflight — ${detail}`)
      return true
    }
    queuePendingIfCurrent(state, expectedPending, opts.requestSequence ?? -1, reason, opts, current)
    await sleep(preflightBackoff(attempt))
    return false
  }
  async function recover(sessionID: string, reason: string, opts: RecoveryOptions = {}): Promise<void> {
    const state = getState(sessionID)
    const generation = state.recoveryGeneration; const requestSequence = opts.requestSequence ?? ++state.recoveryRequestSequence; if (requestSequence > state.recoveryRequestSequence) state.recoveryRequestSequence = requestSequence; if (opts.requestSequence === undefined) opts = { ...opts, requestSequence }; const pendingAtStart = state.pendingRecovery; const current = () => recoveryRequestIsCurrent(state, generation, requestSequence)
    if (!current()) return
    if (state.recovering) {
      if (opts.stall) await log(`STALL_SKIP ${sessionID}: recovery in flight`)
      if (recoveryBarrierAllows(state.recoveryCancelled)) queuePendingIfCurrent(state, state.pendingRecovery, requestSequence, reason, opts, current)
      return
    }
    if (state.gaveUp || !recoveryBarrierAllows(state.recoveryCancelled)) {
      if (opts.stall) await log(`STALL_SKIP ${sessionID}: ${state.gaveUp ? "gaveUp" : "abort barrier"}`)
      return
    }
    if (isBlocked(sessionID)) {
      if (opts.stall) await log(`STALL_SKIP ${sessionID}: pending`)
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
      if (state.preflightAttempts > 0) {
        const waited = Math.round((Date.now() - (state.preflightStartedAt ?? Date.now())) / 1000)
        await log(`RECOVER ${sessionID}: preflight retry ${state.preflightAttempts} (waited ${waited}s) — ${reason}`)
      } else {
        await log(`RECOVER ${sessionID} preparing attempt ${state.attempts + 1}/${MAX_ATTEMPTS} — ${reason}`)
      }
      if (!current()) return
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
      candidate = targetAssistant(messages, targetID, opts.emptyOutput === true)
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
      candidate = targetAssistant(messages, targetID, opts.emptyOutput === true)
      if (!candidate) { terminalize(); return }
      if (isBlocked(sessionID)) { queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current); return }
      if (!candidate.info?.error && !opts.stall && !opts.emptyOutput) {
        if (isUnfinishedAssistant(candidate)) { await defer("assistant error not ready"); return }
        await log(`RECOVER ${sessionID}: target ${targetID} has no assistant error, skipping recovery`)
        terminalize()
        return
      }
      if (status.failed) {
        if (isAbortError(status.error)) { cancelRecovery(sessionID, "status probe abort"); return }
        const { name, message } = errorText(status.error)
        await defer(`status probe failed: ${name}: ${message}`)
        return
      }
      if (status.type !== undefined && status.type !== "idle") {
        if (opts.stall) await log(`STALL_SKIP ${sessionID}: status ${status.type}`)
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
      const lastAssistant = targetAssistant(messages, targetID, opts.emptyOutput === true)
      if (!lastAssistant) { await log(`RECOVER ${sessionID}: target ${targetID} changed, skipping recovery`); terminalize(); return }
      if (!lastAssistant.info?.error && !opts.stall && !opts.emptyOutput) { if (isUnfinishedAssistant(lastAssistant)) { await defer("assistant error not ready before continuation"); return }; await log(`RECOVER ${sessionID}: target ${targetID} changed, skipping recovery`); terminalize(); return }
      if (!current() || isBlocked(sessionID)) { if (current()) queuePendingIfCurrent(state, pendingAtStart, requestSequence, reason, opts, current); return }
      const partial = partialText(lastAssistant)
      const hasModel = Boolean(lastAssistant.info?.providerID && lastAssistant.info?.modelID)
      const model = hasModel ? { providerID: lastAssistant.info!.providerID!, modelID: lastAssistant.info!.modelID! } : undefined
      const lastUser = [...messages].reverse().find((m) => m.info?.role === "user")
      if (!lastUser?.info?.id) { await log(`RECOVER ${sessionID}: no user message, aborting recovery`); terminalize(); return }
      state.lastErrorKey = undefined
      state.lastErrorTime = 0
      let parts: PromptPart[]
      if (opts.emptyOutput) {
        parts = [{ type: "text", text: EMPTY_CONTINUATION }]
      } else if (partial) {
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
      // Structural guard: a target that carries an error must still pass the
      // matcher on every path. Only genuinely error-free stall/empty targets
      // may skip it.
      if (lastAssistant.info?.error && !isRecoverable(lastAssistant.info.error)) { await log(`RECOVER ${sessionID}: target ${targetID} became non-recoverable, skipping continuation`); terminalize(); return }
      if (!current()) return
      if (opts.stall && state.lastRecoveredMessageID === targetID) { await log(`RECOVER ${sessionID}: stall target ${targetID} already recovered, skipping`); terminalize(); return }
      if (opts.stall) await log(`STALL_RECOVER ${sessionID}: status idle, target ${targetID} — ${reason}`)
      if (opts.emptyOutput) await log(`EMPTY_RECOVER ${sessionID}: target ${targetID}`)
      state.lastRecoveredMessageID = targetID
      state.lastRecoveredRequestSequence = requestSequence
      state.attempts = attempt; state.preflightAttempts = 0; state.preflightStartedAt = undefined
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
        if (isAbortError(promptError)) { cancelRecovery(sessionID, "continuation prompt abort"); return }
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
      if (startsRecoveryChain(state)) { state.preflightAttempts = 0; state.preflightStartedAt = undefined }
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
  function scheduleSilentRecovery(sessionID: string, reason: string, opts: RecoveryOptions): void {
    const state = getState(sessionID)
    if (state.gaveUp || !recoveryBarrierAllows(state.recoveryCancelled)) return
    const generation = state.recoveryGeneration
    const requestSequence = ++state.recoveryRequestSequence
    const current = () => recoveryRequestIsCurrent(state, generation, requestSequence)
    if (!current()) return
    if (startsRecoveryChain(state)) { state.preflightAttempts = 0; state.preflightStartedAt = undefined }
    void recover(sessionID, reason, { ...opts, requestSequence })
  }
  return { recover, handleTerminalError, drainDeferredRecoveries, scheduleSilentRecovery, readMessages }
}
