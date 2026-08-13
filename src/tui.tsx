// TUI status line for opencode-turbo.
//
// Renders ONE persistent status line into the sidebar via the `sidebar_content`
// slot, showing the current activity in priority order: running tool with
// elapsed time, thinking token count, writing token count (working included),
// waiting, and the last completed turn. One line only — the state never jumps
// between rows.
//
// Update model (mirrors the working Tarquinen/oc-tps plugin): capture the
// native text renderable via a ref, MUTATE its `.content` directly on every
// state change, then call `api.renderer.requestRender()`. This bypasses solid
// reactivity entirely — it works regardless of which solid instance the host
// reconciler uses, because the renderable ref belongs to the host renderer.

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { onCleanup } from "solid-js"
import { estimateTokens, formatDuration } from "./util"

type PartLike = {
  id?: string
  callID?: string
  type?: string
  text?: string
  tool?: string
  name?: string
  state?: { status?: string; title?: string; time?: { start?: number; end?: number } }
  // Tolerates both the v1 Part shape (time.start/end) and v2 (created/ran/completed).
  time?: { start?: number; end?: number; created?: number; ran?: number; completed?: number }
}

type MessageLike = {
  id?: string
  type?: string
  role?: string
  error?: unknown
  finish?: string
  time?: { created?: number; completed?: number }
}

/** Last assistant message (v2 `type` / v1 `role`). Pure, exported for self-check. */
export function lastAssistantOf(messages: MessageLike[] | undefined): MessageLike | undefined {
  const list = messages ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    const role = m.type ?? m.role
    if (role === "assistant") return m
  }
  return undefined
}

/** Estimated token count of a message's reasoning parts. Pure, exported for self-check. */
export function thinkingTokensOf(parts: PartLike[] | undefined): number {
  const list = parts ?? []
  return list
    .filter((p) => p.type === "reasoning" && typeof p.text === "string")
    .reduce((sum, p) => sum + estimateTokens(p.text as string), 0)
}

/** Estimated token count of a message's text parts. Pure, exported for self-check. */
export function textTokensOf(parts: PartLike[] | undefined): number {
  const list = parts ?? []
  return list
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .reduce((sum, p) => sum + estimateTokens(p.text as string), 0)
}

/** The currently running or preparing tool. Pure, exported for self-check. */
export function runningToolOf(parts: PartLike[] | undefined): { name: string; callID: string; start?: number } | undefined {
  const list = parts ?? []
  const part = [...list]
    .reverse()
    .find((p) => p.type === "tool" && (p.state?.status === "running" || p.state?.status === "pending"))
  if (!part) return undefined
  // NOTE: this build's TUI store carries tool time as {start} where `start` is
  // updated on EVERY progress event — not a stable anchor. Prefer the schema's
  // created/ran fields when present; otherwise the panel anchors on first sight.
  return {
    name: part.state?.title ?? part.tool ?? part.name ?? "tool",
    callID: part.callID ?? part.id ?? "",
    start: part.time?.ran ?? part.time?.created,
  }
}

/** Completion info of an assistant message. Pure, exported for self-check. */
export function completionOf(message: MessageLike | undefined): { ms: number; at: string } | undefined {
  const completed = message?.time?.completed
  if (!completed || message?.error) return undefined
  const ms = message.time?.created ? completed - message.time.created : 0
  return { ms, at: new Date(completed).toLocaleTimeString() }
}

// ── Line mapping ────────────────────────────────────────────────────────────

export interface PanelState {
  tool?: { name: string; elapsed: number }
  thinking: number
  thinkingElapsed?: number
  waiting: boolean
  waitElapsed?: number
  working: boolean
  textTokens: number
  done?: { ms: number; at: string }
}

/**
 * One status line for the current state, in priority order:
 * tool > thinking > writing (working included) > waiting > done > idle.
 * Pure and exported so every display phase is command-verifiable.
 */
export function panelRow(state: PanelState): string {
  const { tool, thinking, thinkingElapsed, waiting, waitElapsed, working, textTokens, done } = state
  if (tool) return `🔧 ${tool.name} · ${formatDuration(tool.elapsed)}`
  if (thinking > 0) {
    const suffix = thinkingElapsed !== undefined ? ` · ${formatDuration(thinkingElapsed)}` : ""
    return `🤔 Thinking · ${thinking.toLocaleString()} tokens${suffix}`
  }
  if (working) return `✍️ Writing · ${textTokens.toLocaleString()} tokens`
  if (waiting) {
    const suffix = waitElapsed !== undefined ? ` · ${formatDuration(waitElapsed)}` : ""
    return `⏳ Waiting${suffix}`
  }
  if (done) return `✅ Done · ${formatDuration(done.ms)} · ${done.at}`
  return "🤖 idle"
}

/** A text renderable captured via ref (native host object). */
type TextRenderable = { content: string | number }

function StatusPanel(props: { api: TuiPluginApi; session_id: string }) {
  let statusText: TextRenderable | undefined
  let lastLine = ""
  // Waiting-phase anchor: the waiting timer starts when the panel ENTERS the
  // waiting state — never from a message timestamp (a new user message can lag
  // the store sync, which used to make the wait accumulate from a stale value).
  let lastWaitStart = 0
  // Stable anchors for tool elapsed: the store's tool `time.start` updates on
  // every progress event, so anchor elapsed to the FIRST time the panel sees
  // each tool call active. ponytail: map grows one entry per tool call per
  // panel — clear it if a long-lived session ever shows memory growth.
  const toolAnchors = new Map<string, number>()

  const compute = () => {
    const now = Date.now()
    const messages = props.api.state.session.messages(props.session_id) as unknown as MessageLike[] | undefined
    const list = messages ?? []

    // The store's message list ordering is not guaranteed; derive recency from
    // time.created instead (order-independent).
    const byNewest = [...list].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
    const newest = byNewest[0]
    const newestIsUser = (newest?.type ?? newest?.role) === "user"
    // Prefer the LIVE (unfinished) assistant — a stale finished one (previous
    // turn, interrupted turn, or subagent) must not drive the live state.
    // NOTE: `finish` is NOT a completion signal — a multi-step turn sets
    // finish: "tool-calls" between segments while still generating. Only
    // time.completed or an error marks the message truly done.
    const isAssistant = (m: MessageLike) => (m.type ?? m.role) === "assistant"
    const live = byNewest.find((m) => isAssistant(m) && !m.time?.completed && !m.error)
    const assistant = live ?? (newestIsUser ? undefined : byNewest.find(isAssistant))
    const parts = assistant?.id ? (props.api.state.part(assistant.id) as unknown as PartLike[] | undefined) : undefined

    // Session status is an OBJECT at runtime ({type: "busy" | "idle" | "retry"}).
    // busy = generating; idle/retry = not (handles interruption). Fall back to
    // message-derived detection when the status is absent from the store.
    const statusType = (props.api.state.session.status(props.session_id) as { type?: string } | undefined)?.type
    const assistantFinished = !!assistant && (!!assistant.time?.completed || !!assistant.error)
    let generating: boolean
    if (statusType === "busy") generating = true
    else if (statusType === "idle" || statusType === "retry") generating = false
    else generating = newestIsUser || (!!assistant && !assistantFinished)

    const found = generating ? runningToolOf(parts) : undefined
    let tool: PanelState["tool"]
    if (found) {
      let start = found.start
      if (start === undefined) {
        start = toolAnchors.get(found.callID)
        if (start === undefined) {
          start = now
          toolAnchors.set(found.callID, start)
        }
      }
      tool = { name: found.name, elapsed: now - start }
    }

    // Thinking only while the reasoning is still streaming. The counter stops
    // once the reasoning part's end/completed is set or the message finishes.
    const reasoningActive =
      generating &&
      !assistantFinished &&
      (parts?.some(
        (p) => p.type === "reasoning" && p.time?.end === undefined && p.time?.completed === undefined,
      ) ?? false)
    const thinking = reasoningActive ? thinkingTokensOf(parts) : 0
    const firstReasoning = parts?.find((p) => p.type === "reasoning")
    const reasoningStart = firstReasoning?.time?.start ?? firstReasoning?.time?.created
    const thinkingStart = typeof reasoningStart === "number" && reasoningStart > 0 ? reasoningStart : assistant?.time?.created

    // Waiting = the FIRST-response phase: from the user's message until the
    // model's first visible output (reasoning text / tool call / text).
    const hasOutput =
      (parts?.some((p) =>
        (p.type === "reasoning" && (p.text ?? "").trim().length > 0) ||
        p.type === "tool" ||
        (p.type === "text" && (p.text ?? "").trim().length > 0),
      ) ?? false)
    const waiting = generating && !hasOutput
    // Working = generating with output already, but between phases (tool prep,
    // next step) — never show idle while the model is actively working.
    const working = generating && !tool && thinking === 0 && !waiting
    const textTokens = working ? textTokensOf(parts) : 0

    // Waiting timer anchored to phase entry; resets whenever waiting exits.
    if (waiting && lastWaitStart === 0) lastWaitStart = now
    if (!waiting) lastWaitStart = 0
    const waitElapsed = waiting && lastWaitStart > 0 ? now - lastWaitStart : undefined
    // Done ONLY when the session status is explicitly "idle" — a multi-step
    // turn sets the message's time.completed per segment (mid-turn!), so the
    // message state alone can never prove the turn ended.
    const done = statusType === "idle" && assistantFinished && !newestIsUser ? completionOf(assistant) : undefined

    return {
      tool,
      thinking,
      thinkingElapsed: typeof thinkingStart === "number" && thinkingStart > 0 ? now - thinkingStart : undefined,
      waiting,
      waitElapsed,
      working,
      textTokens,
      done,
    }
  }

  // State settle: a state must persist for STATE_SETTLE_MS before it is shown;
  // until then the previous line stays. This kills flicker through short-lived
  // phases right after a tool completes (bash -> waiting -> thinking chains):
  // only states that genuinely last get rendered. In-row updates (token counts,
  // durations) still refresh on every tick via change detection.
  const STATE_SETTLE_MS = 300
  const TICK_MS = 100
  let shownRow = ""
  let candidateRow = ""
  let candidateSince = 0

  const sync = () => {
    // compute() runs on the host's render path (ref callbacks run inside the
    // reconciler's mount phase) — any throw must never take down the TUI.
    try {
      const { tool, thinking, thinkingElapsed, waiting, waitElapsed, working, textTokens, done } = compute()
      const activeRow = tool
        ? "tool"
        : thinking > 0
          ? "thinking"
          : working
            ? "working"
            : waiting
              ? "waiting"
              : done
                ? "done"
                : "idle"
      const nowMs = Date.now()
      if (activeRow !== candidateRow) {
        candidateRow = activeRow
        candidateSince = nowMs
      }
      if (candidateRow !== shownRow && nowMs - candidateSince < STATE_SETTLE_MS) {
        return // settling: keep showing the previous line until the new state persists
      }
      shownRow = candidateRow

      const next = panelRow({ tool, thinking, thinkingElapsed, waiting, waitElapsed, working, textTokens, done })
      if (next === lastLine) return // nothing changed — no repaint
      lastLine = next
      if (statusText) statusText.content = next
      props.api.renderer.requestRender()
    } catch {
      // rendering must never break the plugin
    }
  }

  const theme = props.api.theme.current

  // Heartbeat: fine tick (in-row refresh) + session events (both gated above).
  const timer = setInterval(sync, TICK_MS)
  timer.unref?.()
  const offs = [
    props.api.event.on("message.part.updated", sync),
    props.api.event.on("message.updated", sync),
  ]
  onCleanup(() => {
    for (const off of offs) off()
    clearInterval(timer)
  })

  return (
    // sidebar slot roots must be stable; a conditional root never mounts
    <box>
      <text ref={(ref: unknown) => { statusText = ref as TextRenderable; sync() }} fg={theme.textMuted} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 150, // distinct from built-ins (context 100, mcp 200, lsp 300, todo 400, files 500)
    slots: {
      sidebar_content(_ctx, props) {
        return <StatusPanel api={api} session_id={props.session_id} />
      },
    },
  })
}

// File-based (path) plugins MUST export a non-empty `id` — the TUI runtime
// rejects path plugins without one (resolvePluginId throws "Path plugin ...
// must export id"), dropping the plugin before tui() is ever called.
const plugin: TuiPluginModule = { id: "opencode-turbo", tui }

export default plugin
