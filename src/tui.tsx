// TUI status panel for opencode-turbo.
//
// Renders a persistent live-status panel into the sidebar via the
// `sidebar_content` slot: thinking word count, the currently running tool with
// elapsed time, and the last completed turn with duration + local timestamp.
//
// Update model (mirrors the working Tarquinen/oc-tps plugin): capture the
// native text renderables via refs, MUTATE their `.content` directly on every
// state change, then call `api.renderer.requestRender()`. This bypasses solid
// reactivity entirely — it works regardless of which solid instance the host
// reconciler uses, because the renderable refs belong to the host renderer.

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { onCleanup } from "solid-js"
import { countWords, formatDuration } from "./util"

type PartLike = {
  id?: string
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

/** Total word count of a message's reasoning parts. Pure, exported for self-check. */
export function thinkingWordsOf(parts: PartLike[] | undefined): number {
  const list = parts ?? []
  return list
    .filter((p) => p.type === "reasoning" && typeof p.text === "string")
    .reduce((sum, p) => sum + countWords(p.text as string), 0)
}

/** The currently running tool in a message's parts. Pure, exported for self-check. */
export function runningToolOf(parts: PartLike[] | undefined): { name: string; start: number } | undefined {
  const list = parts ?? []
  const part = [...list].reverse().find((p) => p.type === "tool" && p.state?.status === "running")
  if (!part) return undefined
  const start = part.time?.ran ?? part.time?.created ?? part.state?.time?.start
  if (!start) return undefined
  return { name: part.state?.title ?? part.tool ?? part.name ?? "tool", start }
}

/** Completion info of an assistant message. Pure, exported for self-check. */
export function completionOf(message: MessageLike | undefined): { ms: number; at: string } | undefined {
  const completed = message?.time?.completed
  if (!completed || message?.error) return undefined
  const ms = message.time?.created ? completed - message.time.created : 0
  return { ms, at: new Date(completed).toLocaleTimeString() }
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

const TUI_LOG_PATH = [".local", "share", "opencode", "logs", "auto-recover.log"] as const

async function tuiLog(message: string): Promise<void> {
  try {
    const { appendFile, mkdir } = await import("node:fs/promises")
    const { homedir } = await import("node:os")
    const { join } = await import("node:path")
    const path = join(homedir(), ...TUI_LOG_PATH)
    await mkdir(join(path, ".."), { recursive: true })
    await appendFile(path, `[${new Date().toISOString()}] ${message}\n`, "utf-8")
  } catch {
    // diagnostics must never break the plugin
  }
}

/** A text renderable captured via ref (native host object). */
type TextRenderable = { content: string | number }

function StatusPanel(props: { api: TuiPluginApi; session_id: string }) {
  let thinkingText: TextRenderable | undefined
  let toolText: TextRenderable | undefined
  let doneText: TextRenderable | undefined

  // Change detection: only repaint when the displayed content actually changed.
  // The panel always renders the SAME three rows (fixed layout — no line
  // jumping); only the text within each row changes.
  let lastThinking = ""
  let lastTool = ""
  let lastDone = ""
  let lastDoneKey = ""
  let diagCount = 0
  // Waiting-phase anchor: the waiting timer starts when the panel ENTERS the
  // waiting state — never from a message timestamp (a new user message can lag
  // the store sync, which used to make the wait accumulate from a stale value).
  let lastWaitStart = 0

  const compute = () => {
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

    const tool = generating ? runningToolOf(parts) : undefined
    // Thinking only while the reasoning is still streaming. The reasoning part
    // time is {start, end?} (v1 Part shape — some builds use created/completed,
    // so tolerate both): the counter stops once `end`/`completed` is set or the
    // message finishes.
    const reasoningActive =
      generating &&
      !assistantFinished &&
      (parts?.some(
        (p) => p.type === "reasoning" && p.time?.end === undefined && p.time?.completed === undefined,
      ) ?? false)
    const thinking = reasoningActive ? thinkingWordsOf(parts) : 0
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

    // Waiting timer: anchored to the moment the waiting phase began. The phase
    // anchor resets whenever waiting exits, so each waiting phase counts from
    // ~0 and never accumulates across turns or sync lags.
    const now = Date.now()
    if (waiting && lastWaitStart === 0) lastWaitStart = now
    if (!waiting) lastWaitStart = 0
    const waitElapsed = waiting && lastWaitStart > 0 ? now - lastWaitStart : undefined
    // Done ONLY when the session status is explicitly "idle" — a multi-step
    // turn sets the message's time.completed per segment (mid-turn!), so the
    // message state alone can never prove the turn ended. The status is the
    // only reliable "the turn is truly over" signal.
    const done = statusType === "idle" && assistantFinished && !newestIsUser ? completionOf(assistant) : undefined

    // Diagnostic: log done transitions (appears/disappears) so a residual flash
    // is observable without full-state spam.
    const doneKey = done ? `done:${assistant?.id}:${done.ms}` : "no-done"
    if (doneKey !== lastDoneKey) {
      lastDoneKey = doneKey
      if (diagCount < 20) {
        diagCount += 1
        void tuiLog(
          `DONE ${doneKey} gen=${generating} status=${statusType ?? "?"} aId=${assistant?.id ?? "-"} ` +
            `completed=${assistant?.time?.completed ?? "-"} finish=${assistant?.finish ?? "-"} newestUser=${newestIsUser}`,
        )
      }
    }
    return {
      tool: tool ? { ...tool, elapsed: now - tool.start } : undefined,
      thinking,
      thinkingElapsed: typeof thinkingStart === "number" && thinkingStart > 0 ? now - thinkingStart : undefined,
      waiting,
      waitElapsed,
      working,
      done,
    }
  }

  // Mutate the native renderables, then request a repaint (oc-tps pattern).
  // Only fires when at least one row's content changed. Rows are FIXED (no
  // layout jumping); the state maps to its row: thinking/waiting/idle on row 1,
  // tool on row 2, done on row 3.
  const doSync = () => {
    try {
      const { tool, thinking, thinkingElapsed, waiting, waitElapsed, working, done } = compute()
      const thinkingSuffix = thinkingElapsed !== undefined ? ` · ${formatDuration(thinkingElapsed)}` : ""
      const waitSuffix = waitElapsed !== undefined ? ` · ${formatDuration(waitElapsed)}` : ""
      const nextRow1 = tool
        ? ""
        : thinking > 0
          ? `🤔 Thinking · ${thinking.toLocaleString()} words${thinkingSuffix}`
          : waiting
            ? `⏳ Waiting${waitSuffix}`
            : working
              ? "⏳ Working"
              : done
                ? ""
                : "🤖 idle"
      const nextRow2 = tool ? `🔧 ${tool.name} · ${formatDuration(tool.elapsed)}` : ""
      const nextRow3 = done ? `✅ Done · ${formatDuration(done.ms)} · ${done.at}` : ""

      if (nextRow1 === lastThinking && nextRow2 === lastTool && nextRow3 === lastDone) {
        return // nothing changed — no repaint
      }
      lastThinking = nextRow1
      lastTool = nextRow2
      lastDone = nextRow3

      if (thinkingText) thinkingText.content = nextRow1
      if (toolText) toolText.content = nextRow2
      if (doneText) doneText.content = nextRow3
      props.api.renderer.requestRender()
    } catch {
      // rendering must never break the plugin
    }
  }

  // Strict cadence: ROW_SWITCH_MS throttles transitions between active states
  // (idle/thinking/waiting/tool/done) on EVERY render path (events, interval,
  // refs all go through this gate). In-row updates (word count, durations)
  // stay unthrottled — change detection keeps redundant repaints away.
  const ROW_SWITCH_MS = 300
  const TICK_MS = 100
  let lastActiveRow = ""
  let lastRowSwitchAt = 0

  const renderIfNeeded = () => {
    // compute() runs on the host's render path (ref callbacks run inside the
    // reconciler's mount phase) — any throw must never take down the TUI.
    try {
      const { tool, thinking, waiting, working, done } = compute()
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
      if (activeRow !== lastActiveRow) {
        if (Date.now() - lastRowSwitchAt < ROW_SWITCH_MS) return
        lastActiveRow = activeRow
        lastRowSwitchAt = Date.now()
      }
      doSync()
    } catch {
      // rendering must never break the plugin
    }
  }

  const theme = props.api.theme.current

  // Heartbeat: fine tick (in-row refresh) + session events (both gated above).
  const timer = setInterval(renderIfNeeded, TICK_MS)
  timer.unref?.()
  const offs = [
    props.api.event.on("message.part.updated", renderIfNeeded),
    props.api.event.on("message.updated", renderIfNeeded),
  ]
  onCleanup(() => {
    for (const off of offs) off()
    clearInterval(timer)
  })

  return (
    // sidebar slot roots must be stable; a conditional root never mounts
    <box>
      <box flexDirection="column" gap={1}>
        <text fg={theme.text}>
          <b>⚡ Status</b>
        </text>
        <text ref={(ref: unknown) => { thinkingText = ref as TextRenderable; renderIfNeeded() }} fg={theme.textMuted} />
        <text ref={(ref: unknown) => { toolText = ref as TextRenderable; renderIfNeeded() }} fg={theme.textMuted} />
        <text ref={(ref: unknown) => { doneText = ref as TextRenderable; renderIfNeeded() }} fg={theme.textMuted} />
      </box>
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

  void tuiLog("TUI PLUGIN INIT + register done (imperative renderable)")
}

// File-based (path) plugins MUST export a non-empty `id` — the TUI runtime
// rejects path plugins without one (resolvePluginId throws "Path plugin ...
// must export id"), dropping the plugin before tui() is ever called.
const plugin: TuiPluginModule = { id: "opencode-turbo", tui }

export default plugin
