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
  /\bconnection\s+(?:(?:is|was|were|has|have|had|been|being|get|gets|got)\s+)*(?:reset|closed|lost|terminated|aborted|ended|refused)\b/i,
  /\b(?:reset|closed|lost|terminated|aborted|ended)\s+(?:the\s+)?(?:connection|stream)\b/i,
  /\breset\s+by\s+peer\b/i,
  /\bunable\s+to\s+connect\b/i,
  /\bcannot\s+connect\s+to\s+host\b/i,
  /\bconnect\s+call\s+failed\b/i,
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
  "authorization",
  "forbidden",
  "access denied",
  "permission denied",
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
]

// These are permanent after the exact Bun false-positive shape is checked.
const CERTIFICATE_PERMANENT_PATTERNS = [
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

function hasAbortIdentifier(identifiers: readonly string[]): boolean {
  return identifiers.some((identifier) => isExplicitUserAbortName(identifier) || identifier.toLowerCase() === "aborterror")
}

function normalizeIdentifier(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase()
}

function hasPermanentIdentifier(identifiers: readonly string[]): boolean {
  const patterns = PERMANENT_PATTERNS.map(normalizeIdentifier)
  return identifiers.some((identifier) => {
    const normalized = normalizeIdentifier(identifier)
    return /\bauth\b/.test(normalized) || hasAny(normalized, patterns)
  })
}

function isConnectionError(text: string): boolean {
  return CONNECTION_PATTERNS.some((pattern) => pattern.test(text))
}

// A bare provider request/stream deadline has no status code and no transport
// noun. Accept only the exact sentence (optionally with a trailing dot); the
// tool-timeout variant carries a hint about a larger timeout and must stay out.
const OPERATION_TIMEOUT = /^the operation timed out\.?$/
const TOOL_TIMEOUT_HINT = "if this command is expected to take longer"

function isOperationTimeout(message: string): boolean {
  const text = message.trim().replace(/\s+/g, " ")
  return OPERATION_TIMEOUT.test(text) && !text.includes(TOOL_TIMEOUT_HINT)
}

function isSqlFailure(message: string): boolean {
  return message.includes("failed to execute statement") || message.includes("database is locked")
}

function isFailedQuery(message: string): boolean {
  return /failed query:\s*(?:select|insert|update|delete|replace|with|create|alter|drop|pragma|begin|commit|rollback|vacuum|attach|detach|reindex|analyze|end|savepoint|release|truncate|merge)\b/.test(message)
}

const TRANSIENT_CERTIFICATE_CODE = "UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"
const TRANSIENT_CERTIFICATE_TEXT = "unknown certificate verification error"
const TRANSIENT_CERTIFICATE_ERROR = `Error: ${TRANSIENT_CERTIFICATE_TEXT}`
const TRANSIENT_CERTIFICATE_FULL = `${TRANSIENT_CERTIFICATE_CODE}: ${TRANSIENT_CERTIFICATE_TEXT}`

function normalizeCertificateText(text: string): string {
  return text.toLowerCase().replace(/[_\s]+/g, " ").trim()
}

function isExactCertificateCode(text: string): boolean {
  return text === TRANSIENT_CERTIFICATE_CODE
}

function isExactCertificateMessage(text: string): boolean {
  return text === TRANSIENT_CERTIFICATE_ERROR || text === TRANSIENT_CERTIFICATE_FULL
}

function isTransientCertificateNetworkError(name: string, identifiers: readonly string[], message: string, dataMessage?: string): boolean {
  const hasExactIdentifier = identifiers.some(isExactCertificateCode)
  const isOpenCodeFallback = name === "UnknownError" && (dataMessage === TRANSIENT_CERTIFICATE_TEXT || dataMessage === TRANSIENT_CERTIFICATE_ERROR)
  if (!hasExactIdentifier && !isOpenCodeFallback) return false
  return message === TRANSIENT_CERTIFICATE_TEXT || isExactCertificateMessage(message)
}

function isPermanentCertificateCode(code: string | undefined): boolean {
  if (!code || isExactCertificateCode(code)) return false
  const normalized = normalizeCertificateText(code)
  return /(?:certificate|cert|self signed|issuer|tls|ssl|verify)/.test(normalized)
}

function hasPermanentCertificateIdentifier(identifiers: readonly string[]): boolean {
  return identifiers.some(isPermanentCertificateCode)
}

function hasExactCertificateIdentifier(identifiers: readonly string[]): boolean {
  return identifiers.some(isExactCertificateCode)
}

function normalizeMessageName(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : ""
}

export function errorText(error: unknown): { name: string; message: string; dataMessage?: string; statusCode?: number; code?: string; identifiers: string[] } {
  if (!error || typeof error !== "object") return { name: "", message: "", identifiers: [] }
  const e = error as Record<string, unknown>
  const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<string, unknown>
  const nestedName = normalizeMessageName(data.name)
  const name = normalizeMessageName(e.name) || nestedName
  const identifiers = [normalizeMessageName(e.name), nestedName, normalizeMessageName(e.code), normalizeMessageName(data.code)].filter((value): value is string => value.length > 0)
  const dataMessage = typeof data.message === "string" ? data.message : undefined
  const message =
    dataMessage ??
    (typeof e.message === "string" ? e.message : "")
  const statusCode =
    typeof data.statusCode === "number"
      ? data.statusCode
      : typeof e.statusCode === "number"
        ? e.statusCode
        : undefined
  const code = normalizeMessageName(e.code) || normalizeMessageName(data.code) || nestedName || undefined
  return { name, message, dataMessage, statusCode, code, identifiers }
}

/** Decide whether an error is worth recovering from. */
export function isRecoverable(error: unknown): boolean {
  const { name, message, dataMessage, statusCode, identifiers } = errorText(error)
  const normalizedName = name.toLowerCase()
  const messageText = message.toLowerCase()
  const match = `${normalizedName}: ${messageText}`
  const isAPIError = normalizedName === "apierror" || identifiers.some((identifier) => identifier.toLowerCase() === "apierror")

  // Abort names are never retryable; event handling uses the same predicate to
  // cancel recovery before any new prompt can be issued.
  if (hasAbortIdentifier(identifiers)) return false
  if (isAPIError && statusCode !== undefined && !RETRY_STATUS_CODES.has(statusCode)) return false
  if (hasPermanentCertificateIdentifier(identifiers)) return false
  if (hasPermanentIdentifier(identifiers)) return false
  if (isTransientCertificateNetworkError(name, identifiers, message, dataMessage)) return true
  if (hasExactCertificateIdentifier(identifiers)) return false
  if (normalizedName === "messageoutputlengtherror" || hasAny(match, PERMANENT_PATTERNS)) return false
  if (hasAny(match, CERTIFICATE_PERMANENT_PATTERNS)) return false

  if (isAPIError) {
    if (statusCode !== undefined) return RETRY_STATUS_CODES.has(statusCode)
    return hasAny(messageText, API_TRANSIENT_MESSAGES) || isConnectionError(match) || isFailedQuery(messageText)
  }

  if (isFailedQuery(messageText)) return true
  if (SQL_ERROR_NAMES.test(name)) return isSqlFailure(messageText)

  return isConnectionError(match) || isOperationTimeout(messageText)
}

/** User-initiated aborts are deliberate stops, not failures. */
export function isAbortError(error: unknown): boolean {
  return hasAbortIdentifier(errorText(error).identifiers)
}
