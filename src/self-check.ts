// Self-check for opencode-turbo matching logic.
// Run with: bun run src/self-check.ts

import { isRecoverable } from "./matcher.ts"
import { estimateTokens, formatDuration } from "./util.ts"
import { completionOf, lastAssistantOf, panelRow, runningToolOf, textTokensOf, thinkingTokensOf } from "./tui.tsx"

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
const unstable = runningToolOf([{ type: "tool", tool: "write", callID: "c2", state: { status: "pending" }, time: { start: 42 } }])
if (unstable?.name !== "write" || unstable.callID !== "c2" || unstable.start !== undefined) { console.error("FAIL: runningToolOf unstable start"); process.exit(1) }
if (runningToolOf([{ type: "tool", tool: "bash", state: { status: "completed" } }]) !== undefined) { console.error("FAIL: runningToolOf completed"); process.exit(1) }
if (runningToolOf(undefined) !== undefined) { console.error("FAIL: runningToolOf empty"); process.exit(1) }
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
if (panelRow({ ...base, thinking: 500, thinkingElapsed: 30_000 }) !== "🤔 Thinking · 500 tokens · 30.0s") { console.error("FAIL: panelRow thinking elapsed"); process.exit(1) }
if (panelRow({ ...base, working: true, textTokens: 567 }) !== "✍️ Writing · 567 tokens") { console.error("FAIL: panelRow writing"); process.exit(1) }
if (panelRow({ ...base, working: true }) !== "✍️ Writing · 0 tokens") { console.error("FAIL: panelRow working tokens"); process.exit(1) }
if (panelRow({ ...base, tool: { name: "bash", elapsed: 2500 }, thinking: 1234 }) !== "🔧 bash · 2.5s") { console.error("FAIL: panelRow tool priority"); process.exit(1) }
if (panelRow({ ...base, done: { ms: 90_000, at: "14:30:22" } }) !== "✅ Done · 1m 30s · 14:30:22") { console.error("FAIL: panelRow done"); process.exit(1) }
console.log("ok: panel line mapping (8 phases)")

console.log("all checks passed")
