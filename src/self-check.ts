// Self-check for opencode-auto-recover matching logic.
// Run with: bun run src/self-check.ts

import { isRecoverable } from "./index.ts"

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

console.log("all checks passed")
