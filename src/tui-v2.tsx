import type { Plugin as V2Plugin } from "@opencode/plugin/tui"
import { createElement, spread } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { isAbortError } from "./matcher"
import { hasPendingUserRequest, panelRow, runningToolOf, textTokensOf, thinkingTokensOf, updateToolTokenCache, type PartLike, type PanelState } from "./tui"
import { turboRpc } from "./v2-rpc"

type Message = ReturnType<V2Plugin.Context["data"]["session"]["message"]["list"]>[number]
type Assistant = Extract<Message, { type: "assistant" }>
type Idle = Extract<Message, { type: "idle" }>
type Content = Assistant["content"][number]
type LocationIdentity = { directory: string; workspaceID?: string }

export function v2PartsOf(message: Pick<Assistant, "content"> | undefined): Content[] {
  return message?.content ?? []
}

/** V2 writes one assistant message per model step; V1 kept a whole turn in one message. */
export type V2Turn = {
  /** First assistant step of the turn: the V1 equivalent of the assistant message start. */
  start?: number
  parts: PartLike[]
  live?: Assistant
  last?: Assistant
  outcome?: Idle["outcome"]
  idleAt?: number
}

export function v2Turn(messages: readonly Message[]): V2Turn {
  const ordered = [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  let lastUser = -1
  for (let index = ordered.length - 1; index >= 0; index--) if (ordered[index].type === "user") { lastUser = index; break }
  const turn = lastUser < 0 ? ordered : ordered.slice(lastUser)
  const assistants = turn.filter((message): message is Assistant => message.type === "assistant")
  let live: Assistant | undefined
  for (let index = assistants.length - 1; index >= 0; index--) if (!assistants[index].time.completed) { live = assistants[index]; break }
  let idle: Idle | undefined
  for (let index = turn.length - 1; index >= 0; index--) if (turn[index].type === "idle") { idle = turn[index] as Idle; break }
  return {
    start: assistants[0]?.time?.created,
    parts: normalizeV2Parts(assistants.flatMap((message) => message.content)),
    live,
    last: assistants.at(-1),
    outcome: idle?.outcome,
    idleAt: idle?.time?.created,
  }
}

export function v2Done(turn: V2Turn): { ms: number; at: string } | undefined {
  const ended = turn.last?.time.completed ?? turn.idleAt
  if (turn.live || !turn.start || ended === undefined || !completedV2Outcome(turn.outcome)) return undefined
  return { ms: ended - turn.start, at: new Date(ended).toLocaleTimeString() }
}

/** V2 abort errors carry `{ type: "aborted" }`; V1 named them MessageAbortedError. */
export function isV2Abort(error: unknown): boolean {
  if (isAbortError(error)) return true
  return typeof error === "object" && error !== null && (error as { type?: unknown }).type === "aborted"
}

export function normalizeV2Parts(parts: Content[]): PartLike[] {
  return parts.map((part) => part.type === "tool" ? {
    ...part,
    tool: part.name,
    callID: part.id,
    state: part.state?.status === "streaming"
      ? { ...part.state, status: "pending", input: {} }
      : part.state,
  } as PartLike : part as PartLike)
}

export function v2Pending(permission: readonly unknown[] | undefined, forms: readonly unknown[] | undefined): boolean {
  return hasPendingUserRequest(permission, forms)
}
export function failedV2Outcome(outcome: Idle["outcome"] | undefined): boolean {
  return outcome === "failed"
}
export function completedV2Outcome(outcome: Idle["outcome"] | undefined): boolean {
  return outcome !== "failed" && outcome !== "interrupted"
}

export type TurboToast = { sessionID: string; title: string; message: string; variant: "info" | "success" | "warning" | "error"; duration: number; location: LocationIdentity }
type TuiLocation = NonNullable<V2Plugin.Context["location"]>
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function matchesToastLocation(envelope: unknown, payload: LocationIdentity, expected: TuiLocation): boolean {
  if (!isRecord(envelope) || typeof envelope.directory !== "string") return false
  return envelope.directory === payload.directory && payload.directory === expected.directory && payload.workspaceID === expected.workspaceID
}
export function parseTurboToast(value: unknown): TurboToast | undefined {
  if (!isRecord(value)) return undefined
  const toast = value
  if (typeof toast.sessionID !== "string" || !toast.sessionID || typeof toast.title !== "string" || typeof toast.message !== "string") return undefined
  if (!isRecord(toast.location) || typeof toast.location.directory !== "string" || !toast.location.directory) return undefined
  const directory = toast.location.directory
  const workspaceID = toast.location.workspaceID
  if (workspaceID !== undefined && typeof workspaceID !== "string") return undefined
  const variant = toast.variant
  if (variant !== "info" && variant !== "success" && variant !== "warning" && variant !== "error") return undefined
  if (typeof toast.duration !== "number" || !Number.isFinite(toast.duration) || toast.duration < 0) return undefined
  const location = workspaceID === undefined ? { directory } : { directory, workspaceID }
  return { sessionID: toast.sessionID, title: toast.title, message: toast.message, variant, duration: toast.duration, location }
}

type Settled = { held?: PanelState; since: number; base: { tool: number; thinking: number; work: number; wait: number } }
export function settledV2Row(state: PanelState, now: number, cache: Settled): string {
  const kind = (s: PanelState) => s.tool ? "tool" : s.thinking > 0 ? "thinking" : s.working ? "working" : s.waiting ? "waiting" : s.done ? "done" : s.failed ? "failed" : "idle"
  if (!cache.held || kind(state) === kind(cache.held) || now - cache.since >= 300) {
    cache.held = state
    cache.since = now
    cache.base = { tool: state.tool?.elapsed ?? 0, thinking: state.thinkingElapsed ?? 0, work: state.workElapsed ?? 0, wait: state.waitElapsed ?? 0 }
    return panelRow(state)
  }
  const delta = now - cache.since
  return panelRow({ ...cache.held, tool: cache.held.tool ? { ...cache.held.tool, elapsed: cache.base.tool + delta } : undefined,
    thinkingElapsed: cache.held.thinkingElapsed === undefined ? undefined : cache.base.thinking + delta,
    workElapsed: cache.held.workElapsed === undefined ? undefined : cache.base.work + delta,
    waitElapsed: cache.held.waitElapsed === undefined ? undefined : cache.base.wait + delta,
    workingSpin: Math.floor(now / 100) % 10 })
}

export function reactiveTextNode(read: () => string, fg?: V2Plugin.Context["theme"]["text"]["muted"]) {
  const node = createElement("text")
  spread(node, () => ({ ...(fg === undefined ? {} : { fg }), children: read }))
  return node
}

function StatusLine(props: { context: V2Plugin.Context; sessionID: () => string }) {
  const [tick, setTick] = createSignal(Date.now())
  const anchors = new Map<string, { start: number; inputRef?: unknown; prompt?: string; tokens?: number; tokenLabel?: "prompt"; initialized?: boolean }>()
  let waitStart = 0
  let workStart = 0
  const settle: Settled = { since: 0, base: { tool: 0, thinking: 0, work: 0, wait: 0 } }
  let disposed = false
  const compute = (): PanelState => {
    const { context } = props
    const sessionID = props.sessionID()
    const now = tick()
    const turn = v2Turn(context.data.session.message.list(sessionID))
    const permission = context.data.session.permission.list(sessionID)
    const location = context.data.session.get(sessionID)?.location ?? context.location
    const forms = context.data.session.form.list(sessionID, location)
    const pending = v2Pending(permission, forms)
    const status = context.data.session.status(sessionID)
    // The cached status can lag after a reload; a step that is still streaming
    // is stronger evidence than a stale "idle", as in V1's message fallback.
    const generating = status === "running" || (turn.live !== undefined && turn.outcome === undefined)
    // Search the whole turn, like V1's single assistant message: tools from an
    // earlier step stay in the turn, so the live step alone is not the whole story.
    const found = !pending && generating ? runningToolOf(turn.parts) : undefined
    let tool: PanelState["tool"]
    if (found) {
      let anchor = anchors.get(found.callID)
      if (!anchor) { anchor = { start: found.start ?? now }; anchors.set(found.callID, anchor) }
      updateToolTokenCache(anchor, found.tool, found.input)
      tool = { name: found.name, elapsed: now - (found.start ?? anchor.start), tokens: anchor.tokens, tokenLabel: anchor.tokenLabel, timeout: found.timeout }
    }
    // Reasoning streams one step at a time; count the whole turn like V1 so the
    // number grows with the response instead of resetting on every step.
    const reasoning = turn.parts.some((p) => p.type === "reasoning" && p.time?.completed === undefined)
    const thinking = !pending && generating && reasoning ? thinkingTokensOf(turn.parts) : 0
    const start = turn.parts.find((p) => p.type === "reasoning")?.time?.created ?? turn.start
    const hasOutput = turn.parts.some((p) => (p.type === "reasoning" || p.type === "text") ? !!p.text?.trim() : p.type === "tool")
    const waiting = pending || (generating && !hasOutput)
    const working = !pending && generating && !tool && thinking === 0 && !waiting
    if (working && !workStart) workStart = now
    if (!working) workStart = 0
    if (waiting && !waitStart) waitStart = now
    if (!waiting) waitStart = 0
    const ended = v2Done(turn)
    const done = !pending && status === "idle" ? ended : undefined
    const terminalFailure = failedV2Outcome(turn.outcome) || (!!turn.last?.error && !isV2Abort(turn.last.error))
    return { tool, thinking, thinkingElapsed: start ? now - start : undefined, waiting, waitElapsed: waitStart ? now - waitStart : undefined, working, workElapsed: working ? now - workStart : undefined, workingSpin: Math.floor(now / 100) % 10, textTokens: working ? textTokensOf(turn.parts) : 0, done, failed: !pending && status === "idle" && terminalFailure }
  }
  const line = createMemo(() => {
    try { return settledV2Row(compute(), tick(), settle) } catch { return "🤖 idle" }
  })
  const refresh = async () => {
    const sessionID = props.sessionID()
    await Promise.allSettled([
      props.context.data.session.message.sync(sessionID),
      props.context.data.session.permission.sync(sessionID),
      props.context.data.session.form.sync(sessionID, props.context.data.session.get(sessionID)?.location ?? props.context.location),
    ])
    if (!disposed && props.sessionID() === sessionID) setTick(Date.now())
  }
  createEffect(() => {
    props.sessionID()
    anchors.clear()
    waitStart = 0
    workStart = 0
    settle.held = undefined
    settle.since = 0
    settle.base = { tool: 0, thinking: 0, work: 0, wait: 0 }
    void refresh()
  })
  const timer = setInterval(() => setTick(Date.now()), 100)
  timer.unref?.()
  const stopEvents = props.context.data.listen(() => setTick(Date.now()))
  onCleanup(() => { disposed = true; clearInterval(timer); stopEvents() })
  return reactiveTextNode(line, props.context.theme.text.muted)
}

export const v2TuiSetup: V2Plugin.Definition["setup"] = (context) => {
  const location = context.location ?? context.data.location.default()
  const stopToast = context.client.rpc(turboRpc).events.on("toast", ({ data, location: eventLocation }) => {
    const toast = parseTurboToast(data)
    if (toast && matchesToastLocation(eventLocation, toast.location, location)) context.ui.toast.show(toast)
  })
  const stopSlot = context.ui.slot({
    append: "sidebar.content",
    render: (slot) => <StatusLine context={context} sessionID={() => slot.sessionID} />,
  })
  return () => { stopToast(); stopSlot() }
}
