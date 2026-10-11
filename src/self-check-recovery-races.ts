// Controlled-promise regressions for recovery ownership and readiness races.
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EMPTY_CONTINUATION, createState, type MessageLike, type SessionState } from "./core.ts"
import { createRecovery } from "./recovery.ts"

function check(value: boolean, label: string): void {
  if (!value) throw new Error(`FAIL recovery race: ${label}`)
}
function hold<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const user = (id: string): MessageLike => ({ info: { id, role: "user" }, parts: [{ type: "text", text: id }] })
const failed = (id: string): MessageLike => ({ info: { id, role: "assistant", error: { name: "APIError", data: { message: "provider failure", statusCode: 503 } }, providerID: "p", modelID: "m" }, parts: [] })
const empty = (id: string): MessageLike => ({ info: { id, role: "assistant", finish: "stop", providerID: "p", modelID: "m" }, parts: [] })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(options: {
  messages?: () => Promise<unknown> | unknown
  status?: (signal?: AbortSignal) => Promise<unknown> | unknown
  log?: (line: string) => Promise<void>
  blocked?: () => boolean
  probeTimeoutMs?: number
  wait?: (ms: number) => Promise<unknown>
  cancel?: (id: string) => void
} = {}) {
  const states = new Map<string, SessionState>()
  const prompts: Array<{ parts: Array<{ type: string; text?: string }> }> = []
  const getState = (id: string) => { let state = states.get(id); if (!state) { state = createState(); states.set(id, state) }; return state }
  const client = { session: {
    messages: async () => options.messages ? options.messages() : ({ data: [user("u"), failed("a")] }),
    status: async ({ signal }: { signal?: AbortSignal } = {}) => options.status ? options.status(signal) : ({ data: { s: { type: "idle" } } }),
    prompt: async ({ body }: { body: { parts: Array<{ type: string; text?: string }> } }) => { prompts.push(body); return { data: {} } },
  } } as unknown as PluginInput["client"]
  const recovery = createRecovery({ client, log: options.log ?? (async () => {}), notify: { onSessionStatusRetry() {}, onRecoveryStart() {}, onRecoveryStopped() {}, dispose() {} }, getState, isBlocked: options.blocked ?? (() => false), cancelRecovery: options.cancel ?? ((id) => { const state = getState(id); state.recoveryCancelled = true; state.recoveryGeneration++ }), states, probeTimeoutMs: options.probeTimeoutMs, sleep: options.wait })
  return { recovery, states, getState, prompts }
}

// No awaited final log may invalidate ownership and still leak a prompt.
for (const invalidate of [
  (state: SessionState) => { state.recoveryCancelled = true; state.recoveryGeneration++ },
  (state: SessionState) => { state.recoveryRequestSequence++ },
]) {
  const gate = hold<void>()
  const entered = hold<void>()
  let once = false
  const h = harness({ log: async (line) => { if (!once && line.startsWith("STALL_RECOVER")) { once = true; entered.resolve(); await gate.promise } } })
  const pending = h.recovery.recover("s", "stall", { stall: true, targetMessageID: "a" })
  await entered.promise; invalidate(h.getState("s")); gate.resolve(); await pending
  check(h.prompts.length === 0, "cancellation or newer sequence during final log suppresses prompt")
}
{
  const gate = hold<void>(); const entered = hold<void>(); let once = false; let blocked = false
  const h = harness({ blocked: () => blocked, log: async (line) => { if (!once && line.startsWith("STALL_RECOVER")) { once = true; entered.resolve(); await gate.promise } } })
  const pending = h.recovery.recover("s", "stall", { stall: true, targetMessageID: "a" })
  await entered.promise; blocked = true; gate.resolve(); await pending
  check(h.prompts.length === 0 && h.getState("s").pendingRecovery?.targetMessageID === "a", "permission arriving during final log queues pinned target")
}
{
  const gate = hold<void>(); const entered = hold<void>(); let once = false
  const h = harness({ log: async (line) => { if (!once && line.startsWith("STALL_RECOVER")) { once = true; entered.resolve(); await gate.promise } } })
  const pending = h.recovery.recover("s", "stall", { stall: true, targetMessageID: "a" })
  await entered.promise
  await h.recovery.handleTerminalError("s", { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } })
  gate.resolve(); await pending
  check(h.prompts.length === 0, "permanent API 401 during final log advances sequence and suppresses prompt")
}

// The second status probe sees a transition during backoff/delay.
{
  let statusCalls = 0
  let waits = 0
  const gate = hold<unknown>()
  const h = harness({ status: () => ({ data: { s: { type: ++statusCalls === 1 ? "idle" : "busy" } } }), wait: () => ++waits === 1 ? Promise.resolve() : gate.promise })
  const work = h.recovery.recover("s", "delayed error", { delay: true, targetMessageID: "a" })
  await tick(); h.getState("s").recoveryRequestSequence++; gate.resolve(undefined); await work
  check(h.prompts.length === 0 && statusCalls === 2, "busy status after delay prevents injection")
}
// A terminal stale-target exit is not a readiness episode. A later direct
// watchdog recovery starts with a fresh budget even when wall time advanced.
{
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    let reads = 0
    const h = harness({
      messages: () => {
        if (++reads <= 2) return { data: [user("u"), failed("a")] }
        return new Promise((resolve) => setTimeout(() => resolve({ data: [user("u"), failed("a")] }), 10))
      },
      probeTimeoutMs: 1_000,
      wait: async () => {},
    })
    const state = h.getState("s")
    await h.recovery.recover("s", "stale target", { targetMessageID: "gone" })
    check(!state.recovering && h.prompts.length === 0, "stale target exits without a continuation")
    now += 11 * 60_000
    await h.recovery.recover("s", "independent stall", { stall: true })
    check(h.prompts.length === 1 && !state.gaveUp && state.attempts === 1, "new watchdog episode resets stale budget and accepts healthy delayed reads")
  } finally {
    Date.now = realNow
  }
}
// A queued retry is the same readiness episode and still expires at its original deadline.
{
  const realNow = Date.now
  let now = 2_000_000
  Date.now = () => now
  try {
    const gate = hold<unknown>(); const entered = hold<void>(); let waits = 0
    const h = harness({ status: () => ({ data: { s: { type: "busy" } } }), wait: () => { if (++waits === 1) { entered.resolve(); return gate.promise }; return Promise.resolve() } })
    const state = h.getState("s")
    const work = h.recovery.recover("s", "queued readiness", { targetMessageID: "a" })
    await entered.promise
    const started = state.preflightStartedAt
    check(started === now && state.pendingRecovery?.targetMessageID === "a", "first deferral establishes queued episode budget")
    now += 10 * 60_000
    gate.resolve(undefined); await work
    for (let i = 0; i < 20 && !state.gaveUp; i++) await tick()
    check(state.gaveUp && state.preflightStartedAt === started && h.prompts.length === 0, "queued retry preserves and expires original ten-minute budget")
  } finally {
    Date.now = realNow
  }
}
{
  const statuses: Array<unknown> = [
    { data: { s: { type: "idle" } } },
    new DOMException("Aborted", "AbortError"),
    { data: { s: { type: "idle" } } },
    { data: { s: { type: "idle" } } },
  ]
  let cancelCalls = 0
  const h = harness({ status: () => { const next = statuses.shift(); if (next instanceof Error) throw next; return next }, wait: async () => {}, cancel: (id) => { cancelCalls++; const state = h.getState(id); state.recoveryCancelled = true; state.recoveryGeneration++ } })
  const state = h.getState("s")
  await h.recovery.recover("s", "final abort", { targetMessageID: "a" })
  check(h.prompts.length === 0 && cancelCalls === 1 && state.recoveryCancelled, "AbortError from refreshed final status cancels before retry")
}
{
  let messages: MessageLike[] = [user("u1"), failed("a")]
  let type = "busy"
  const gate = hold<unknown>()
  const h = harness({ messages: () => ({ data: messages }), status: () => ({ data: { s: { type } } }), wait: () => gate.promise })
  const work = h.recovery.recover("s", "stall", { stall: true })
  await tick()
  const sequence = h.getState("s").recoveryRequestSequence
  check(h.getState("s").pendingRecovery?.targetMessageID === "a", "targetless busy stall deferral pins current target")
  messages = [user("u1"), failed("a"), user("u2"), failed("b")]; type = "idle"
  gate.resolve(undefined); await work; h.recovery.drainDeferredRecoveries()
  for (let i = 0; i < 20 && h.getState("s").recovering; i++) await tick()
  check(h.getState("s").recoveryRequestSequence === sequence, "drain preserves original request sequence")
  check(h.prompts.length === 0, "queued stall never adopts a newer turn")
}

// Two terminal reads reserve an empty target once; non-empty final data is terminal.
{
  const gate = hold<unknown>(); let reads = 0
  const h = harness({ messages: () => ++reads <= 2 ? gate.promise : ({ data: [user("u"), empty("a")] }), wait: async () => {} })
  const msg = { info: { id: "a", role: "assistant", finish: "stop", sessionID: "s" } }
  // Same production recovery function is invoked for both reads after event-level checks.
  const first = h.recovery.readMessages("s", "EMPTY")
  const second = h.recovery.readMessages("s", "EMPTY")
  gate.resolve({ data: [user("u"), empty("a")] }); await Promise.all([first, second])
  check(Boolean(msg.info.id), "overlapping read setup")
  await h.recovery.recover("s", "empty", { emptyOutput: true, targetMessageID: "a" })
  check(h.prompts.length === 1 && h.prompts[0]?.parts[0]?.text === EMPTY_CONTINUATION, "empty target submits empty continuation")
}
{
  const h = harness({ messages: () => ({ data: [user("u"), { ...empty("a"), parts: [{ type: "text", text: "actual answer" }] }] }), wait: async () => {} })
  await h.recovery.recover("s", "empty", { emptyOutput: true, targetMessageID: "a" })
  check(h.prompts.length === 0, "empty-output recovery rechecks final message content")
}

// Both signal-aware and signal-ignoring transports defer at the real deadline,
// rather than merely remaining in the initial recovery state.
{
  for (const signalAware of [false, true]) {
    const state = createState(); const gate = hold<unknown>()
    const status = (signal?: AbortSignal) => signalAware
      ? new Promise<never>((_, reject) => { signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }) })
      : new Promise<never>(() => {})
    const h = harness({ status, probeTimeoutMs: 5, wait: () => gate.promise })
    h.states.set("s", state)
    const work = h.recovery.recover("s", "hanging readiness", { targetMessageID: "a" })
    await new Promise((resolve) => setTimeout(resolve, 15))
    check(state.preflightAttempts > 0 && !state.recoveryCancelled && h.prompts.length === 0, `status deadline defers (signal-aware=${signalAware})`)
    gate.resolve(undefined); await work; h.recovery.dispose()
  }
}

// Disposal independently settles even a transport that ignores cancellation.
{
  const started = hold<void>(); const state = createState()
  const h = harness({ messages: () => { started.resolve(); return new Promise<never>(() => {}) }, probeTimeoutMs: 30_000 })
  h.states.set("s", state)
  const work = h.recovery.recover("s", "dispose hanging read", { targetMessageID: "a" })
  await started.promise; h.recovery.dispose()
  await Promise.race([work, new Promise((_, reject) => setTimeout(() => reject(new Error("dispose did not settle probe")), 50))])
  check(!state.recovering && h.prompts.length === 0, "disposal settles a signal-ignoring read promptly")
}

console.log("ok: recovery race regressions")

// Exercise the actual hook's read/reservation/deletion/disposal ownership.
{
  const home = await mkdtemp(join(tmpdir(), "opencode-turbo-check-"))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const { default: plugin } = await import("./index.ts")
    const gate = hold<unknown>(); let reads = 0; const prompts: unknown[] = []
    const client = { session: {
      messages: async () => ++reads <= 2 ? gate.promise : ({ data: [user("u"), empty("a")] }),
      status: async () => ({ data: { s: { type: "idle" } } }),
      prompt: async (args: unknown) => { prompts.push(args); return { data: {} } },
      get: async () => ({ data: { id: "s" } }),
    }, tui: { showToast: async () => ({}) } } as unknown as PluginInput["client"]
    const hooks = await plugin({ client } as PluginInput, { stallTimeoutMs: 0 })
    const event = { type: "message.updated", properties: { info: { id: "a", sessionID: "s", role: "assistant", finish: "stop" } } }
    const first = hooks.event!({ event } as never); const second = hooks.event!({ event } as never)
    await tick(); gate.resolve({ data: [user("u"), empty("a")] }); await Promise.all([first, second])
    for (let i = 0; i < 20 && prompts.length === 0; i++) await tick()
    check(prompts.length === 1, "overlapping terminal reads schedule one empty continuation")
    await hooks.dispose?.()

    for (const action of ["dispose"] as const) {
      const pendingRead = hold<unknown>(); const started = hold<void>(); let promptCount = 0; let pendingReads = 0
      const pendingClient = { ...client, session: { ...client.session, messages: async () => { pendingReads++; started.resolve(); return pendingRead.promise }, prompt: async () => { promptCount++; return { data: {} } } } } as unknown as PluginInput["client"]
      const pendingHooks = await plugin({ client: pendingClient } as PluginInput, { stallTimeoutMs: 0 })
      const pending = pendingHooks.event!({ event } as never)
      await started.promise
      await pendingHooks.dispose?.()
      pendingRead.resolve({ data: [user("u"), empty("a")] }); await pending
      await tick()
      check(promptCount === 0, `pending empty read after ${action} cannot prompt (got ${promptCount})`)
      await pendingHooks.event!({ event: { type: "session.error", properties: { sessionID: "after-dispose", error: { name: "APIError", data: { message: "failure", statusCode: 503 } } } } as never })
      check(promptCount === 0 && pendingReads === 1, "event after dispose does not read or start recovery work")
      await pendingHooks.dispose?.()
    }
    {
      const pendingRead = hold<unknown>(); const started = hold<void>(); let deletionReads = 0; let promptCount = 0
      const deletionClient = { ...client, session: { ...client.session, messages: async () => { deletionReads++; started.resolve(); return pendingRead.promise }, prompt: async () => { promptCount++; return { data: {} } } } } as unknown as PluginInput["client"]
      const deletionHooks = await plugin({ client: deletionClient } as PluginInput, { stallTimeoutMs: 0 })
      const pending = deletionHooks.event!({ event } as never)
      await started.promise
      await deletionHooks.event!({ event: { type: "session.deleted", properties: { info: { id: "s" } } } as never })
      pendingRead.resolve({ data: [user("u"), empty("a")] }); await pending; await tick()
      check(promptCount === 0 && deletionReads === 1, "deleted session discards suspended empty read without another read")
      await deletionHooks.dispose?.()
    }
    {
      const firstRead = hold<unknown>(); const secondRead = hold<unknown>(); const firstPrompt = hold<unknown>(); const promptStarted = hold<void>()
      let reads = 0; const promptArgs: Array<{ body: { messageID: string } }> = []; const toasts: string[] = []
      let currentMessages: MessageLike[] = [user("u1"), empty("a")]
      const raceClient = { ...client, tui: { showToast: async ({ body }: { body: { message: string } }) => { toasts.push(body.message); return {} } }, session: {
        ...client.session,
        messages: async () => { const call = ++reads; if (call === 1) return firstRead.promise; if (call === 2) return secondRead.promise; return { data: currentMessages } },
        prompt: async (args: { body: { messageID: string } }) => { promptArgs.push(args); if (promptArgs.length === 1) { promptStarted.resolve(); return firstPrompt.promise }; return { data: {} } },
      } } as unknown as PluginInput["client"]
      const raceHooks = await plugin({ client: raceClient } as PluginInput, { stallTimeoutMs: 0 })
      const emptyEvent = { type: "message.updated", properties: { info: { id: "a", sessionID: "s", role: "assistant", finish: "stop" } } }
      const one = raceHooks.event!({ event: emptyEvent as never }); const two = raceHooks.event!({ event: emptyEvent as never })
      firstRead.resolve({ data: [user("u1"), empty("a")] }); await promptStarted.promise
      secondRead.resolve({ data: [user("u1"), empty("a")] }); await two
      firstPrompt.resolve({ data: {} }); await one
      currentMessages = [user("u1"), { ...empty("b"), parts: [{ type: "text", text: "answer" }] }]
      await raceHooks.event!({ event: { type: "message.updated", properties: { info: { id: "b", sessionID: "s", role: "assistant", parentID: promptArgs[0]!.body.messageID, finish: "stop" } } } as never })
      currentMessages = [user("u2"), failed("c")]
      await raceHooks.event!({ event: { type: "session.error", properties: { sessionID: "s", error: { name: "APIError", data: { message: "independent failure", statusCode: 503 } } } } as never })
      for (let i = 0; i < 400 && promptArgs.length < 2; i++) await tick()
      await new Promise((resolve) => setTimeout(resolve, 1_550))
      check(promptArgs.length === 2 && toasts.filter((message) => message === "attempt 1/10").length === 2, "staggered stale empty snapshot does not duplicate completed recovery; later error starts at 1/10")
      await raceHooks.dispose?.()
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}
