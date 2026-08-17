// Error-matching logic for opencode-turbo.
//
// Extracted from the plugin entry so the entry module only exports the default
// plugin function: opencode's legacy plugin loader treats every export of the
// entry module as a plugin, so pure helpers must live in a separate module.

// Substring patterns (case-insensitive) matched against "Name: message".
// Covers stream closures, connection drops and provider overload that opencode
// may or may not classify as retryable on its own.
const RETRY_PATTERNS = [
  "completion marker",
  "upstream connection",
  "mid-stream",
  "stream closed",
  "stream ended",
  "stream error",
  "stream interrupted",
  "unexpected end",
  "premature close",
  "connection reset",
  "connection closed",
  "connection lost",
  "connection terminated",
  "connection aborted",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "socket hang up",
  "socket closed",
  "network error",
  "reset by peer",
  "broken pipe",
  "upstream connect error",
  "fetch failed",
  "failed to fetch",
  "request timed out",
  "connection timed out",
  "response timeout",
  "idle timeout",
  "sse read timed out",
  "no data received",
  "read timed out",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "internal server error",
  "server error",
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
  "resource exhausted",
  "try your request again",
  "retry your request",
  // Provider/model-output errors that a retry lets the model fix itself
  "bad request",
  "reasoning_opaque",
  "prefill",
  "expected string, received undefined",
  "invalid diff",
  "json parsing failed",
  "invalid input for tool",
  "tool_use ids were found without tool_result",
  "tried to call unavailable tool",
  "disconnected",
  "etimedout",
  "enotfound",
  "eai_again",
  "epipe",
  // opencode's SQLite layer (transient lock contention, e.g. many concurrent
  // instances writing the same session DB — a retry after backoff succeeds)
  "failed to execute statement",
  "database is locked",
  // TLS / certificate family. Genuine cert problems are permanent, but Bun
  // (< 1.4) mislabels mid-handshake connection resets as UNKNOWN_CERTIFICATE_
  // VERIFICATION_ERROR (oven-sh/bun#31950) — that case is a transient network
  // failure and retrying is exactly right. Text cannot tell the two apart, so
  // the recovery guardrails (attempt cap + backoff) do the filtering.
  "certificate verification",
  "unable to get local issuer certificate",
  "unable to verify",
  "self-signed",
  "certificate has expired",
  "certificate expired",
  "ssl handshake",
  "tls handshake",
  "tls_error",
  "ssl_error",
]

// HTTP status codes that are worth retrying even though opencode does not
// retry them by default (most 4xx are non-retryable in opencode's policy).
// 401 (auth), 404 (not found) and 413 (payload too large) are excluded as
// permanent failures.
const RETRY_STATUS_CODES = [400, 402, 403, 405, 408, 409, 422, 429, 500, 502, 503, 504, 524, 529]

// Never recover on these (user action or permanent failure).
const EXCLUDE_PATTERNS = [
  "MessageAbortedError",
  "operation was aborted",
  "unauthorized",
  "invalid api key",
  "authentication",
  "not authenticated",
  "MessageOutputLengthError",
  "output length",
  "context overflow",
  "too large to compact",
  "not found",
  "does not exist",
  "invalid request body",
  "unsupported",
]

export function errorText(error: unknown): { name: string; message: string; statusCode?: number } {
  if (!error || typeof error !== "object") return { name: "", message: "" }
  const e = error as Record<string, unknown>
  const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>
  const name = typeof e.name === "string" ? e.name : ""
  const message =
    (typeof data.message === "string" ? data.message : null) ??
    (typeof e.message === "string" ? e.message : "")
  const statusCode =
    typeof data.statusCode === "number"
      ? data.statusCode
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined
  return { name, message, statusCode }
}

/** Decide whether an error is worth recovering from. */
export function isRecoverable(error: unknown): boolean {
  const { name, message, statusCode } = errorText(error)
  const match = `${name}: ${message}`.toLowerCase()

  for (const pattern of EXCLUDE_PATTERNS) {
    if (match.includes(pattern.toLowerCase())) return false
  }
  if (statusCode !== undefined && RETRY_STATUS_CODES.includes(statusCode)) return true
  for (const pattern of RETRY_PATTERNS) {
    if (match.includes(pattern.toLowerCase())) return true
  }
  return false
}

/** User-initiated aborts are deliberate stops, not failures. */
export function isAbortError(error: unknown): boolean {
  const { name, message } = errorText(error)
  const match = `${name}: ${message}`.toLowerCase()
  return (
    match.includes("messageabortederror") ||
    match.includes("aborterror") ||
    match.includes("operation was aborted")
  )
}
