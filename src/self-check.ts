// Self-check for opencode-turbo matching logic.
// Run with: bun run src/self-check.ts

import { isAbortError, isRecoverable } from "./matcher.ts"
import { estimateTokens, formatDuration } from "./util.ts"
import { stallCandidates, trackAction } from "./stall.ts"
import { completionOf, contentToolTokens, lastAssistantOf, panelRow, runningToolOf, textTokensOf, thinkingTokensOf, toolInputTokensOf } from "./tui.tsx"

function expect(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label} (expected ${expected}, got ${actual})`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

// The exact error the user reported — mid-stream closure.
expect(
  isRecoverable({
    name: "UnknownError",
    data: { message: "provider closed the stream before sending a completion marker (upstream connection ended mid-stream)" },
  }),
  true,
  "completion marker stream error is recoverable",
)

// 4xx status codes opencode does not retry by default.
expect(isRecoverable({ name: "APIError", data: { message: "Bad request: invalid field", statusCode: 400, isRetryable: false } }), true, "400 is recoverable")
expect(isRecoverable({ name: "APIError", data: { message: "Forbidden: blocked by gateway", statusCode: 403, isRetryable: false } }), true, "403 is recoverable")
expect(isRecoverable({ name: "APIError", data: { message: "Method not allowed", statusCode: 405, isRetryable: false } }), true, "405 is recoverable")
expect(isRecoverable({ name: "APIError", data: { message: "Unprocessable entity", statusCode: 422, isRetryable: false } }), true, "422 is recoverable")

// Never recover on user abort or permanent errors.
expect(isRecoverable({ name: "MessageAbortedError", data: { message: "operation was aborted" } }), false, "user abort is excluded")
expect(isRecoverable({ name: "APIError", data: { message: "Unauthorized: invalid api key", statusCode: 401, isRetryable: false } }), false, "401 auth error is excluded")
expect(isRecoverable({ name: "UnknownError", data: { message: "Model not found" } }), false, "unknown permanent error is excluded")

// Transient patterns matched from the error text alone.
expect(isRecoverable({ name: "UnknownError", data: { message: "upstream connection ended mid-stream" } }), true, "upstream connection ended is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "overloaded" } }), true, "overloaded is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "rate limit exceeded" } }), true, "rate limit is recoverable")
expect(isRecoverable({ name: "APIError", data: { message: "Provider is overloaded", statusCode: 503, isRetryable: true } }), true, "503 is recoverable")

// Patterns borrowed from the reference plugins (auto-continue / fallback).
expect(isRecoverable({ name: "UnknownError", data: { message: "Bad request" } }), true, "bad request text is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "usage limit" } }), true, "usage limit is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "disconnected" } }), true, "disconnected is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "reasoning_opaque" } }), true, "reasoning_opaque is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "expected string, received undefined" } }), true, "zod validation error is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "Invalid input for tool" } }), true, "invalid tool input is recoverable")

// No match -> stay out of the way.
expect(isRecoverable({ name: "UnknownError", data: { message: "some unrelated failure" } }), false, "unrelated errors are ignored")

// opencode's SQLite layer (transient lock contention).
expect(isRecoverable({ name: "SqlError", data: { message: "Failed to execute statement" } }), true, "sqlite execute failure is recoverable")
expect(isRecoverable({ name: "SqlError", data: { message: "database is locked" } }), true, "sqlite lock is recoverable")

// TLS / certificate family — Bun <1.4 mislabels mid-handshake resets as
// certificate errors (oven-sh/bun#31950); those are transient and retryable.
expect(isRecoverable({ name: "Error", data: { message: "unknown certificate verification error" } }), true, "bun certificate verification mislabel is recoverable")
expect(isRecoverable({ name: "Error", message: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: unknown certificate verification error" }), true, "certificate verification code is recoverable")
expect(isRecoverable({ name: "Error", data: { message: "unable to get local issuer certificate" } }), true, "unable to get issuer is recoverable")
expect(isRecoverable({ name: "Error", data: { message: "self-signed certificate in certificate chain" } }), true, "self-signed cert is recoverable")
expect(isRecoverable({ name: "Error", data: { message: "SSL handshake failed: connection reset" } }), true, "ssl handshake failure is recoverable")

// User-initiated aborts are deliberate stops, not failures.
expect(isAbortError({ name: "MessageAbortedError", data: { message: "operation was aborted" } }), true, "abort error is detected")
expect(isAbortError({ name: "AbortError", message: "Aborted" }), true, "dom aborterror is detected")
expect(isAbortError({ name: "UnknownError", data: { message: "provider closed the stream" } }), false, "non-abort error is not an abort")

// Shared pure helpers.
if (estimateTokens("12345678") !== 2) { console.error("FAIL: estimateTokens ascii"); process.exit(1) }
if (estimateTokens("中文") !== 2) { console.error("FAIL: estimateTokens cjk"); process.exit(1) }
if (estimateTokens("") !== 0) { console.error("FAIL: estimateTokens empty"); process.exit(1) }
if (formatDuration(500) !== "500ms") { console.error("FAIL: formatDuration ms"); process.exit(1) }
if (formatDuration(1500) !== "1.5s") { console.error("FAIL: formatDuration s"); process.exit(1) }
if (formatDuration(90_000) !== "1m 30s") { console.error("FAIL: formatDuration min"); process.exit(1) }
console.log("ok: shared helpers (estimateTokens, formatDuration)")

// TUI panel store helpers (pure).
if (lastAssistantOf([{ type: "user" }, { id: "a1", type: "assistant", time: { completed: 1 } }])?.id !== "a1") { console.error("FAIL: lastAssistantOf"); process.exit(1) }
if (lastAssistantOf([{ role: "assistant", id: "a2" }, { role: "user" }])?.id !== "a2") { console.error("FAIL: lastAssistantOf v1 role"); process.exit(1) }
if (lastAssistantOf(undefined) !== undefined) { console.error("FAIL: lastAssistantOf empty"); process.exit(1) }
if (thinkingTokensOf([{ type: "reasoning", text: "12345678" }, { type: "text", text: "ignored" }]) !== 2) { console.error("FAIL: thinkingTokensOf"); process.exit(1) }
if (thinkingTokensOf(undefined) !== 0) { console.error("FAIL: thinkingTokensOf empty"); process.exit(1) }
if (textTokensOf([{ type: "text", text: "中文" }, { type: "text", text: "12345678" }]) !== 4) { console.error("FAIL: textTokensOf"); process.exit(1) }
if (textTokensOf([{ type: "reasoning", text: "ignored" }, { type: "tool", tool: "bash" }]) !== 0) { console.error("FAIL: textTokensOf non-text"); process.exit(1) }
if (textTokensOf(undefined) !== 0) { console.error("FAIL: textTokensOf empty"); process.exit(1) }
const tool = runningToolOf([{ type: "tool", tool: "bash", callID: "c1", state: { status: "running" }, time: { ran: 1000 } }])
if (tool?.name !== "bash" || tool.callID !== "c1" || tool.start !== 1000) { console.error("FAIL: runningToolOf"); process.exit(1) }
const timeoutTool = runningToolOf([{ type: "tool", tool: "bash", callID: "c8", state: { status: "running", input: { command: "ls", timeout: 30000 } } }])
if (timeoutTool?.timeout !== 30000) { console.error("FAIL: runningToolOf timeout"); process.exit(1) }
if (runningToolOf([{ type: "tool", tool: "bash", callID: "c9", state: { status: "running", input: { command: "ls" } } }])?.timeout !== undefined) { console.error("FAIL: runningToolOf no timeout"); process.exit(1) }
if (runningToolOf([{ type: "tool", tool: "bash", callID: "c10", state: { status: "running", input: { command: "ls", timeout: 0 } } }])?.timeout !== undefined) { console.error("FAIL: runningToolOf zero timeout"); process.exit(1) }
if (runningToolOf([{ type: "tool", tool: "bash", callID: "c11", state: { status: "running", input: "12345678" } }])?.timeout !== undefined) { console.error("FAIL: runningToolOf string input"); process.exit(1) }
const unstable = runningToolOf([{ type: "tool", tool: "write", callID: "c2", state: { status: "pending" }, time: { start: 42 } }])
if (unstable?.name !== "write" || unstable.callID !== "c2" || unstable.start !== undefined) { console.error("FAIL: runningToolOf unstable start"); process.exit(1) }
if (runningToolOf([{ type: "tool", tool: "bash", state: { status: "completed" } }]) !== undefined) { console.error("FAIL: runningToolOf completed"); process.exit(1) }
if (runningToolOf(undefined) !== undefined) { console.error("FAIL: runningToolOf empty"); process.exit(1) }
const tok = runningToolOf([{ type: "tool", tool: "write", callID: "c3", state: { status: "running", input: "12345678" } }])
if (tok?.tool !== "write" || tok.input !== "12345678") { console.error("FAIL: runningToolOf input passthrough"); process.exit(1) }
if (toolInputTokensOf("12345678") !== 2) { console.error("FAIL: toolInputTokensOf"); process.exit(1) }
if (toolInputTokensOf("") !== undefined) { console.error("FAIL: toolInputTokensOf empty"); process.exit(1) }
if (toolInputTokensOf({}) !== undefined) { console.error("FAIL: toolInputTokensOf empty object"); process.exit(1) }
if (contentToolTokens("bash", "echo hello world") !== undefined) { console.error("FAIL: contentToolTokens bash"); process.exit(1) }
if (contentToolTokens("edit", "12345678") !== 2) { console.error("FAIL: contentToolTokens edit"); process.exit(1) }
if (contentToolTokens(undefined, "12345678") !== undefined) { console.error("FAIL: contentToolTokens none"); process.exit(1) }
const completion = completionOf({ id: "a1", type: "assistant", time: { created: 1000, completed: 4000 } })
if (!completion || completion.ms !== 3000) { console.error("FAIL: completionOf"); process.exit(1) }
if (completionOf({ id: "a1", type: "assistant", error: {}, time: { created: 1, completed: 2 } }) !== undefined) { console.error("FAIL: completionOf error"); process.exit(1) }
if (completionOf({ id: "a1", type: "assistant" }) !== undefined) { console.error("FAIL: completionOf unfinished"); process.exit(1) }
console.log("ok: tui panel store helpers")

// Panel line mapping (every display phase, command-verifiable).
const base = { thinking: 0, waiting: false, working: false, textTokens: 0 }
if (panelRow(base) !== "🤖 idle") { console.error("FAIL: panelRow idle"); process.exit(1) }
if (panelRow({ ...base, waiting: true, waitElapsed: 1500 }) !== "⏳ Waiting · 1.5s") { console.error("FAIL: panelRow waiting"); process.exit(1) }
if (panelRow({ ...base, thinking: 1234 }) !== "🤔 Thinking · 1,234 tokens") { console.error("FAIL: panelRow thinking"); process.exit(1) }
if (panelRow({ ...base, thinking: 500, thinkingElapsed: 30_000 }) !== "🤔 Thinking · 30.0s · 500 tokens") { console.error("FAIL: panelRow thinking elapsed"); process.exit(1) }
if (panelRow({ ...base, working: true, textTokens: 567, workElapsed: 3200, workingSpin: 0 }) !== "⠋ Working · 3.2s · 567 tokens") { console.error("FAIL: panelRow working"); process.exit(1) }
if (panelRow({ ...base, working: true, workElapsed: 3200, workingSpin: 1 }) !== "⠙ Working · 3.2s · 0 tokens") { console.error("FAIL: panelRow working spin"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "bash", elapsed: 2500 }, thinking: 1234 }) !== "🔧 bash · 2.5s") { console.error("FAIL: panelRow tool priority"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "bash", elapsed: 2500, timeout: 30000 } }) !== "🔧 bash · 2.5s / 30s") { console.error("FAIL: panelRow tool timeout"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "bash", elapsed: 2500, timeout: 600000 } }) !== "🔧 bash · 2.5s / 10m 0s") { console.error("FAIL: panelRow tool timeout min"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "edit", elapsed: 2500, tokens: 567 }, thinking: 1234 }) !== "🔧 edit · 2.5s · 567 tokens") { console.error("FAIL: panelRow tool tokens"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "edit", elapsed: 2500, timeout: 30000, tokens: 567 } }) !== "🔧 edit · 2.5s / 30s · 567 tokens") { console.error("FAIL: panelRow tool timeout tokens"); process.exit(1) }
if (panelRow({ ...base, done: { ms: 90_000, at: "14:30:22" } }) !== "✅ Done · 1m 30s · 14:30:22") { console.error("FAIL: panelRow done"); process.exit(1) }
if (panelRow({ ...base, failed: true }) !== "❌ Failed") { console.error("FAIL: panelRow failed"); process.exit(1) }
if (panelRow({ ...base, done: { ms: 90_000, at: "14:30:22" }, failed: true }) !== "✅ Done · 1m 30s · 14:30:22") { console.error("FAIL: panelRow done over failed"); process.exit(1) }
console.log("ok: panel line mapping (11 phases)")

// ── Extended coverage (mixed CJK/ASCII estimation, selection edge cases) ─────

// estimateTokens: CJK chars count as one token each, non-CJK at ~4 chars each.
if (estimateTokens("中文English") !== 4) { console.error("FAIL: estimateTokens mixed"); process.exit(1) }
if (estimateTokens("你好世界") !== 4) { console.error("FAIL: estimateTokens cjk only"); process.exit(1) }
if (estimateTokens("    ") !== 1) { console.error("FAIL: estimateTokens whitespace"); process.exit(1) }

// thinkingTokensOf / textTokensOf with mixed content and multiple parts.
if (thinkingTokensOf([{ type: "reasoning", text: "中文12345678" }]) !== 4) { console.error("FAIL: thinkingTokensOf mixed"); process.exit(1) }
if (textTokensOf([{ type: "text", text: "abcd" }, { type: "text", text: "efgh" }]) !== 2) { console.error("FAIL: textTokensOf multiple"); process.exit(1) }
if (textTokensOf([{ type: "text", text: "" }]) !== 0) { console.error("FAIL: textTokensOf empty part"); process.exit(1) }

// lastAssistantOf: trailing user message does not hide the last assistant.
if (lastAssistantOf([{ type: "user" }, { type: "assistant", id: "a3" }, { type: "user" }])?.id !== "a3") { console.error("FAIL: lastAssistantOf trailing user"); process.exit(1) }
if (lastAssistantOf([]) !== undefined) { console.error("FAIL: lastAssistantOf empty list"); process.exit(1) }

// panelRow: waiting without elapsed shows the bare phase.
if (panelRow({ ...base, waiting: true }) !== "⏳ Waiting") { console.error("FAIL: panelRow waiting bare"); process.exit(1) }
// panelRow: tool wins over every other state.
if (panelRow({ ...base, tool: { name: "write", elapsed: 1200, tokens: 300 }, working: true, textTokens: 999, thinking: 500, done: { ms: 1000, at: "12:00:00" } }) !== "🔧 write · 1.2s · 300 tokens") { console.error("FAIL: panelRow tool over all"); process.exit(1) }
// panelRow: failed wins over idle but not over done.
if (panelRow({ ...base, failed: true }) !== "❌ Failed") { console.error("FAIL: panelRow failed priority"); process.exit(1) }

console.log("ok: extended coverage (mixed content, edge cases)")

// ── Stall watchdog (event-silence hang detection) ───────────────────────────

// Generation-progress events prove liveness, tracked per session.
{
  const t = trackAction("message.part.updated", { part: { sessionID: "s1" } })
  if (t.action !== "track" || t.sessionID !== "s1") { console.error("FAIL: trackAction part.updated"); process.exit(1) }
}
{
  const t = trackAction("message.updated", { info: { sessionID: "s2" } })
  if (t.action !== "track" || t.sessionID !== "s2") { console.error("FAIL: trackAction message.updated"); process.exit(1) }
}
{
  const t = trackAction("session.status", { sessionID: "s3" })
  if (t.action !== "track" || t.sessionID !== "s3") { console.error("FAIL: trackAction session.status"); process.exit(1) }
}
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

// stallCandidates: only sessions quiet longer than the timeout qualify.
const activity = new Map([["s1", 1_000_000], ["s2", 2_000_000], ["s3", 1_500_000]])
if (JSON.stringify(stallCandidates(activity, 2_100_000, 600_000)) !== '["s1"]') { console.error("FAIL: stallCandidates basic"); process.exit(1) }
if (stallCandidates(new Map(), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates empty"); process.exit(1) }
// Exact boundary: now - last === timeout does NOT qualify (strictly greater).
if (stallCandidates(new Map([["s1", 1_500_000]]), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates boundary"); process.exit(1) }

console.log("ok: stall watchdog (trackAction, stallCandidates)")

console.log("all checks passed")
