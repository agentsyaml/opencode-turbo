import type { Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import { appendFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  RE_FETCH_WAIT_MS,
  REVERT_WAIT_MS,
  SETTLE_MS,
  TERMINAL_DELAY_MS,
  TRIGGER_DEDUPE_MS,
  buildContinuation,
  createState,
  emptyOutputAssistant,
  failedAssistant,
  partialText,
  sleep,
  toPromptPart,
  type MessageLike,
  type PromptPart,
  type SessionState,
} from "./core"
import { errorText, isRecoverable } from "./matcher"
import { createNotifications } from "./notify"
import { isEmptyOutput, stallCandidates, trackAction } from "./stall"

// ─────────────────────────────────────────────────────────────────────────────
// opencode-turbo
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

// ── Logging ────────────────────────────────────────────────────────────────
// File-based only: console output leaks into the TUI as raw terminal noise.

const logPath = join(homedir(), ".local", "share", "opencode", "logs", "auto-recover.log")

// Stall watchdog: a silent stream (TCP alive, SSE silent) never errors, so it
// never reaches the recovery paths above. Event silence while generating is
// the hang signal. Default 30min; override via plugin options stallTimeoutMs.
const STALL_TIMEOUT_MS = 30 * 60_000
const STALL_CHECK_MS = 30_000 // watchdog scan interval

async function log(message: string): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
    // logging must never break the plugin
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: Plugin = async ({ client }: PluginInput, options: PluginOptions = {}): Promise<Hooks> => {
  const states = new Map<string, SessionState>()
  // Stall watchdog: sessionID -> last event timestamp. Only sessions that
  // produced generation events are watched; idle/error/deleted clear them.
  const activity = new Map<string, number>()
  const stallTimeoutMs = typeof options.stallTimeoutMs === "number" ? options.stallTimeoutMs : STALL_TIMEOUT_MS
  const notify = createNotifications(client)
  void log("PLUGIN LOADED — opencode-turbo ready (recovery + stall watchdog + notifications)")

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
  async function recover(sessionID: string, reason: string, opts: { delay?: boolean; emptyOutput?: boolean } = {}): Promise<void> {
    const state = getState(sessionID)
    if (state.recovering) {
      // Queue: a terminal failure arriving while a recovery is in flight must
      // not be silently dropped — its trigger event was already consumed by
      // burstGate. Replayed in `finally` once the in-flight recovery ends.
      state.pendingError = reason
      return
    }
    if (state.gaveUp) return

    state.recovering = true
    try {
      const attempt = state.attempts + 1
      if (attempt > MAX_ATTEMPTS) {
        state.gaveUp = true
        await log(`GIVING UP on ${sessionID} after ${MAX_ATTEMPTS} attempts (last: ${reason})`)
        return
      }
      // The attempt counter is committed only when a continuation is actually
      // sent, so aborted attempts (e.g. the failure not being visible yet) do
      // not burn the budget.
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
        const { name, message } = errorText(abortRes.error)
        await log(`RECOVER ${sessionID}: abort failed: ${name}: ${message}`)
      }
      await sleep(SETTLE_MS)

      if (attempt > 1) await sleep(backoff(attempt))
      if (opts.delay) await sleep(TERMINAL_DELAY_MS)

      // 2. Read the conversation. On an HTTP error the client resolves with
      //    {error, data: undefined} instead of rejecting — log it, don't
      //    pretend the session is empty.
      const res = await client.session.messages({ path: { id: sessionID } }).catch(async (err) => {
        await log(`RECOVER ${sessionID}: messages threw: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      })
      if (res?.error) {
        const { name, message } = errorText(res.error)
        await log(`RECOVER ${sessionID}: messages failed: ${name}: ${message}`)
        return
      }
      const messages = (res?.data ?? []) as MessageLike[]
      if (messages.length === 0) {
        await log(`RECOVER ${sessionID}: no messages, aborting recovery`)
        return
      }

      // The failure we are recovering from. The abort finalizes the failed
      // message asynchronously, so a fetch racing the finalization may miss
      // the error; re-read once before giving up.
      let lastAssistant = failedAssistant(messages)
      if (!lastAssistant && opts.emptyOutput) lastAssistant = emptyOutputAssistant(messages)
      if (!lastAssistant) {
        await sleep(RE_FETCH_WAIT_MS)
        const retry = await client.session.messages({ path: { id: sessionID } }).catch(async (err) => {
          await log(`RECOVER ${sessionID}: re-fetch threw: ${err instanceof Error ? err.message : String(err)}`)
          return undefined
        })
        if (retry?.error) {
          // A transient re-fetch failure is not a genuine unrecoverable state —
          // log it and back off WITHOUT burning an attempt.
          const { name, message } = errorText(retry.error)
          await log(`RECOVER ${sessionID}: re-fetch failed: ${name}: ${message}`)
          return
        }
        lastAssistant = failedAssistant((retry?.data ?? []) as MessageLike[])
        if (!lastAssistant && opts.emptyOutput) lastAssistant = emptyOutputAssistant((retry?.data ?? []) as MessageLike[])
      }
      if (!lastAssistant) {
        // Commit the attempt so a persistently un-recoverable failure (e.g. the
        // error never lands on the message) still trips MAX_ATTEMPTS instead of
        // looping the full recovery cycle every TRIGGER_DEDUPE_MS forever.
        state.attempts = attempt
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
        const { name, message } = errorText(revertRes?.error)
        await log(`RECOVER ${sessionID}: revert failed (${name}: ${message}), abandoning recovery`)
        return
      }
      await sleep(REVERT_WAIT_MS)

      // Commit the attempt only now: the recovery is genuinely proceeding.
      // Notify here too, so the toast fires only for recoveries that actually
      // act (not for cycles that immediately bail). Also clear the dedupe key
      // so a fresh failure of the same signature still triggers recovery.
      state.attempts = attempt
      notify.onRecoveryStart(sessionID, attempt, MAX_ATTEMPTS)
      state.lastRecoveredMessageID = lastAssistant.info?.id
      state.lastErrorKey = undefined
      state.lastErrorTime = 0

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
        const { name, message } = errorText(promptRes.error)
        await log(`RECOVER ${sessionID}: continuation prompt failed: ${name}: ${message}`)
      } else {
        await log(`RECOVER ${sessionID}: continuation prompt sent (attempt ${attempt})`)
      }
    } catch (err) {
      await log(`RECOVER ${sessionID} failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      state.recovering = false
      const pending = state.pendingError
      if (pending) {
        state.pendingError = undefined
        void recover(sessionID, pending)
      }
    }
  }

  /**
   * Deduplicate trigger events for one failure. The same failure surfaces as
   * session.error AND message.updated, and the message finalization can delay
   * the second event past the abort window. Key on the error signature with a
   * generous window; the key is cleared once a continuation is actually sent,
   * so a fresh failure of the same kind still triggers.
   */
  function burstGate(state: SessionState, error: unknown): boolean {
    const { name, message } = errorText(error)
    const key = `${name}:${message}`
    const now = Date.now()
    if (state.lastErrorKey === key && now - state.lastErrorTime < TRIGGER_DEDUPE_MS) return false
    state.lastErrorKey = key
    state.lastErrorTime = now
    return true
  }

  const handleTerminalError = (sessionID: string, error: unknown) => {
    if (!isRecoverable(error)) {
      // Log so permanently-ignored failures stay diagnosable (they would
      // otherwise be invisible — the plugin only acts on recoverable ones).
      const { name, message } = errorText(error)
      if (message || name) void log(`NOT-RECOVERABLE ${sessionID}: ${name}: ${message}`)
      return
    }
    const state = getState(sessionID)
    if (!burstGate(state, error)) return
    const { name, message } = errorText(error)
    void recover(sessionID, message || name, { delay: true })
  }

  /**
   * Terminal-finish settlement. Reads the finished message from the store:
   * empty output (thinking with nothing to show) is a silent model-side
   * failure and goes through recovery WITHOUT resetting the chain; real
   * output resets the chain as success. Deduped per message id by the caller.
   */
  async function settleFinished(sessionID: string, messageID: string): Promise<void> {
    await sleep(TERMINAL_DELAY_MS) // let the message finalize before reading
    const res = await client.session.messages({ path: { id: sessionID } }).catch(async (err) => {
      await log(`SETTLE ${sessionID}: messages threw: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    })
    if (res?.error) {
      const { name, message } = errorText(res.error)
      await log(`SETTLE ${sessionID}: messages failed: ${name}: ${message}`)
      return
    }
    const messages = (res?.data ?? []) as MessageLike[]
    const finished = messages.find((m) => m.info?.id === messageID)
    if (finished && isEmptyOutput(finished)) {
      const state = getState(sessionID)
      if (state.recovering) return // recovery in flight; its own event will settle
      void recover(sessionID, `EMPTY_OUTPUT: ${messageID} finished with no output`, { delay: true, emptyOutput: true })
      return
    }
    // Real output (or message not found — nothing to verify): success path.
    const state = getState(sessionID)
    if ((state.attempts > 0 || state.gaveUp) && !state.recovering) {
      state.attempts = 0
      state.gaveUp = false
      state.lastRecoveredMessageID = undefined
      state.lastErrorKey = undefined
      state.lastErrorTime = 0
      await log(`SUCCESS ${sessionID}: recovery chain completed, attempts reset`)
    }
  }

  // Stall watchdog: scan the activity map; any watched session that went
  // silent past the timeout is presumed hung and recovered like a failure.
  // The recovery aborts the hung stream, which finalizes the message (error
  // "Aborted" lands on it), so the normal recover() path picks it up as the
  // interrupted assistant message and re-sends the continuation.
  const stallTimer = stallTimeoutMs > 0
    ? setInterval(() => {
        const now = Date.now()
        for (const id of stallCandidates(activity, now, stallTimeoutMs)) {
          const state = getState(id)
          if (state.gaveUp) {
            activity.delete(id)
            continue
          }
          const quietFor = Math.round((now - (activity.get(id) ?? now)) / 60_000)
          // Re-arm BEFORE recovering: recovery itself may take a while, and the
          // resumed generation resets the timestamp via new events anyway.
          activity.set(id, now)
          void recover(id, `STALL_TIMEOUT: no events for ~${quietFor}min`)
        }
      }, STALL_CHECK_MS)
    : undefined
  stallTimer?.unref?.()

  return {
    event: async ({ event }: { event: Event }): Promise<void> => {
      try {
        // Stall watchdog bookkeeping first: any generation-progress event is
        // liveness proof; terminal events stop the watch. Independent of the
        // recovery switch below.
        const track = trackAction(event.type, event.properties)
        if (track.action === "track" && track.sessionID) {
          activity.set(track.sessionID, Date.now())
        } else if (track.action === "clear" && track.sessionID) {
          activity.delete(track.sessionID)
        }

        switch (event.type) {
          // session.status retry events are never acted on — opencode's own
          // (unbounded, exponential-backoff) retry loop is left untouched.
          // They are only surfaced as a notification toast.
          case "session.status": {
            const props = event.properties as { sessionID: string; status: { type: string; attempt?: number; message?: string } }
            if (props.status?.type === "retry" && typeof props.sessionID === "string") {
              notify.onSessionStatusRetry(props.sessionID, props.status.attempt ?? 0, props.status.message ?? "")
            }
            return
          }

          case "session.error": {
            const props = event.properties as { sessionID?: string; error?: unknown }
            if (typeof props.sessionID === "string") handleTerminalError(props.sessionID, props.error)
            return
          }

          case "message.updated": {
            const info = (event.properties as { info?: MessageLike["info"] }).info
            if (!info?.sessionID || info.role !== "assistant") return
            if (info.error) {
              // The original failure's delayed message.updated error can arrive
              // after the recovery finished — never re-recover the message we
              // just recovered FROM.
              const state = getState(info.sessionID)
              if (info.id && info.id === state.lastRecoveredMessageID) return
              handleTerminalError(info.sessionID, info.error)
            } else if (info.finish && info.finish !== "tool-calls" && info.finish !== "unknown") {
              // Terminal finish. Two mutually exclusive outcomes, decided
              // asynchronously by reading the message store (the event carries
              // no parts):
              //   - empty output (thinking with nothing to show — repetition
              //     loops, truncation): a silent model-side failure. Recover
              //     WITHOUT resetting the chain — it is a failure, not success.
              //   - real output: successful completion; reset the attempt
              //     counter so a later failure starts a fresh chain.
              // NOTE: neither `finish` alone nor `time.completed` proves a
              // turn ended — multi-step turns set BOTH per segment mid-turn
              // (finish:"tool-calls", completed stamped by cleanup). Only a
              // TERMINAL finish reason (anything but "tool-calls"/"unknown")
              // proves the message truly ended. Never reset while a recovery
              // is in flight, and never reset on the message we just recovered
              // FROM — its late completion event must not count as chain
              // success.
              const state = getState(info.sessionID)
              if (info.id && info.id === state.lastRecoveredMessageID) return
              if (info.id && info.id === state.lastEmptyCheckMessageID) return
              if (info.id) {
                state.lastEmptyCheckMessageID = info.id
                void settleFinished(info.sessionID, info.id)
              } else if ((state.attempts > 0 || state.gaveUp) && !state.recovering) {
                // No message id to verify against: fall back to the old
                // success-only reset path (cannot tell empty from full).
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
            if (info?.id) states.delete(info.id)
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
