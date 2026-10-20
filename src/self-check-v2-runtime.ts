import { normalizeV2Error, normalizeV2Messages } from "./runtime/recovery"
import { isRecoverable } from "./matcher"
import type { OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { v2Setup } from "./runtime/v2/server"

function check(value: boolean, message: string): void {
  if (!value) throw new Error(`FAIL V2 runtime: ${message}`)
}

for (const [type, message] of [
  ["provider.internal", "Service unavailable"],
  ["provider.rate-limit", "Too Many Requests"],
  ["transport", "Connection reset by peer"],
  ["timeout", "The operation timed out"],
]) {
  check(isRecoverable(normalizeV2Error({ type, message })), `classifies tagged V2 ${type} as transient`)
}
check(!isRecoverable(normalizeV2Error({ type: "provider.rate-limit", message: "Quota exceeded" })), "does not retry exhausted quota")
check(!isRecoverable(normalizeV2Error({ type: "provider.internal", message: "Unauthorized" })), "does not retry authentication failures")
check(!isRecoverable(normalizeV2Error({ type: "provider.internal", message: "Invalid request body" })), "does not retry invalid provider requests")

const messages = normalizeV2Messages("session-1", [
  { id: "u1", type: "user", content: [{ type: "text", text: "continue" }] },
  { id: "a1", type: "assistant", error: { type: "provider.internal", message: "Service unavailable" }, time: { created: 1 }, content: [{ type: "text", text: "partial answer" }] },
  { id: "idle", type: "idle", outcome: "failed", time: { created: 3 } },
])
check(messages.length === 2, "filters V2 idle transcript marker")
check(messages[0]?.info?.role === "user" && messages[0]?.info?.sessionID === "session-1", "attaches role and session ownership")
check(!!messages[1]?.info?.error && (messages[1]?.info?.error as { data?: { statusCode?: number } }).data?.statusCode === 500, "maps provider.internal to a retryable server error")
check(normalizeV2Messages("s", undefined).length === 0, "rejects absent message arrays")
const idleFailure = normalizeV2Messages("s", [{ id: "a2", type: "assistant", time: { created: 4 }, content: [] }, { id: "idle2", type: "idle", outcome: "failed", error: { type: "provider.internal", message: "Service unavailable" }, time: { created: 5 } }])
check(idleFailure.at(-1)?.info?.finish === "error" && !!idleFailure.at(-1)?.info?.error, "attaches V2 idle-marker failure to the last assistant")

const pending: OpenCodeEvent[] = []
let wake: (() => void) | undefined
let aborted = false
const eventFeed = async function* (signal: AbortSignal) {
  while (!signal.aborted) {
    if (pending.length) yield pending.shift()!
    else await new Promise<void>((resolve) => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }) })
  }
  aborted = true
}
const send = (event: object) => { pending.push(event as OpenCodeEvent); wake?.(); wake = undefined }
const sentPrompts: Array<Record<string, unknown>> = []
const rpcEvents: Array<{ name: string; data: unknown }> = []
let registered = false
let rpcDisposed = false
let transcript: unknown[] = [{ id: "u", type: "user", text: "task", time: { created: 1 } }, { id: "a", type: "assistant", error: { type: "provider.internal", message: "Service unavailable" }, time: { created: 2 }, content: [] }]
const startupPermissions = [{ id: "startup-perm", sessionID: "s", action: "edit", resources: [] }]
let sessionGets = 0
let holdPromptSessionGet = false
let resolvePromptSessionGet!: (session: { id: string; parentID?: string; location: { directory: string; workspaceID: string } }) => void
let markPromptSessionGetStarted!: () => void
const promptSessionGetStarted = new Promise<void>((resolve) => { markPromptSessionGetStarted = resolve })
const heldPromptSession = new Promise<{ id: string; parentID?: string; location: { directory: string; workspaceID: string } }>((resolve) => { resolvePromptSessionGet = resolve })
let holdSlowPermissions = true
let resolveSlowPermissions!: (value: Array<{ id: string; sessionID: string; action: string; resources: string[] }>) => void
const slowPermissions = new Promise<Array<{ id: string; sessionID: string; action: string; resources: string[] }>>((resolve) => { resolveSlowPermissions = resolve })
let markSlowPermissionStart!: () => void
const slowPermissionStarted = new Promise<void>((resolve) => { markSlowPermissionStart = resolve })
let expectedContextRead = ""
let markContextRead!: () => void
const priorityContextRead = new Promise<void>((resolve) => { markContextRead = resolve })
let deferNextContextRead = false
let resolveLateInboxRead!: (messages: unknown[]) => void
let markLateInboxReadStarted!: () => void
const lateInboxReadStarted = new Promise<void>((resolve) => { markLateInboxReadStarted = resolve })
const lateInboxRead = new Promise<unknown[]>((resolve) => { resolveLateInboxRead = resolve })
const setupContext = {
  location: { directory: "/project", workspaceID: "workspace-1" }, options: { stallTimeoutMs: 0, emptyOutput: false },
  event: { subscribe: ({ signal }: { signal: AbortSignal }) => eventFeed(signal) },
  rpc: { register: async () => { registered = true; return { dispose: async () => { rpcDisposed = true }, events: { emit: async (name: string, data: unknown) => { rpcEvents.push({ name, data }) } } } } },
  session: {
    get: async ({ sessionID }: { sessionID: string }) => {
      if (holdPromptSessionGet && sessionID === "s") { holdPromptSessionGet = false; markPromptSessionGetStarted(); return heldPromptSession }
      if (++sessionGets === 1) throw new Error("temporary session lookup failure")
      if (sessionGets === 2) return new Promise<never>(() => {})
      return { id: sessionID, parentID: undefined, location: { directory: "/project", workspaceID: "workspace-1" } }
    },
    context: async (_input: { sessionID: string }) => {
      if (_input.sessionID === expectedContextRead) { expectedContextRead = ""; markContextRead() }
      if (deferNextContextRead) { deferNextContextRead = false; markLateInboxReadStarted(); return lateInboxRead }
      return transcript
    },
    prompt: async (input: Record<string, unknown>) => { sentPrompts.push(input); return { id: "inbox" } },
  },
  permission: { list: async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === "slow" && holdSlowPermissions) { markSlowPermissionStart(); return slowPermissions }
    return sessionID === "s" ? startupPermissions : []
  } },
} as unknown as Plugin.Context

const cleanup = await v2Setup(setupContext)
check(registered, "awaits V2 RPC registration")
await new Promise((resolve) => setTimeout(resolve, 20))
const event = (type: string, data: object, directory = "/project", workspaceID = "workspace-1") => ({ type, id: type, created: 1, location: { directory, workspaceID }, data })
send({ type: "session.status", id: "status-1", created: 1, data: { sessionID: "lookup", status: { type: "idle" } } })
await new Promise((resolve) => setTimeout(resolve, 0))
send({ type: "session.status", id: "status-2", created: 2, data: { sessionID: "lookup", status: { type: "idle" } } })
await new Promise((resolve) => setTimeout(resolve, 1_100))
send({ type: "session.status", id: "status-3", created: 3, data: { sessionID: "lookup", status: { type: "idle" } } })
await new Promise((resolve) => setTimeout(resolve, 20))
check(sessionGets === 3, "failed and timed-out ownership lookups are evicted for a later retry")
send(event("session.status", { sessionID: "slow", status: { type: "idle" } }))
await slowPermissionStarted
transcript = [{ id: "u", type: "user", text: "task", time: { created: 1 } }, { id: "done", type: "assistant", finish: "stop", time: { created: 2, completed: 3 }, content: [{ type: "text", text: "done" }] }]
expectedContextRead = "priority"
send(event("session.execution.succeeded", { sessionID: "priority" }))
await Promise.race([priorityContextRead, new Promise((resolve) => setTimeout(resolve, 200))])
check(expectedContextRead === "", "another session's pending-permission snapshot does not block event consumption")
send(event("session.deleted", { sessionID: "slow" }))
holdSlowPermissions = false
resolveSlowPermissions([{ id: "stale-permission", sessionID: "slow", action: "edit", resources: [] }])
await new Promise((resolve) => setTimeout(resolve, 20))
send({ type: "session.created", id: "slow-created", created: 3, data: { sessionID: "slow", location: { directory: "/project", workspaceID: "workspace-1" }, parentID: undefined } })
send(event("session.status", { sessionID: "slow", status: { type: "idle" } }))
await new Promise((resolve) => setTimeout(resolve, 20))
transcript = [{ id: "u", type: "user", text: "task", time: { created: 1 } }, { id: "a", type: "assistant", error: { type: "provider.internal", message: "Service unavailable" }, time: { created: 2 }, content: [] }]
send(event("session.execution.failed", { sessionID: "slow", error: { type: "provider.internal", message: "Service unavailable" } }))
await new Promise((resolve) => setTimeout(resolve, 2_500))
check(sentPrompts.some((prompt) => prompt.sessionID === "slow"), "stale permission snapshot cannot resurrect a deleted session's pending request")
const sessionPromptBase = sentPrompts.length
transcript = [{ id: "u", type: "user", text: "task", time: { created: 1 } }, { id: "a", type: "assistant", error: { type: "provider.internal", message: "Service unavailable" }, time: { created: 2 }, content: [] }]
send(event("session.execution.failed", { sessionID: "foreign", error: { type: "provider.internal", message: "Service unavailable" } }, "/project", "workspace-2"))
send(event("session.status", { sessionID: "s", status: { type: "idle" } }))
send(event("permission.asked", { sessionID: "s", id: "perm-1", action: "edit", resources: [] }))
send(event("form.created", { form: { id: "form-1", sessionID: "s", title: "Confirm", fields: [{ key: "confirm", type: "string" }] } }))
send(event("session.retry.scheduled", { sessionID: "s", assistantMessageID: "a", attempt: 1, at: 1, error: { type: "provider.rate-limit", message: "Too Many Requests" } }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
await new Promise((resolve) => setTimeout(resolve, 650))
check(sentPrompts.length === sessionPromptBase, "pending V2 permission request blocks continuation")
send(event("permission.replied", { sessionID: "s", requestID: "perm-1", reply: "once" }))
send(event("permission.replied", { sessionID: "s", requestID: "startup-perm", reply: "once" }))
await new Promise((resolve) => setTimeout(resolve, 650))
check(sentPrompts.length === sessionPromptBase, "pending V2 form request continues to block recovery after permission replies")
send(event("form.replied", { sessionID: "s", id: "form-1", answer: {} }))
await new Promise((resolve) => setTimeout(resolve, 4_000))
check(sentPrompts.length === sessionPromptBase + 1, "permission reply drains one deduplicated V2 recovery")
check(typeof sentPrompts[sessionPromptBase]?.text === "string" && typeof sentPrompts[sessionPromptBase]?.id === "string", "V2 prompt uses flat id/text admission payload")
check(rpcEvents.some(({ name }) => name === "toast"), "recovery toast is sent over the registered RPC event")
check(rpcEvents.some(({ data }) => (data as { title?: string }).title === "⚠️ Retrying"), "V2 native retry event preserves retry notifications")
check(rpcEvents.some(({ data }) => (data as { location?: { directory?: string; workspaceID?: string } }).location?.workspaceID === "workspace-1"), "toast RPC includes workspace ownership")
deferNextContextRead = true
send(event("session.inbox.delivered", { sessionID: "s", inboxID: "late-user" }))
await lateInboxReadStarted
send(event("session.execution.interrupted", { sessionID: "s", reason: "user" }))
send(event("session.inbox.enqueued", { sessionID: "s", inboxID: "inbox", item: { type: "synthetic", payload: { text: "internal" }, delivery: "queue" } }))
send(event("session.inbox.delivered", { sessionID: "s", inboxID: "inbox" }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
await new Promise((resolve) => setTimeout(resolve, 600))
check(sentPrompts.length === sessionPromptBase + 1, "user interruption fences later automatic recovery")
resolveLateInboxRead([{ id: "late-user", type: "user", text: "stale request", time: { created: 3 } }])
await new Promise((resolve) => setTimeout(resolve, 20))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
await new Promise((resolve) => setTimeout(resolve, 650))
check(sentPrompts.length === sessionPromptBase + 1, "late transcript lookup cannot revive a cancelled inbox delivery")
send(event("session.inbox.enqueued", { sessionID: "s", inboxID: "new-user-message", item: { type: "user", payload: { text: "new request" }, delivery: "queue" } }))
send(event("session.inbox.delivered", { sessionID: "s", inboxID: "new-user-message" }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
holdPromptSessionGet = true
send(event("session.inbox.enqueued", { sessionID: "s", inboxID: "new-user-message", item: { type: "user", payload: { text: "new request" }, delivery: "queue" } }))
send(event("session.inbox.delivered", { sessionID: "s", inboxID: "new-user-message" }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "new turn failure" } }))
await promptSessionGetStarted
send(event("session.execution.interrupted", { sessionID: "s", reason: "user" }))
send(event("session.status", { sessionID: "s", status: { type: "retry", attempt: 7, message: "cancel consumed" } }))
for (let i = 0; i < 30 && !rpcEvents.some(({ data }) => (data as { message?: string }).message?.includes("attempt 7")); i++) await new Promise((resolve) => setTimeout(resolve, 0))
check(rpcEvents.some(({ data }) => (data as { message?: string }).message?.includes("attempt 7")), "event consumer handles cancellation while another prompt lookup is pending")
send(event("session.status", { sessionID: "s", status: { type: "idle" } }))
await new Promise((resolve) => setTimeout(resolve, 20))
resolvePromptSessionGet({ id: "s", location: { directory: "/project", workspaceID: "workspace-1" } })
await new Promise((resolve) => setTimeout(resolve, 50))
check(sentPrompts.length === sessionPromptBase + 1, "interruption during final session lookup prevents prompt admission")
send(event("session.inbox.enqueued", { sessionID: "s", inboxID: "new-user-message-2", item: { type: "user", payload: { text: "new request 2" }, delivery: "queue" } }))
send(event("session.inbox.delivered", { sessionID: "s", inboxID: "new-user-message-2" }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "newer turn failure" } }))
await new Promise((resolve) => setTimeout(resolve, 3_000))
check(sentPrompts.length === sessionPromptBase + 2, "genuine new V2 user message lifts the abort fence")
transcript = [{ id: "u", type: "user", text: "task", time: { created: 1 } }, { id: "empty", type: "assistant", finish: "stop", time: { created: 2, completed: 3 }, content: [] }, { id: "idle", type: "idle", outcome: "succeeded", time: { created: 4 } }]
send(event("session.execution.succeeded", { sessionID: "s" }))
await new Promise((resolve) => setTimeout(resolve, 50))
check(sentPrompts.length === sessionPromptBase + 2, "V2 empty-output option disables silent-success continuation")
send(event("session.moved", { sessionID: "s", location: { directory: "/elsewhere", workspaceID: "workspace-2" }, projectID: "other" }))
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }, "/elsewhere", "workspace-2"))
await new Promise((resolve) => setTimeout(resolve, 50))
check(sentPrompts.length === sessionPromptBase + 2, "session move fences the prior project's recovery handler")
await cleanup?.()
await new Promise((resolve) => setTimeout(resolve, 0))
check(aborted, "cleanup cancels the V2 event subscription")
check(rpcDisposed, "cleanup disposes the registered RPC endpoint")
send(event("session.execution.failed", { sessionID: "s", error: { type: "provider.internal", message: "Service unavailable" } }))
await new Promise((resolve) => setTimeout(resolve, 50))
check(sentPrompts.length === sessionPromptBase + 2, "disposed V2 plugin cannot restart recovery")

console.log("ok: V2 runtime integration")
