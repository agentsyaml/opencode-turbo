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
import { isAbortError } from "./matcher"
import { estimateTokens, formatDuration } from "./util"

type PartLike = {
  id?: string
  callID?: string
  type?: string
  text?: string
  tool?: string
  name?: string
  state?: { status?: string; title?: string; input?: unknown; time?: { start?: number; end?: number } }
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

// Tools whose input is file content worth counting: edit/write/patch. Command
// tools (bash, ...) get no token suffix — a command's token count is noise.
// The content is what the model is writing into files.
const CONTENT_TOOLS = new Set(["edit", "write", "patch"])

/** Estimated tokens of a raw tool input. Pure, exported for self-check. */
export function toolInputTokensOf(input: unknown): number | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === "string") return input.length > 0 ? estimateTokens(input) : undefined
  // Pending tools carry an empty object until the args arrive — no tokens yet.
  const json = JSON.stringify(input)
  if (json === undefined || json === "{}") return undefined
  return estimateTokens(json)
}

/** Content tools only — command tools get no token count. Pure, exported for self-check. */
export function contentToolTokens(tool: string | undefined, input: unknown): number | undefined {
  if (!tool || !CONTENT_TOOLS.has(tool)) return undefined
  return toolInputTokensOf(input)
}

/** The currently running or preparing tool. Pure, exported for self-check. */
export function runningToolOf(parts: PartLike[] | undefined): { name: string; callID: string; start?: number; tool?: string; input?: unknown } | undefined {
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
    tool: part.tool,
    input: part.state?.input,
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

// Braille spinner frames for the Working state — a moving icon proves the
// panel is alive, visually distinct from Waiting's static hourglass.
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

export interface PanelState {
  tool?: { name: string; elapsed: number; tokens?: number }
  thinking: number
  thinkingElapsed?: number
  waiting: boolean
  waitElapsed?: number
  working: boolean
  workElapsed?: number
  workingSpin?: number
  textTokens: number
  done?: { ms: number; at: string }
  failed?: boolean
}

/**
 * One status line for the current state, in priority order:
 * tool > thinking > writing (working included) > waiting > done > idle.
 * Pure and exported so every display phase is command-verifiable.
 */
export function panelRow(state: PanelState): string {
  const { tool, thinking, thinkingElapsed, waiting, waitElapsed, working, workElapsed, workingSpin, textTokens, done, failed } = state
  if (tool) {
    const tokensSuffix = tool.tokens !== undefined ? ` · ${tool.tokens.toLocaleString()} tokens` : ""
    return `🔧 ${tool.name} · ${formatDuration(tool.elapsed)}${tokensSuffix}`
  }
  if (thinking > 0) {
    const suffix = thinkingElapsed !== undefined ? ` · ${formatDuration(thinkingElapsed)}` : ""
    return `🤔 Thinking${suffix} · ${thinking.toLocaleString()} tokens`
  }
  if (working) {
    const suffix = workElapsed !== undefined ? ` · ${formatDuration(workElapsed)}` : ""
    const spin = SPINNER[(workingSpin ?? 0) % SPINNER.length]
    return `${spin} Working${suffix} · ${textTokens.toLocaleString()} tokens`
  }
  if (waiting) {
    const suffix = waitElapsed !== undefined ? ` · ${formatDuration(waitElapsed)}` : ""
    return `⏳ Waiting${suffix}`
  }
  if (done) return `✅ Done · ${formatDuration(done.ms)} · ${done.at}`
  if (failed) return "❌ Failed"
  return "🤖 idle"
}

/** A text renderable captured via ref (native host object). */
type TextRenderable = { content: string | number }

function StatusPanel(props: { api: TuiPluginApi; session_id: string }) {
  let statusText: TextRenderable | undefined
  // Waiting-phase anchor: the waiting timer starts when the panel ENTERS the
  // waiting state — never from a message timestamp (a new user message can lag
  // the store sync, which used to make the wait accumulate from a stale value).
  let lastWaitStart = 0
  let lastWorkStart = 0
  // Stable anchors for tool elapsed: the store's tool `time.start` updates on
  // every progress event, so anchor elapsed to the FIRST time the panel sees
  // each tool call active. ponytail: map grows one entry per tool call per
  // panel — clear it if a long-lived session ever shows memory growth.
  const toolAnchors = new Map<string, { start: number; tokens?: number; inputRef?: unknown }>()

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
      // Tokens are recomputed only when the input REFERENCE changes (pending {}
      // -> running args), never per tick — stringifying a large edit input on
      // every 100ms heartbeat would waste the render path.
      let anchor = toolAnchors.get(found.callID)
      const start = found.start ?? anchor?.start ?? now
      if (anchor === undefined) {
        anchor = { start, tokens: contentToolTokens(found.tool, found.input), inputRef: found.input }
        toolAnchors.set(found.callID, anchor)
      } else if (anchor.inputRef !== found.input) {
        anchor.inputRef = found.input
        anchor.tokens = contentToolTokens(found.tool, found.input)
      }
      tool = { name: found.name, elapsed: now - start, tokens: anchor.tokens }
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
    // Working elapsed anchored to phase entry (mirrors the waiting anchor).
    if (working && lastWorkStart === 0) lastWorkStart = now
    if (!working) lastWorkStart = 0
    const workElapsed = working && lastWorkStart > 0 ? now - lastWorkStart : undefined
    // Spinner frame: advances every 100ms while working.
    const workingSpin = working ? Math.floor(now / 100) % SPINNER.length : 0

    // Waiting timer anchored to phase entry; resets whenever waiting exits.
    if (waiting && lastWaitStart === 0) lastWaitStart = now
    if (!waiting) lastWaitStart = 0
    const waitElapsed = waiting && lastWaitStart > 0 ? now - lastWaitStart : undefined
    // Done ONLY when the session status is explicitly "idle" — a multi-step
    // turn sets the message's time.completed per segment (mid-turn!), so the
    // message state alone can never prove the turn ended.
    const done = statusType === "idle" && assistantFinished && !newestIsUser ? completionOf(assistant) : undefined
    // A terminally-failed turn (assistant error, session idle) must never look
    // like a fresh idle session — the "quiet ≠ stuck" promise. User-initiated
    // aborts (Esc / stop) finalize with MessageAbortedError and are NOT
    // failures — a deliberate stop must not show "Failed".
    const failed = statusType === "idle" && !!assistant?.error && !newestIsUser && !isAbortError(assistant.error)

    return {
      tool,
      thinking,
      thinkingElapsed: typeof thinkingStart === "number" && thinkingStart > 0 ? now - thinkingStart : undefined,
      waiting,
      waitElapsed,
      working,
      workElapsed,
      workingSpin,
      textTokens,
      done,
      failed,
    }
  }

  // Anti-flicker with liveness: a state must persist for SETTLE_MS before it
  // replaces the shown one, so rapid sub-300ms transitions (waiting -> thinking
  // -> working -> tool) never flash. While holding, the shown state's numbers
  // keep ticking from the hold snapshot (elapsed grows, spinner rotates) — the
  // line stays alive, never frozen.
  const SETTLE_MS = 300
  const TICK_MS = 100
  let lastLine = ""
  let held: PanelState | undefined
  let heldSince = 0
  let heldBase = { tool: 0, thinking: 0, work: 0, wait: 0 }

  const kindOf = (s: PanelState): string =>
    s.tool ? "tool" : s.thinking > 0 ? "thinking" : s.working ? "working" : s.waiting ? "waiting" : s.done ? "done" : s.failed ? "failed" : "idle"

  const sync = () => {
    // compute() runs on the host's render path (ref callbacks run inside the
    // reconciler's mount phase) — any throw must never take down the TUI.
    try {
      const state = compute()
      const nowMs = Date.now()
      const nextKind = kindOf(state)
      const shownKind = held ? kindOf(held) : nextKind
      let line: string
      if (!held || nextKind === shownKind || nowMs - heldSince >= SETTLE_MS) {
        held = state
        heldSince = nowMs
        heldBase = {
          tool: state.tool?.elapsed ?? 0,
          thinking: state.thinkingElapsed ?? 0,
          work: state.workElapsed ?? 0,
          wait: state.waitElapsed ?? 0,
        }
        line = panelRow(state)
      } else {
        // Hold: keep the shown state, refresh its time-derived fields.
        const delta = nowMs - heldSince
        const refreshed: PanelState = {
          ...held,
          tool: held.tool ? { ...held.tool, elapsed: heldBase.tool + delta } : undefined,
          thinkingElapsed: held.thinkingElapsed !== undefined ? heldBase.thinking + delta : undefined,
          workElapsed: held.workElapsed !== undefined ? heldBase.work + delta : undefined,
          waitElapsed: held.waitElapsed !== undefined ? heldBase.wait + delta : undefined,
          workingSpin: Math.floor(nowMs / 100) % SPINNER.length,
        }
        line = panelRow(refreshed)
      }
      if (line === lastLine) return // nothing changed — no repaint
      lastLine = line
      if (statusText) statusText.content = line
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
