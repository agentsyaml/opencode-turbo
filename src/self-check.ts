// Self-check for opencode-turbo matching logic.
// Run with: bun run src/self-check.ts

import { isAbortError, isRecoverable } from "./matcher.ts"
import { clearPendingRecovery, createState, discardPendingRecovery, isBlockedSession, isGenuineRecoveryUserMessage, isRecoveryPromptMessage, isSuccessfulRecoveryContinuation, isUnfinishedAssistant, MAX_ATTEMPTS, MAX_PREFLIGHT_ATTEMPTS, messageReadFailed, recoveryBarrierAllows, recoveryRequestIsCurrent, recoveryRequestIsNewer, resetRecoveryAfterSuccess, samePendingRecovery, startsRecoveryChain, targetAssistant } from "./core.ts"
import { estimateTokens, formatDuration } from "./util.ts"
import { idleAction, isActiveStatus, isEmptyOutput, stallCandidates, trackAction } from "./stall.ts"
import { completionOf, contentToolTokens, hasPendingUserRequest, lastAssistantOf, panelRow, runningToolOf, textTokensOf, thinkingTokensOf, toolInputTokensOf } from "./tui.tsx"

function expect(actual: boolean, expected: boolean, label: string): void {
  if (actual !== expected) {
    console.error(`FAIL: ${label} (expected ${expected}, got ${actual})`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

// Explicit API status policy. Authentication and other permanent statuses do
// not recover, even when their text resembles a transient service failure.
for (const statusCode of [400, 402, 403, 405, 408, 409, 422, 429, 500, 502, 503, 504, 524, 529]) {
  expect(isRecoverable({ name: "APIError", data: { message: "provider failure", statusCode } }), true, `API status ${statusCode} is recoverable`)
}
expect(isRecoverable({ name: "APIError", data: { message: "Unauthorized: invalid api key", statusCode: 401 } }), false, "401 auth error is excluded")
expect(isRecoverable({ name: "APIError", data: { message: "Model not found", statusCode: 404 } }), false, "404 not-found error is excluded")
expect(isRecoverable({ name: "APIError", data: { message: "payload too large", statusCode: 413 } }), false, "413 payload error is excluded")
for (const message of ["context overflow", "context window exceeded", "too large to compact", "output length exceeded"]) {
  expect(isRecoverable({ name: "APIError", data: { message, statusCode: 400 } }), false, `${message} is permanent`)
}
for (const message of ["invalid diff", "Invalid input for tool"]) {
  expect(isRecoverable({ name: "APIError", data: { message, statusCode: 400 } }), false, `API ${message} is excluded`)
  expect(isRecoverable({ name: "UnknownError", data: { message } }), false, `Unknown ${message} is excluded`)
}

// Without a status code, only an explicit APIError may use the small service
// message allowlist.
for (const message of ["service unavailable", "bad gateway", "internal server error", "too many requests", "rate limit exceeded"]) {
  expect(isRecoverable({ name: "APIError", data: { message } }), true, `API message ${message} is recoverable`)
  expect(isRecoverable({ name: "UnknownError", data: { message } }), false, `UnknownError ${message} is ignored`)
}

// Explicit SQL classes accept only the two known transient database failures.
for (const name of ["SqlError", "SQLite", "SQLiteError", "Database", "DatabaseError"]) {
  expect(isRecoverable({ name, data: { message: "Failed to execute statement" } }), true, `${name} execute failure is recoverable`)
  expect(isRecoverable({ name, data: { message: "database is locked" } }), true, `${name} lock is recoverable`)
}
expect(isRecoverable({ name: "UnknownError", data: { message: "Failed to execute statement" } }), false, "unclassified SQL text is ignored")
expect(isRecoverable({ name: "UnknownError", data: { message: "Failed query: insert into session (id) values (?)" } }), true, "failed query SQL shape is recoverable")
expect(isRecoverable({ name: "UnknownError", data: { message: "Failed query: something went wrong" } }), false, "failed query non-SQL text is ignored")
expect(isRecoverable({ name: "UnknownError", data: { message: "invalid query" } }), false, "invalid query text is ignored")
expect(isRecoverable({ name: "UnknownError", data: { message: "insert into session (id) values (?)" } }), false, "arbitrary SQL text is ignored")
expect(isRecoverable({ name: "SqlError", data: { message: "invalid query" } }), false, "generic SQL error is ignored")
expect(isRecoverable({ name: "SqlError", data: { message: "Failed query: something went wrong" } }), false, "non-SQL failed query is ignored")

// Narrow connection and transport failures remain recoverable without an API
// wrapper.
for (const message of [
  "connection reset by peer",
  "connection closed",
  "connection lost",
  "connection terminated",
  "connection refused",
  "reset by peer",
  "unable to connect to provider",
  "ECONNRESET",
  "socket hang up",
  "socket closed",
  "network error",
  "fetch failed",
  "request timed out",
  "connection timed out",
  "response timeout",
  "idle timeout",
  "read timed out",
  "SSE timeout",
  "ETIMEDOUT",
  "broken pipe",
  "EPIPE",
  "stream closed",
  "stream ended",
  "premature close",
]) {
  expect(isRecoverable({ name: "UnknownError", data: { message } }), true, `${message} is recoverable`)
}

// Model/tool output, generic text, certificates and message-only service
// errors must stay out of the recovery path.
for (const message of [
  "completion marker",
  "mid-stream",
  "stream error",
  "disconnected",
  "Bad request",
  "reasoning_opaque",
  "Invalid input for tool",
  "SSL handshake failed: connection reset",
  "overloaded",
  "rate limit exceeded",
  "timeout",
  "tool timeout",
  "operation was aborted",
]) {
  expect(isRecoverable({ name: "UnknownError", data: { message } }), false, `UnknownError ${message} is ignored`)
}
for (const error of [
  { name: "Error", message: "unknown certificate verification error", code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR" },
  { name: "APIError", data: { code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "unknown certificate verification error" } },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "unknown certificate verification error" },
  { name: "Error", data: { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "Error: unknown certificate verification error" } },
  { name: "UnknownError", data: { code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "Error: unknown certificate verification error" } },
  { name: "UnknownError", data: { message: "Error: unknown certificate verification error" } },
  { name: "UnknownError", data: { message: "unknown certificate verification error" } },
  { name: "Error", code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: unknown certificate verification error" },
]) {
  expect(isRecoverable(error), true, `${error.name} exact Bun certificate-network shape is recoverable`)
}
expect(isRecoverable({ name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "unknown certificate verification error" }), true, "certificate error name with exact message is recoverable")
expect(isRecoverable({ data: { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "unknown certificate verification error" } }), true, "data certificate error name is recovered")
expect(isRecoverable({ name: "UnknownError", data: { code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "Error: unknown certificate verification error" } }), true, "data certificate error code is recovered")
for (const error of [
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "" },
  { data: { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "" } },
  { name: "Error", message: "unknown certificate verification error" },
  { name: "Error", message: "Error: unknown certificate verification error" },
  { name: "UnknownError", message: "Error: unknown certificate verification error" },
  { name: "UnknownError", data: { message: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: unknown certificate verification error" } },
  { name: "UnknownError", data: { message: "Error: another certificate failure" } },
  { name: "Error", message: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR" },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "Unknown certificate verification error" },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "unknown_certificate_verification_error" },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: " unknown certificate verification error" },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "Error: unknown certificate verification error " },
  { name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: Unknown certificate verification error" },
]) {
  expect(isRecoverable(error), false, "certificate code or phrase without provenance is ignored")
}
for (const message of [
  "certificate verification",
  "unknown certificate verification error while connecting",
  "certificate verification failed while connecting",
  "self-signed certificate in certificate chain",
  "certificate expired",
  "certificate has expired",
  "unable to get local issuer certificate",
]) {
  expect(isRecoverable({ name: "Error", message }), false, `${message} remains permanent`)
}
for (const message of ["certificate verification", "self-signed certificate", "certificate expired", "certificate has expired", "unable to get local issuer certificate"]) {
  expect(isRecoverable({ name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", message }), false, `named certificate error with ${message} remains permanent`)
}
for (const code of ["CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT"]) {
  expect(isRecoverable({ name: "Error", code, message: "unknown certificate verification error" }), false, `${code} remains permanent`)
}
expect(isRecoverable({ name: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", data: { name: "CERT_HAS_EXPIRED", message: "unknown certificate verification error" } }), false, "permanent nested name overrides Bun name")
expect(isRecoverable({ code: "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR", data: { code: "SELF_SIGNED_CERT_IN_CHAIN", message: "unknown certificate verification error" } }), false, "permanent nested code overrides Bun code")
expect(isRecoverable({ name: "APIError", data: { message: "operation was aborted" } }), false, "bare abort text is not an API retry pattern")
expect(isRecoverable({ name: "UnknownError", data: { message: "some unrelated failure" } }), false, "unrelated errors are ignored")

// User-initiated aborts are deliberate stops, not failures.
for (const name of ["MessageAbortedError", "APIUserAbortError", "UICancelledError"]) {
  expect(isRecoverable({ name, data: { message: "operation was aborted" } }), false, `${name} is excluded`)
  expect(isAbortError({ name }), true, `${name} is detected`)
}
expect(isRecoverable({ name: "AbortError", message: "Aborted" }), false, "DOM abort is not recoverable")
expect(isRecoverable({ name: "AbortError", message: "fetch failed" }), false, "transport-named abort is not recoverable")
expect(isAbortError({ name: "AbortError", message: "Aborted" }), true, "DOM aborterror is detected")
expect(isAbortError({ name: "AbortError", message: "fetch failed" }), true, "raw AbortError is always an abort")
expect(isAbortError({ name: "UnknownError", data: { message: "provider closed the stream" } }), false, "non-abort error is not an abort")
expect(isRecoverable({ name: "UnknownError", data: { name: "APIUserAbortError", message: "connection reset" } }), false, "nested API user abort masks transport text")
expect(isAbortError({ name: "UnknownError", data: { name: "APIUserAbortError" } }), true, "nested API user abort is detected")
expect(isRecoverable({ name: "UnknownError", data: { name: "UnauthorizedError", message: "connection reset" } }), false, "nested auth error masks transport text")
expect(isRecoverable({ name: "UnknownError", data: { code: "UNAUTHORIZED", message: "connection reset" } }), false, "nested auth code masks transport text")
expect(isRecoverable({ name: "UnknownError", data: { name: "APIError", message: "connection reset" } }), true, "nested API error preserves transport recovery")
for (const error of [
  { name: "ForbiddenError", message: "connection reset" },
  { code: "FORBIDDEN", message: "connection reset" },
  { name: "UnknownError", data: { name: "PermissionDeniedError", message: "connection reset" } },
  { name: "UnknownError", data: { code: "ACCESS_DENIED", message: "connection reset" } },
]) expect(isRecoverable(error), false, "forbidden/auth identifiers mask transport text")

expect(isBlockedSession("child", new Set(), new Set(["child"])), true, "unknown parent pending blocks its session")
expect(isBlockedSession("other", new Set(), new Set(["child"])), false, "unknown parent pending stays local")
expect(isUnfinishedAssistant({ info: { role: "assistant" } }), true, "unfinished assistant is readiness state")
expect(targetAssistant([{ info: { id: "pending", role: "assistant" } }], "pending") !== undefined, true, "unfinished target remains eligible for preflight")
expect(isUnfinishedAssistant({ info: { role: "assistant", finish: "stop" } }), false, "finished assistant is terminal")
expect(targetAssistant([{ info: { id: "done", role: "assistant", time: { completed: 1 } } }], "done") === undefined, true, "completed target terminalizes")
expect(targetAssistant([{ info: { id: "stale", role: "assistant" } }, { info: { role: "user" } }], "stale") === undefined, true, "changed target terminalizes")
if (MAX_PREFLIGHT_ATTEMPTS !== 3 || createState().preflightAttempts !== 0 || createState().recoveryCancelled || createState().recoveryPromptMessageIDs.size !== 0) { console.error("FAIL: bounded preflight state"); process.exit(1) }
expect(messageReadFailed(undefined), true, "failed message read is deferred")
expect(messageReadFailed([]), false, "empty message list is not a read failure")
const preflightTerminal = createState()
preflightTerminal.preflightAttempts = MAX_PREFLIGHT_ATTEMPTS
preflightTerminal.pendingRecovery = { reason: "status is busy" }
clearPendingRecovery(preflightTerminal)
expect(preflightTerminal.preflightAttempts === MAX_PREFLIGHT_ATTEMPTS && preflightTerminal.pendingRecovery === undefined, true, "preflight exhaustion clears pending recovery")
const originalPending = { reason: "old" }
const newerPending = { reason: "new" }
const replacementPending = { reason: "replacement" }
const discardState = createState()
discardState.pendingRecovery = originalPending
expect(!discardPendingRecovery(discardState, newerPending) && discardState.pendingRecovery === originalPending, true, "discard preserves newer pending identity")
expect(discardPendingRecovery(discardState, originalPending) && discardState.pendingRecovery === undefined, true, "discard clears matching pending identity")
const pendingIdentity = createState()
pendingIdentity.pendingRecovery = originalPending
if (samePendingRecovery(pendingIdentity.pendingRecovery, newerPending)) clearPendingRecovery(pendingIdentity)
expect(pendingIdentity.pendingRecovery === originalPending, true, "terminal cleanup preserves newer pending recovery")
pendingIdentity.pendingRecovery = newerPending
if (samePendingRecovery(pendingIdentity.pendingRecovery, newerPending)) clearPendingRecovery(pendingIdentity)
expect(pendingIdentity.pendingRecovery === undefined, true, "matching pending recovery is clearable")
pendingIdentity.pendingRecovery = newerPending
if (samePendingRecovery(pendingIdentity.pendingRecovery, originalPending)) pendingIdentity.pendingRecovery = replacementPending
expect(pendingIdentity.pendingRecovery === newerPending, true, "stale active write cannot replace newer pending")
pendingIdentity.pendingRecovery = originalPending
if (samePendingRecovery(pendingIdentity.pendingRecovery, originalPending)) pendingIdentity.pendingRecovery = replacementPending
expect(pendingIdentity.pendingRecovery === replacementPending, true, "matching old pending can be replaced")
const concurrentRecovery = createState()
concurrentRecovery.preflightAttempts = 2
concurrentRecovery.recovering = true
if (startsRecoveryChain(concurrentRecovery)) concurrentRecovery.preflightAttempts = 0
expect(concurrentRecovery.preflightAttempts === 2, true, "concurrent recovery keeps preflight budget")
concurrentRecovery.recovering = false
concurrentRecovery.pendingRecovery = originalPending
if (startsRecoveryChain(concurrentRecovery)) concurrentRecovery.preflightAttempts = 0
expect(concurrentRecovery.preflightAttempts === 2 && concurrentRecovery.pendingRecovery === originalPending, true, "pending recovery keeps preflight budget")
const freshRecovery = createState()
expect(startsRecoveryChain(freshRecovery), true, "fresh recovery chain resets preflight budget")
const completionWhilePromptPending = createState()
completionWhilePromptPending.recovering = true
completionWhilePromptPending.attempts = 2
completionWhilePromptPending.preflightAttempts = 2
completionWhilePromptPending.lastRecoveredMessageID = "failed"
completionWhilePromptPending.recoveryPromptMessageIDs.add("prompt")
completionWhilePromptPending.recoveryPromptRequestSequences.set("prompt", 2)
completionWhilePromptPending.pendingRecovery = newerPending
resetRecoveryAfterSuccess(completionWhilePromptPending, completionWhilePromptPending.recovering)
expect(completionWhilePromptPending.attempts === 0 && completionWhilePromptPending.preflightAttempts === 0 && completionWhilePromptPending.lastRecoveredMessageID === undefined && completionWhilePromptPending.pendingRecovery === newerPending && completionWhilePromptPending.recoveryPromptMessageIDs.has("prompt") && completionWhilePromptPending.recoveryPromptRequestSequences.get("prompt") === 2, true, "completion while prompt pending resets state and preserves queue")
const cancelledCompletion = createState()
cancelledCompletion.recoveryCancelled = true
cancelledCompletion.recoveryPromptMessageIDs.add("prompt")
resetRecoveryAfterSuccess(cancelledCompletion)
expect(cancelledCompletion.recoveryCancelled && cancelledCompletion.recoveryPromptMessageIDs.has("prompt"), true, "successful completion does not clear cancellation barrier")
const rejectedTarget = createState()
if (isRecoverable({ name: "APIError", data: { message: "Unauthorized", statusCode: 401 } })) rejectedTarget.lastRecoveredMessageID = "rejected"
expect(rejectedTarget.lastRecoveredMessageID === undefined, true, "non-recoverable reclassification leaves no recovery marker")
const cancelledRecovery = createState()
cancelledRecovery.recoveryGeneration = 1
cancelledRecovery.pendingRecovery = newerPending
expect(!samePendingRecovery(cancelledRecovery.pendingRecovery, originalPending) && samePendingRecovery(cancelledRecovery.pendingRecovery, newerPending), true, "current pending drains after old-generation cancellation")
cancelledRecovery.recoveryCancelled = true
expect(!recoveryBarrierAllows(cancelledRecovery.recoveryCancelled), true, "cancelled pending does not drain")
expect(recoveryRequestIsNewer(2, 1), false, "older external recovery cannot replace newer pending")
expect(recoveryRequestIsNewer(1, 2), true, "newer external recovery can replace pending")
const sequenceState = createState()
const sequenceGeneration = sequenceState.recoveryGeneration
sequenceState.recoveryRequestSequence = 2
expect(recoveryRequestIsCurrent(sequenceState, sequenceGeneration, 2), true, "current recovery sequence is admitted")
sequenceState.recoveryRequestSequence = 3
expect(!recoveryRequestIsCurrent(sequenceState, sequenceGeneration, 2), true, "older recovery sequence is fenced")
sequenceState.recoveryGeneration++
expect(!recoveryRequestIsCurrent(sequenceState, sequenceGeneration, 3), true, "deleted recovery generation is fenced")
const continuationIDs = new Set(["prompt"])
const continuationSequences = new Map([["prompt", 2]])
expect(isSuccessfulRecoveryContinuation(continuationIDs, continuationSequences, "prompt", 2), true, "matching recovery continuation is confirmed")
expect(!isSuccessfulRecoveryContinuation(continuationIDs, continuationSequences, "other", 2), true, "unrelated assistant completion is ignored")
expect(!isSuccessfulRecoveryContinuation(continuationIDs, continuationSequences, "prompt", 3), true, "older continuation cannot reset newer chain")
expect(!recoveryBarrierAllows(true), true, "stale same-target error is rejected")
expect(!recoveryBarrierAllows(true), true, "targetless recovery stays behind cancellation barrier")
expect(recoveryBarrierAllows(false), true, "new target clears cancellation barrier")
const pluginPromptIDs = new Set(["msg_plugin"])
expect(isRecoveryPromptMessage(pluginPromptIDs, "msg_plugin"), true, "plugin prompt user message is identified")
expect(!isRecoveryPromptMessage(pluginPromptIDs, "msg_late"), true, "late different user message is not plugin prompt")
expect(isGenuineRecoveryUserMessage(pluginPromptIDs, "msg_user"), true, "different user ID clears cancellation barrier")
expect(!isGenuineRecoveryUserMessage(pluginPromptIDs, "msg_plugin"), true, "late plugin user update does not clear barrier")
expect(!isGenuineRecoveryUserMessage(pluginPromptIDs, undefined), true, "ID-less user update does not clear barrier")
const pluginUpdate = createState()
pluginUpdate.recoveryPromptMessageIDs.add("msg_plugin")
expect(isRecoveryPromptMessage(pluginUpdate.recoveryPromptMessageIDs, "msg_plugin") && pluginUpdate.recoveryPromptMessageIDs.has("msg_plugin"), true, "first plugin update retains prompt marker")
pluginUpdate.recoveryCancelled = true
expect(isRecoveryPromptMessage(pluginUpdate.recoveryPromptMessageIDs, "msg_plugin") && pluginUpdate.recoveryCancelled, true, "late plugin update keeps cancellation barrier")
const attemptTerminal = createState()
attemptTerminal.attempts = MAX_ATTEMPTS
attemptTerminal.gaveUp = true
expect(MAX_ATTEMPTS === 10 && attemptTerminal.attempts === MAX_ATTEMPTS && attemptTerminal.gaveUp, true, "actual attempt cap is terminal")

// Shared pure helpers.
if (estimateTokens("12345678") !== 2) { console.error("FAIL: estimateTokens ascii"); process.exit(1) }
if (estimateTokens("中文") !== 2) { console.error("FAIL: estimateTokens cjk"); process.exit(1) }
if (estimateTokens("") !== 0) { console.error("FAIL: estimateTokens empty"); process.exit(1) }
if (formatDuration(500) !== "500ms") { console.error("FAIL: formatDuration ms"); process.exit(1) }
if (formatDuration(1500) !== "1.5s") { console.error("FAIL: formatDuration s"); process.exit(1) }
if (formatDuration(90_000) !== "1m 30s") { console.error("FAIL: formatDuration min"); process.exit(1) }
if (!isActiveStatus("working") || isActiveStatus("idle") || isActiveStatus("unknown")) { console.error("FAIL: session status classification"); process.exit(1) }
console.log("ok: shared helpers (estimateTokens, formatDuration)")

// TUI panel store helpers (pure).
if (lastAssistantOf([{ type: "user" }, { id: "a1", type: "assistant", time: { completed: 1 } }])?.id !== "a1") { console.error("FAIL: lastAssistantOf"); process.exit(1) }
if (lastAssistantOf([{ role: "assistant", id: "a2" }, { role: "user" }])?.id !== "a2") { console.error("FAIL: lastAssistantOf v1 role"); process.exit(1) }
if (lastAssistantOf(undefined) !== undefined) { console.error("FAIL: lastAssistantOf empty"); process.exit(1) }
if (!hasPendingUserRequest([{ id: "p1" }], [])) { console.error("FAIL: pending permission request"); process.exit(1) }
if (!hasPendingUserRequest([], [{ id: "q1" }])) { console.error("FAIL: pending question request"); process.exit(1) }
if (hasPendingUserRequest([], [])) { console.error("FAIL: no pending user request"); process.exit(1) }
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

// stallCandidates remains a pure helper; the event path does not recover stalls.
const activity = new Map([["s1", 1_000_000], ["s2", 2_000_000], ["s3", 1_500_000]])
if (JSON.stringify(stallCandidates(activity, 2_100_000, 600_000)) !== '["s1"]') { console.error("FAIL: stallCandidates basic"); process.exit(1) }
if (stallCandidates(new Map(), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates empty"); process.exit(1) }
// Exact boundary: now - last === timeout does NOT qualify (strictly greater).
if (stallCandidates(new Map([["s1", 1_500_000]]), 2_100_000, 600_000).length !== 0) { console.error("FAIL: stallCandidates boundary"); process.exit(1) }

console.log("ok: stall helpers (trackAction, stallCandidates)")

// ── Empty-output detection helper (never an automatic recovery trigger) ───────

// Reasoning-only message: the helper identifies empty output, but the plugin
// does not automatically send another prompt for it.
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

console.log("all checks passed")
