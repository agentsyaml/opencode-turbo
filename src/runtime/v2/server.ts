import type { OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import type { Hooks, Plugin as V1Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin"
import type { Event as V1Event } from "@opencode-ai/sdk"
import { normalizeV2Error, normalizeV2Messages } from "../recovery"
import { turboRpc } from "../../v2-rpc"
import entry from "../../index"

type LegacyEvent = { type: string; properties: Record<string, unknown> }
type Scope = { directory: string; workspaceID?: string }
const scopeOf = (location: Scope | undefined): Scope | undefined => location?.directory ? location : undefined
const sameScope = (left: Scope | undefined, right: Scope | undefined) => !!left && !!right && left.directory === right.directory && left.workspaceID === right.workspaceID

function sessionOf(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "session.created":
    case "session.moved":
    case "session.deleted":
    case "session.status":
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.retry.scheduled":
    case "session.inbox.delivered":
    case "session.inbox.enqueued":
    case "session.text.started":
    case "session.text.delta":
    case "session.text.ended":
    case "session.reasoning.started":
    case "session.reasoning.delta":
    case "session.reasoning.ended":
    case "session.tool.called":
    case "session.tool.progress":
    case "session.tool.success":
    case "session.tool.failed":
    case "permission.asked":
    case "permission.replied":
    case "form.replied":
    case "form.cancelled":
      return event.data.sessionID
    case "form.created":
      return event.data.form.sessionID
    default:
      return undefined
  }
}

function eventScope(event: OpenCodeEvent): Scope | undefined {
  if (event.type === "session.created" || event.type === "session.moved") return scopeOf(event.data.location)
  return "location" in event ? scopeOf(event.location) : undefined
}

function legacyEvents(event: OpenCodeEvent): LegacyEvent[] {
  switch (event.type) {
    case "session.created":
      return [{ type: event.type, properties: { info: { id: event.data.sessionID, parentID: event.data.parentID } } }]
    case "session.deleted":
      return [{ type: event.type, properties: { info: { id: event.data.sessionID } } }]
    case "session.status":
      return [{ type: event.type, properties: { sessionID: event.data.sessionID, status: event.data.status } }]
    case "session.retry.scheduled":
      return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: { type: "retry", attempt: event.data.attempt, message: event.data.error.message } } }]
    case "session.execution.started":
      return [{ type: "session.status", properties: { sessionID: event.data.sessionID, status: { type: "busy" } } }]
    case "session.execution.failed":
      return [{ type: "session.error", properties: { sessionID: event.data.sessionID, error: normalizeV2Error(event.data.error) } }]
    case "session.execution.interrupted":
      return [{ type: "session.error", properties: { sessionID: event.data.sessionID, error: new DOMException(event.data.reason, "AbortError") } }]
    case "session.inbox.delivered":
      return []
    case "session.text.started":
    case "session.text.delta":
      return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { type: "text", text: "", messageID: event.data.assistantMessageID } } }]
    case "session.reasoning.started":
    case "session.reasoning.delta":
      return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { type: "reasoning", text: "", messageID: event.data.assistantMessageID } } }]
    case "session.tool.called":
      return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { type: "tool", id: event.data.id, callID: event.data.id, name: "tool", messageID: event.data.assistantMessageID, state: { status: "running", input: event.data.input } } } }]
    case "session.tool.success":
      return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { type: "tool", id: event.data.id, callID: event.data.id, messageID: event.data.assistantMessageID, state: { status: "completed" } } } }]
    case "session.tool.failed":
      return [{ type: "message.part.updated", properties: { sessionID: event.data.sessionID, part: { type: "tool", id: event.data.id, callID: event.data.id, messageID: event.data.assistantMessageID, state: { status: "error" } } } }]
    case "permission.asked":
      return [{ type: event.type, properties: { ...event.data, requestID: event.data.id } }]
    case "permission.replied":
      return [{ type: event.type, properties: event.data }]
    case "form.created":
      return [{ type: "question.asked", properties: { ...event.data.form, id: event.data.form.id } }]
    case "form.replied":
    case "form.cancelled":
      return [{ type: event.type === "form.replied" ? "question.replied" : "question.rejected", properties: { ...event.data, requestID: event.data.id } }]
    default:
      return []
  }
}

export const v2Setup: Plugin.Plugin["setup"] = async (context: Plugin.Context) => {
  const owner = scopeOf(context.location)
  const statuses = new Map<string, { type: string }>()
  const executionEpochs = new Map<string, number>()
  const ownershipEpochs = new Map<string, number>()
  const scopes = new Map<string, Scope>()
  const rememberedSessions = new Set<string>()
  const inboxKinds = new Map<string, { sessionID: string; type: "user" | "synthetic" | "compaction" | "move" }>()
  const recoveryPrompts = new Map<string, Map<string, string>>()
  const pendingRecoveryPrompts = new Map<string, Map<string, string>>()
  const deliveredRecoveryPrompts = new Map<string, string>()
  const resolvedPermissions = new Set<string>()
  const permissionSnapshots = new Set<string>()
  const unknownPermissions = new Set<string>()
  const scopeLookups = new Map<string, Promise<Scope | undefined>>()
  const lookupScope = (sessionID: string): Promise<Scope | undefined> => {
    let lookup = scopeLookups.get(sessionID)
    if (!lookup) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_000); timer.unref?.() })
      lookup = Promise.race([context.session.get({ sessionID }).then((session) => scopeOf(session.location)).catch(() => undefined), timeout]).finally(() => { if (timer) clearTimeout(timer) })
      scopeLookups.set(sessionID, lookup)
      const pending = lookup
      void pending.then((scope) => {
        if (!scope && scopeLookups.get(sessionID) === pending) scopeLookups.delete(sessionID)
      }, () => {
        if (scopeLookups.get(sessionID) === pending) scopeLookups.delete(sessionID)
      })
    }
    return lookup
  }
  const rpc = await context.rpc.register(turboRpc, {})
  const client = {
    session: {
      get: async ({ path }: { path: { id: string } }) => ({ data: await context.session.get({ sessionID: path.id }) }),
      messages: async ({ path }: { path: { id: string } }) => ({ data: normalizeV2Messages(path.id, await context.session.context({ sessionID: path.id })) }),
      status: async () => ({ data: Object.fromEntries([...statuses].filter(([sessionID]) => !unknownPermissions.has(sessionID))) }),
      prompt: async ({ path, body }: { path: { id: string }; body: { messageID: string; parts: Array<{ type: string; text?: string; url?: string; filename?: string }> } }) => {
        const executionEpoch = executionEpochs.get(path.id)
        const ownershipEpoch = ownershipEpochs.get(path.id) ?? 0
        const currentScope = scopes.get(path.id)
        if (controller.signal.aborted || !sameScope(owner, currentScope)) throw new DOMException("Session ownership changed", "AbortError")
        const session = await context.session.get({ sessionID: path.id })
        const latestScope = scopes.get(path.id)
        const sessionWorkspaceID = "workspaceID" in session.location && typeof session.location.workspaceID === "string" ? session.location.workspaceID : currentScope?.workspaceID
        const liveScope = { directory: session.location.directory, workspaceID: sessionWorkspaceID }
        if (controller.signal.aborted || executionEpochs.get(path.id) !== executionEpoch || (ownershipEpochs.get(path.id) ?? 0) !== ownershipEpoch || !sameScope(owner, latestScope) || !sameScope(currentScope, latestScope) || !sameScope(owner, liveScope)) throw new DOMException("Session ownership changed", "AbortError")
        if (unknownPermissions.has(path.id) || statuses.get(path.id)?.type !== "idle") throw { name: "APIError", data: { message: "Session is not idle or pending requests are unknown", statusCode: 409 } }
        const text = body.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
        const files = body.parts.filter((part) => part.type === "file" && part.url).map((part) => ({ uri: part.url!, name: part.filename }))
        const ids = recoveryPrompts.get(path.id) ?? new Map<string, string>()
        ids.set(body.messageID, body.messageID)
        recoveryPrompts.set(path.id, ids)
        const pending = pendingRecoveryPrompts.get(path.id) ?? new Map<string, string>()
        pending.set(body.messageID, text)
        pendingRecoveryPrompts.set(path.id, pending)
        try {
          const admitted = await context.session.prompt({ sessionID: path.id, id: body.messageID, text, files })
          if (pendingRecoveryPrompts.get(path.id) === pending && pending.has(body.messageID)) ids.set(admitted.id, body.messageID)
          inboxKinds.set(admitted.id, { sessionID: path.id, type: "user" })
          pending.delete(body.messageID)
          if (!pending.size) pendingRecoveryPrompts.delete(path.id)
          return { data: admitted }
        } catch (error) {
          pending.delete(body.messageID)
          if (!pending.size) pendingRecoveryPrompts.delete(path.id)
          for (const [inboxID, promptID] of ids) if (promptID === body.messageID) ids.delete(inboxID)
          if (!ids.size) recoveryPrompts.delete(path.id)
          throw normalizeV2Error(error)
        }
      },
    },
    tui: { showToast: async () => ({}) },
  } as unknown as PluginInput["client"]
  const sender = (sessionID: string, toast: object) => rpc.events.emit("toast", { ...toast, sessionID, location: owner! })
  const options = { ...context.options, notificationSender: sender, statusRequired: true } as PluginOptions
  const hooks = await (entry.server as V1Plugin)({ client } as PluginInput, options) as Hooks
  const controller = new AbortController()
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    controller.abort()
    recoveryPrompts.clear()
    pendingRecoveryPrompts.clear()
    deliveredRecoveryPrompts.clear()
    permissionSnapshots.clear()
    resolvedPermissions.clear()
    unknownPermissions.clear()
    inboxKinds.clear()
    scopes.clear()
    executionEpochs.clear()
    ownershipEpochs.clear()
    scopeLookups.clear()
    try { await hooks.dispose?.() }
    finally { await rpc.dispose() }
  }
  const deliverUserInbox = async (sessionID: string, inboxID: string, promptID?: string) => {
    if (controller.signal.aborted || !sameScope(owner, scopes.get(sessionID))) return
    await hooks.event?.({ event: { type: "message.updated", properties: { info: { id: promptID ?? inboxID, sessionID, role: "user" } } } as unknown as V1Event })
    if (promptID) deliveredRecoveryPrompts.set(sessionID, promptID)
    else { recoveryPrompts.delete(sessionID); pendingRecoveryPrompts.delete(sessionID); deliveredRecoveryPrompts.delete(sessionID) }
  }
  const snapshotSessionPermissions = (sessionID: string) => {
    if (permissionSnapshots.has(sessionID)) return
    permissionSnapshots.add(sessionID)
    unknownPermissions.add(sessionID)
    const requestScope = scopes.get(sessionID)
    const requestEpoch = ownershipEpochs.get(sessionID) ?? 0
    const current = () => !controller.signal.aborted && (ownershipEpochs.get(sessionID) ?? 0) === requestEpoch && sameScope(requestScope, scopes.get(sessionID))
    void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1_000); timer.unref?.() })
    const requests = await Promise.race([context.permission.list({ sessionID }).catch(() => undefined), timeout])
    if (timer) clearTimeout(timer)
    if (!current()) return
    if (!requests) { permissionSnapshots.delete(sessionID); return }
    unknownPermissions.delete(sessionID)
    for (const request of requests) {
      if (!current() || resolvedPermissions.has(`${sessionID}:${request.id}`)) continue
      await hooks.event?.({ event: { type: "permission.asked", properties: { ...request, requestID: request.id } } as unknown as V1Event })
    }
    })().catch(() => { if (current()) permissionSnapshots.delete(sessionID) })
  }
  const consume = async () => {
    try {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        const sessionID = sessionOf(event)
        if (!sessionID) continue
        const scope = eventScope(event) ?? scopes.get(sessionID) ?? await lookupScope(sessionID)
        if (event.type === "session.moved") {
          ownershipEpochs.set(sessionID, (ownershipEpochs.get(sessionID) ?? 0) + 1)
          const previousScope = scopes.get(sessionID) ?? ("location" in event ? scopeOf(event.location) : undefined)
          if (sameScope(owner, previousScope) && !sameScope(owner, scope)) {
            await hooks.event?.({ event: { type: "session.deleted", properties: { info: { id: sessionID } } } as unknown as V1Event })
          }
          if (sameScope(owner, scope)) {
            scopes.set(sessionID, scope!)
            rememberedSessions.add(sessionID)
            void context.session.get({ sessionID }).then((session) => {
              if (!controller.signal.aborted && sameScope(owner, scopes.get(sessionID))) return hooks.event?.({ event: { type: "session.created", properties: { info: { id: sessionID, parentID: session.parentID } } } as unknown as V1Event })
            }).catch(() => { rememberedSessions.delete(sessionID) })
          } else { scopes.delete(sessionID); rememberedSessions.delete(sessionID); scopeLookups.delete(sessionID) }
          statuses.delete(sessionID); executionEpochs.delete(sessionID); permissionSnapshots.delete(sessionID); unknownPermissions.delete(sessionID); recoveryPrompts.delete(sessionID); pendingRecoveryPrompts.delete(sessionID); deliveredRecoveryPrompts.delete(sessionID)
          for (const [inboxID, inbox] of inboxKinds) if (inbox.sessionID === sessionID) inboxKinds.delete(inboxID)
          continue
        }
        if (!sameScope(owner, scope)) continue
        scopes.set(sessionID, scope!)
        if (event.type === "session.status" || event.type === "session.execution.started" || event.type === "session.execution.failed" || event.type === "session.execution.succeeded" || event.type === "session.retry.scheduled") snapshotSessionPermissions(sessionID)
        const converted = legacyEvents(event)
        if (event.type === "session.status") statuses.set(sessionID, { type: event.data.status.type })
        if (event.type === "session.execution.started") { statuses.set(sessionID, { type: "running" }); executionEpochs.set(sessionID, (executionEpochs.get(sessionID) ?? 0) + 1) }
        if (event.type === "session.retry.scheduled") statuses.set(sessionID, { type: "retry" })
        if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          statuses.set(sessionID, { type: "idle" }); executionEpochs.set(sessionID, (executionEpochs.get(sessionID) ?? 0) + 1)
        }
        if (event.type === "session.deleted") {
          ownershipEpochs.set(sessionID, (ownershipEpochs.get(sessionID) ?? 0) + 1)
          statuses.delete(sessionID); executionEpochs.delete(sessionID); permissionSnapshots.delete(sessionID); unknownPermissions.delete(sessionID); scopes.delete(sessionID); scopeLookups.delete(sessionID); rememberedSessions.delete(sessionID); recoveryPrompts.delete(sessionID); pendingRecoveryPrompts.delete(sessionID); deliveredRecoveryPrompts.delete(sessionID)
          for (const [inboxID, inbox] of inboxKinds) if (inbox.sessionID === sessionID) inboxKinds.delete(inboxID)
        }
        if (event.type === "permission.replied") resolvedPermissions.add(`${sessionID}:${event.data.requestID}`)
        if (event.type === "session.inbox.enqueued") {
          inboxKinds.set(event.data.inboxID, { sessionID, type: event.data.item.type })
          if (event.data.item.type === "user") {
            executionEpochs.set(sessionID, (executionEpochs.get(sessionID) ?? 0) + 1)
            const pending = pendingRecoveryPrompts.get(sessionID)
            if (pending) {
              const payloadText = event.data.item.payload.text
              const match = [...pending].find(([, text]) => text === payloadText)
              if (match) recoveryPrompts.get(sessionID)?.set(event.data.inboxID, match[0])
            }
          }
        }
        if (event.type === "session.created") rememberedSessions.add(sessionID)
        if ((event.type === "session.execution.started" || event.type === "session.status" && event.data.status.type !== "idle") && !rememberedSessions.has(sessionID)) {
          rememberedSessions.add(sessionID)
          void context.session.get({ sessionID }).then((session) => {
            if (!controller.signal.aborted && sameScope(owner, scopes.get(sessionID))) return hooks.event?.({ event: { type: "session.updated", properties: { info: { id: sessionID, parentID: session.parentID } } } as unknown as V1Event })
          }).catch(() => { rememberedSessions.delete(sessionID) })
        }
        for (const item of converted) await hooks.event?.({ event: item as unknown as V1Event })
        if (event.type === "session.execution.interrupted" || event.type === "session.deleted") {
          recoveryPrompts.delete(sessionID); pendingRecoveryPrompts.delete(sessionID); deliveredRecoveryPrompts.delete(sessionID)
        }
        if (event.type === "session.inbox.delivered") {
          const queued = inboxKinds.get(event.data.inboxID)
          inboxKinds.delete(event.data.inboxID)
          if (queued?.sessionID === sessionID && queued.type === "user") {
            executionEpochs.set(sessionID, (executionEpochs.get(sessionID) ?? 0) + 1)
            await deliverUserInbox(sessionID, event.data.inboxID, recoveryPrompts.get(sessionID)?.get(event.data.inboxID))
          }
          else if (!queued) {
            const deliveryEpoch = (executionEpochs.get(sessionID) ?? 0) + 1
            executionEpochs.set(sessionID, deliveryEpoch)
            void context.session.context({ sessionID }).then((messages) => {
              if (controller.signal.aborted || executionEpochs.get(sessionID) !== deliveryEpoch || !sameScope(owner, scopes.get(sessionID))) return
              if (messages.some((message) => message.id === event.data.inboxID && message.type === "user")) return deliverUserInbox(sessionID, event.data.inboxID, recoveryPrompts.get(sessionID)?.get(event.data.inboxID))
            }).catch(() => {})
          }
        }
        if (event.type === "session.execution.succeeded") {
          const epoch = executionEpochs.get(sessionID)
          void context.session.context({ sessionID }).then(async (transcript) => {
            if (controller.signal.aborted || executionEpochs.get(sessionID) !== epoch || statuses.get(sessionID)?.type !== "idle") return
            const info = normalizeV2Messages(sessionID, transcript).at(-1)?.info
            const promptID = deliveredRecoveryPrompts.get(sessionID)
            recoveryPrompts.delete(sessionID)
            deliveredRecoveryPrompts.delete(sessionID)
            if (info?.role === "assistant") await hooks.event?.({ event: { type: "message.updated", properties: { info: { ...info, parentID: promptID } } } as unknown as V1Event })
          }).catch(() => {})
        }
      }
      await stop()
    } catch (error) {
      if (controller.signal.aborted || stopped) return
      await stop()
      console.error("opencode-turbo V2 event stream stopped", error)
    }
  }
  void consume()
  return async () => {
    await stop()
  }
}
