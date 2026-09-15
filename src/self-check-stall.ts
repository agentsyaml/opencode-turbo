// Stall-watchdog and empty-output self-checks for opencode-turbo.
// Run with: bun run src/self-check-stall.ts

import type { PluginInput } from "@opencode-ai/plugin"
import { EMPTY_CONTINUATION, PREFLIGHT_GIVE_UP_MS, createState, targetAssistant, type MessageLike, type SessionState } from "./core.ts"
import { createRecovery } from "./recovery.ts"
import { createStallWatch, idleAction, isEmptyOutput, lastPartIsRunningTool, partActivity, stallCandidates, stallEligible, trackAction } from "./stall.ts"

function expect(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label} (expected ${expected}, got ${actual})`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

// ── Event classification (trackAction, pause/resume) ─────────────────────────

// Generation-progress events prove liveness, tracked per session.
{
  const t = trackAction("message.part.updated", { part: { sessionID: "s1" } })
  if (t.action !== "track" || t.sessionID !== "s1") { console.error("FAIL: trackAction part.updated"); process.exit(1) }
}
{
  const t = trackAction("message.updated", { info: { sessionID: "s2", role: "assistant" } })
  if (t.action !== "track" || t.sessionID !== "s2") { console.error("FAIL: trackAction message.updated"); process.exit(1) }
}
if (trackAction("message.updated", { info: { sessionID: "s2", role: "assistant", finish: "stop" } }).action !== "clear") { console.error("FAIL: terminal message.updated finish"); process.exit(1) }
if (trackAction("message.updated", { info: { sessionID: "s2", role: "assistant", error: {} } }).action !== "clear") { console.error("FAIL: terminal message.updated error"); process.exit(1) }
{
  const t = trackAction("session.status", { sessionID: "s3", status: { type: "busy" } })
  if (t.action !== "track" || t.sessionID !== "s3") { console.error("FAIL: trackAction session.status"); process.exit(1) }
}
for (const status of ["idle", "retry"]) {
  const t = trackAction("session.status", { sessionID: "s3", status: { type: status } })
  if (t.action !== "clear" || t.sessionID !== "s3") { console.error(`FAIL: trackAction session.status ${status}`); process.exit(1) }
}
for (const type of ["permission.updated", "permission.asked", "permission.v2.asked", "question.asked", "question.v2.asked"]) {
  const t = trackAction(type, { sessionID: "s7", id: "r1" })
  if (t.action !== "pause" || t.sessionID !== "s7" || t.requestID !== "r1") { console.error(`FAIL: trackAction ${type} pause`); process.exit(1) }
}
for (const type of ["permission.replied", "permission.v2.replied", "question.replied", "question.v2.replied", "question.rejected", "question.v2.rejected"]) {
  const key = type.startsWith("permission.replied") ? "permissionID" : "requestID"
  const t = trackAction(type, { sessionID: "s7", [key]: "r1" })
  if (t.action !== "resume" || t.sessionID !== "s7" || t.requestID !== "r1") { console.error(`FAIL: trackAction ${type} resume`); process.exit(1) }
}
if ("requestID" in trackAction("question.asked", { sessionID: "s9" })) { console.error("FAIL: missing request ID pause must be session-wide"); process.exit(1) }
if ("requestID" in trackAction("question.rejected", { sessionID: "s9" })) { console.error("FAIL: missing request ID resume must be session-wide"); process.exit(1) }
if (idleAction("s8", true).action !== "pause") { console.error("FAIL: idle with pending request stays paused"); process.exit(1) }
if (idleAction("s8", false).action !== "clear") { console.error("FAIL: idle without pending request clears"); process.exit(1) }
{
  const t = trackAction("session.idle", { sessionID: "s4" })
  if (t.action !== "clear" || t.sessionID !== "s4") { console.error("FAIL: trackAction session.idle"); process.exit(1) }
}
{
  const t = trackAction("session.error", { sessionID: "s5" })
  if (t.action !== "clear" || t.sessionID !== "s5") { console.error("FAIL: trackAction session.error"); process.exit(1) }
}
{
  const t = trackAction("session.deleted", { info: { id: "s6" } })
  if (t.action !== "clear" || t.sessionID !== "s6") { console.error("FAIL: trackAction session.deleted"); process.exit(1) }
}
if (trackAction("message.part.removed", {}).action !== "ignore") { console.error("FAIL: trackAction part.removed ignored"); process.exit(1) }
if (trackAction("unknown.event", {}).action !== "ignore") { console.error("FAIL: trackAction unknown ignored"); process.exit(1) }
if (trackAction("session.status", {}).action !== "ignore") { console.error("FAIL: trackAction missing sessionID"); process.exit(1) }

// stallCandidates remains a pure helper for a raw activity map.
const activity = new Map([["s1", 1_000_000], ["s2", 2_000_000], ["s3", 1_500_000]])
if (JSON.stringify(stallCandidates(activity, 2_100_000, 600_000)) !== '["s1"]') { console.error("FAIL: stallCandidates basic"); process.exit(1) }
if (stallCandidates(new Map(), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates empty"); process.exit(1) }
// Exact boundary: now - last === timeout does NOT qualify (strictly greater).
if (stallCandidates(new Map([["s1", 1_500_000]]), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates boundary"); process.exit(1) }

console.log("ok: stall helpers (trackAction, stallCandidates)")

// ── Part activity classification ────────────────────────────────────────────

expect(partActivity({ type: "text" }) === "stream", true, "text part is stream liveness")
expect(partActivity({ type: "reasoning" }) === "stream", true, "reasoning part is stream liveness")
expect(partActivity({ type: "tool", state: { status: "completed" } }) === "progress", true, "completed tool is progress")
expect(partActivity({ type: "tool", state: { status: "error" } }) === "progress", true, "errored tool is progress")
expect(partActivity({ type: "tool", state: { status: "running" } }) === "tool-wait", true, "running tool is tool-wait")
expect(partActivity({ type: "tool", state: { status: "pending" } }) === "tool-wait", true, "pending tool is tool-wait")
expect(partActivity({ type: "step-start" }) === "ignore", true, "structural part is ignored")
expect(lastPartIsRunningTool([{ type: "text" }, { type: "tool", state: { status: "running" } }]), true, "last running tool is detected")
expect(lastPartIsRunningTool([{ type: "tool", state: { status: "running" } }, { type: "text" }]), false, "trailing text means no tool wait")
expect(lastPartIsRunningTool([]), false, "empty parts are not a tool wait")

// ── stallEligible (pure safety gate) ────────────────────────────────────────

const quiet = {
  now: 1_000_000,
  lastStreamActivity: 1_000_000 - 1_800_000 - 1,
  timeoutMs: 1_800_000,
  lastPartIsRunningTool: false,
  blocked: false,
  recovering: false,
  pendingRecovery: false,
  gaveUp: false,
  recoveryCancelled: false,
  deleted: false,
  known: true,
}
expect(stallEligible(quiet), true, "quiet stream with no blockers is eligible")
expect(stallEligible({ ...quiet, lastPartIsRunningTool: true }), false, "running tool is never a stall")
expect(stallEligible({ ...quiet, blocked: true }), false, "blocked session is not eligible")
expect(stallEligible({ ...quiet, pendingRecovery: true }), false, "queued recovery is not eligible")
expect(stallEligible({ ...quiet, recovering: true }), false, "in-flight recovery is not eligible")
expect(stallEligible({ ...quiet, gaveUp: true }), false, "gaveUp session is not eligible")
expect(stallEligible({ ...quiet, recoveryCancelled: true }), false, "abort-barrier session is not eligible")
expect(stallEligible({ ...quiet, deleted: true }), false, "deleted session is not eligible")
expect(stallEligible({ ...quiet, known: false }), false, "unknown session is not eligible")
expect(stallEligible({ ...quiet, lastRecoveredMessageID: "m1", stalledMessageID: "m1" }), false, "already-recovered target is fenced")
expect(stallEligible({ ...quiet, now: quiet.lastStreamActivity + quiet.timeoutMs }), false, "exact timeout boundary does not fire")

// ── createStallWatch (state machine) ────────────────────────────────────────

{
  let clock = 0
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => clock })
  watch.note("message.part.updated", { part: { sessionID: "w1", type: "text" } })
  clock = 101
  expect(JSON.stringify(watch.sweep(clock)) === '["w1"]', true, "sweep yields a quiet session once")
  watch.forget("w1")
  expect(watch.sweep(clock).length === 0, true, "forget stops the session from re-firing")
  expect(watch.snapshot("w1") === undefined, true, "forget clears the snapshot")
}
{
  let clock = 0
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => clock })
  watch.note("message.part.updated", { part: { sessionID: "t1", type: "tool", state: { status: "running" } } })
  clock = 10_000
  expect(watch.sweep(clock).length === 0, true, "sweep skips a running tool wait")
}
{
  let clock = 0
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 2, now: () => clock })
  for (const id of ["c1", "c2", "c3", "c4"]) watch.note("message.part.updated", { part: { sessionID: id, type: "text" } })
  clock = 1_000
  expect(watch.sweep(clock).length === 2, true, "sweep respects STALL_MAX_PER_SWEEP")
}
{
  let clock = 0
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => clock, eligible: (id) => id !== "f2" })
  watch.note("message.part.updated", { part: { sessionID: "f1", type: "text" } })
  watch.note("message.part.updated", { part: { sessionID: "f2", type: "text" } })
  clock = 1_000
  expect(JSON.stringify(watch.sweep(clock)) === '["f1"]', true, "sweep applies the eligibility callback")
  watch.dispose()
  expect(watch.sweep(clock).length === 0, true, "dispose clears watch state")
}
{
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => 10_000_000 })
  watch.note("message.part.updated", { part: { sessionID: "mono", type: "text" } })
  expect(watch.sweep(performance.now()).length === 0, true, "watch uses the monotonic clock, not wall-clock Date.now()")
}
{
  const disabled = createStallWatch({ timeoutMs: 0, checkMs: 30_000, maxPerSweep: 3, now: () => 0 })
  disabled.note("message.part.updated", { part: { sessionID: "off", type: "text" } })
  expect(disabled.enabled === false && disabled.sweep(9_999_999).length === 0, true, "timeout 0 disables the watchdog")
}

// targetAssistant: terminal messages are accepted only for empty-output turns.
const terminalMessage: MessageLike = { info: { id: "done", role: "assistant", finish: "stop" } }
expect(targetAssistant([terminalMessage], "done", true) !== undefined, true, "terminal target is accepted for empty-output recovery")
expect(targetAssistant([terminalMessage], "done") === undefined, true, "terminal target stays rejected for the error path")

console.log("ok: stall watchdog (stallEligible, createStallWatch, partActivity)")

// ── Empty-output detection helper (drives empty-output recovery) ─────────────

// Reasoning-only message: the helper identifies empty output, and the plugin
// recovers it via scheduleSilentRecovery with EMPTY_CONTINUATION.
if (!isEmptyOutput({ parts: [{ type: "reasoning", text: "thinking..." }] })) { console.error("FAIL: isEmptyOutput reasoning only"); process.exit(1) }
for (const type of ["step-start", "step-finish", "snapshot", "patch", "compaction"]) {
  if (!isEmptyOutput({ parts: [{ type: "reasoning" }, { type }] })) { console.error(`FAIL: isEmptyOutput structural ${type}`); process.exit(1) }
}
// Missing or unknown parts are unsafe to classify as empty.
if (isEmptyOutput({})) { console.error("FAIL: isEmptyOutput missing parts is unknown"); process.exit(1) }
if (isEmptyOutput({ parts: "unknown" })) { console.error("FAIL: isEmptyOutput unknown parts"); process.exit(1) }
if (isEmptyOutput({ parts: [{ type: "future-part" }] })) { console.error("FAIL: isEmptyOutput unknown part type"); process.exit(1) }
// An explicit empty parts array is an empty response.
if (!isEmptyOutput({ parts: [] })) { console.error("FAIL: isEmptyOutput explicit empty parts"); process.exit(1) }
// Real text: not empty.
if (isEmptyOutput({ parts: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "answer" }] })) { console.error("FAIL: isEmptyOutput with text"); process.exit(1) }
// Tool call: not empty (the model is acting, not silent).
if (isEmptyOutput({ parts: [{ type: "tool" }] })) { console.error("FAIL: isEmptyOutput with tool"); process.exit(1) }
// Agent part: not empty (subagent is running / did work).
if (isEmptyOutput({ parts: [{ type: "agent" }] })) { console.error("FAIL: isEmptyOutput with agent"); process.exit(1) }
// Whitespace-only text: empty.
if (!isEmptyOutput({ parts: [{ type: "text", text: "   " }] })) { console.error("FAIL: isEmptyOutput whitespace"); process.exit(1) }
// Synthetic/ignored parts do not count as output.
if (!isEmptyOutput({ parts: [{ type: "text", text: "x", synthetic: true }] })) { console.error("FAIL: isEmptyOutput synthetic"); process.exit(1) }
// Missing parts are unknown and must not trigger recovery.
if (isEmptyOutput(undefined)) { console.error("FAIL: isEmptyOutput undefined is unknown"); process.exit(1) }

console.log("ok: empty-output detection (isEmptyOutput)")

// ── recover() composition (mock client) ─────────────────────────────────────
//
// The helpers above are pure; these cases exercise the composed production path
// so an empty-output or stall recovery actually reaches client.session.prompt,
// and so a permanent-error target is structurally refused on every path.

interface PromptCall { sessionID: string; parts: Array<{ type: string; text?: string }> }

function mockClient(
  messagesBySession: Record<string, unknown[]>,
  statusBySession: Record<string, string | undefined>,
  prompts: PromptCall[],
): PluginInput["client"] {
  return {
    session: {
      messages: async ({ path }: { path: { id: string } }) => ({ data: messagesBySession[path.id] ?? [] }),
      status: async () => ({ data: Object.fromEntries(Object.entries(statusBySession).map(([id, type]) => [id, { type }])) }),
      prompt: async ({ path, body }: { path: { id: string }; body: { parts: PromptCall["parts"] } }) => {
        prompts.push({ sessionID: path.id, parts: body.parts })
        return { data: {} }
      },
    },
  } as unknown as PluginInput["client"]
}

function makeRecovery(client: PluginInput["client"], states: Map<string, SessionState>) {
  const getState = (id: string): SessionState => { const state = states.get(id) ?? createState(); states.set(id, state); return state }
  return createRecovery({
    client,
    log: async () => {},
    notify: { onSessionStatusRetry() {}, onRecoveryStart() {}, onRecoveryStopped() {}, dispose() {} },
    getState,
    isBlocked: () => false,
    cancelRecovery: (id: string) => { getState(id).recoveryCancelled = true },
    states,
  })
}

const userMsg = (sessionID: string, id: string, text: string) => ({ info: { id, sessionID, role: "user" }, parts: [{ type: "text", text }] })
const emptyAssistant = (sessionID: string, id: string) => ({ info: { id, sessionID, role: "assistant", finish: "stop", providerID: "p", modelID: "m" }, parts: [{ type: "reasoning", text: "thinking" }] })
function errorAssistant(sessionID: string, id: string, error: unknown) {
  return { info: { id, sessionID, role: "assistant", error }, parts: [] as Array<{ type: string }> }
}

{
  const states = new Map<string, SessionState>()
  const prompts: PromptCall[] = []
  const client = mockClient({ ses: [userMsg("ses", "u1", "hi"), emptyAssistant("ses", "a1")] }, { ses: "idle" }, prompts)
  await makeRecovery(client, states).recover("ses", "EMPTY_OUTPUT test", { targetMessageID: "a1", emptyOutput: true })
  expect(prompts.length === 1, true, "empty-output recovery sends exactly one prompt")
  expect(prompts[0]?.parts?.[0]?.text === EMPTY_CONTINUATION, true, "empty-output continuation uses EMPTY_CONTINUATION")
}
{
  const states = new Map<string, SessionState>()
  const prompts: PromptCall[] = []
  const state = createState(); state.preflightAttempts = 1; state.preflightStartedAt = Date.now() - PREFLIGHT_GIVE_UP_MS - 1; states.set("ses", state)
  const client = mockClient({ ses: [userMsg("ses", "u1", "hi"), emptyAssistant("ses", "a1")] }, { ses: "busy" }, prompts)
  await makeRecovery(client, states).recover("ses", "EMPTY_OUTPUT busy", { targetMessageID: "a1", emptyOutput: true })
  expect(prompts.length === 0, true, "empty-output with busy status never injects")
  expect(state.gaveUp, true, "busy preflight ceiling gives up visibly")
}
{
  const states = new Map<string, SessionState>()
  const prompts: PromptCall[] = []
  const state = createState(); state.recoveryCancelled = true; states.set("ses", state)
  const client = mockClient({ ses: [userMsg("ses", "u1", "hi"), emptyAssistant("ses", "a1")] }, { ses: "idle" }, prompts)
  await makeRecovery(client, states).recover("ses", "EMPTY_OUTPUT cancelled", { targetMessageID: "a1", emptyOutput: true })
  expect(prompts.length === 0, true, "abort barrier prevents empty-output injection")
}
{
  const states = new Map<string, SessionState>()
  const prompts: PromptCall[] = []
  const client = mockClient({ ses2: [userMsg("ses2", "u2", "hi"), errorAssistant("ses2", "a2", { name: "APIError", message: "Unauthorized", data: { statusCode: 401 } })] }, { ses2: "idle" }, prompts)
  await makeRecovery(client, states).recover("ses2", "STALL_TIMEOUT test", { targetMessageID: "a2", stall: true })
  expect(prompts.length === 0, true, "stall path refuses a permanent-error target")
}
{
  const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => 0 })
  watch.note("message.part.updated", { part: { sessionID: "sx", type: "text" } })
  watch.note("message.updated", { info: { sessionID: "sx", role: "assistant", finish: "stop" } })
  expect(watch.snapshot("sx") === undefined, true, "terminal message.updated clears the armed entry")
}

console.log("ok: recover composition (empty-output, stall, abort barrier)")

console.log("all checks passed")
