// Error-matching logic for opencode-turbo.
//
// Extracted from the plugin entry so the entry module only exports the default
// plugin function: opencode's legacy plugin loader treats every export of the
// entry module as a plugin, so pure helpers must live in a separate module.

// HTTP status codes that are worth retrying even though opencode does not
// retry them by default. Authentication, not-found and payload-too-large
// responses remain permanent failures.
const RETRY_STATUS_CODES = new Set([400, 402, 403, 405, 408, 409, 422, 429, 500, 502, 503, 504, 524, 529])

const USER_ABORT_NAMES = new Set([
  "messageabortederror",
  "apiuseraborterror",
  "uicancellederror",
])

const SQL_ERROR_NAMES = /^(?:sqlerror|sqlite(?:error)?|database(?:error)?)$/i

// Only these messages are accepted without an API status code, and only when
// the error is explicitly classified as APIError. The same text on an
// UnknownError is intentionally ignored.
const API_TRANSIENT_MESSAGES = [
  "service unavailable",
  "bad gateway",
  "internal server error",
  "too many requests",
  "rate limit",
]

// Transport failures are useful even when the provider did not wrap them in
// APIError. Keep these patterns specific: model/tool text and vague stream
// state descriptions must not start a new prompt.
const CONNECTION_PATTERNS = [
  /\bconnection\s+(?:reset|closed|lost|terminated|aborted|ended)\b/i,
  /\bconnection\s+refused\b/i,
  /\b(?:reset|closed|lost|terminated|aborted|ended)\s+(?:the\s+)?(?:connection|stream)\b/i,
  /\breset\s+by\s+peer\b/i,
  /\bunable\s+to\s+connect\b/i,
  /\beconn[a-z0-9_]*\b/i,
  /\bsocket\s+(?:hang\s+up|closed)\b/i,
  /\bnetwork\s+error\b/i,
  /\b(?:fetch failed|failed to fetch)\b/i,
  /\b(?:request|connection|response|idle|read|sse)\s+(?:timeout|timed\s+out)\b/i,
  /\betimedout\b/i,
  /\bbroken\s+pipe\b/i,
  /\bepipe\b/i,
  /\bstream\s+(?:closed|ended)\b/i,
  /\bpremature\s+close\b/i,
]

// Never recover on user aborts or known permanent failures. Certificate/TLS
// text is deliberately blocked before transport matching so a certificate
// error that also mentions a reset cannot become retryable by accident.
const PERMANENT_PATTERNS = [
  "unauthorized",
  "invalid api key",
  "authentication",
  "not authenticated",
  "output length",
  "context overflow",
  "context window",
  "context length",
  "context limit",
  "maximum context",
  "too large to compact",
  "not found",
  "does not exist",
  "invalid request body",
  "unsupported",
  "invalid diff",
  "reasoning_opaque",
  "prefill",
  "expected string, received undefined",
  "invalid input for tool",
  "tool_use ids were found without tool_result",
  "tried to call unavailable tool",
  "certificate",
  "tls",
  "ssl",
]

function hasAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern))
}

function isExplicitUserAbortName(name: string): boolean {
  return USER_ABORT_NAMES.has(name.toLowerCase())
}

function isConnectionError(text: string): boolean {
  return CONNECTION_PATTERNS.some((pattern) => pattern.test(text))
}

function isSqlFailure(message: string): boolean {
  return message.includes("failed to execute statement") || message.includes("database is locked")
}

function isFailedQuery(message: string): boolean {
  return /failed query:\s*(?:select|insert|update|delete|replace|with|create|alter|drop|pragma|begin|commit|rollback|vacuum|attach|detach|reindex|analyze|end|savepoint|release|truncate|merge)\b/.test(message)
}

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
  const normalizedName = name.toLowerCase()
  const messageText = message.toLowerCase()
  const match = `${normalizedName}: ${messageText}`

  // Abort names are never retryable; event handling uses the same predicate to
  // cancel recovery before any new prompt can be issued.
  if (isExplicitUserAbortName(name) || normalizedName === "aborterror") return false
  if (normalizedName === "messageoutputlengtherror" || hasAny(match, PERMANENT_PATTERNS)) return false

  if (normalizedName === "apierror") {
    if (statusCode !== undefined) return RETRY_STATUS_CODES.has(statusCode)
    return hasAny(messageText, API_TRANSIENT_MESSAGES) || isConnectionError(match) || isFailedQuery(messageText)
  }

  if (isFailedQuery(messageText)) return true
  if (SQL_ERROR_NAMES.test(name)) return isSqlFailure(messageText)

  return isConnectionError(match)
}

/** User-initiated aborts are deliberate stops, not failures. */
export function isAbortError(error: unknown): boolean {
  const { name } = errorText(error)
  return isExplicitUserAbortName(name) || name.toLowerCase() === "aborterror"
}
