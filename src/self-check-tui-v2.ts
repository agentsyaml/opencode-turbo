import { panelRow, runningToolOf } from "./tui"
import { spawnSync } from "node:child_process"
import { completedV2Outcome, failedV2Outcome, matchesToastLocation, normalizeV2Parts, parseTurboToast, settledV2Row, v2PartsOf, v2Pending, v2TuiSetup } from "./tui-v2"

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const tool = normalizeV2Parts([{
  type: "tool",
  id: "call-1",
  name: "edit",
  state: { status: "running", input: { content: "change" }, metadata: {} },
  time: { created: 100, ran: 200 },
}])[0]
const active = runningToolOf([tool] as never)
assert(active?.name === "edit" && active.callID === "call-1" && active.start === 200, "v2 running tool mapping")
assert(active?.tool === "edit" && panelRow({ tool: { name: active.name, elapsed: 1000 }, thinking: 0, waiting: false, working: false, textTokens: 0 }).includes("edit"), "v2 tool label")

const parts = v2PartsOf({ content: [{ type: "reasoning", text: "thought", state: {} }] })
assert(parts.length === 1 && parts[0].type === "reasoning", "assistant content mapping")
assert(v2PartsOf(undefined).length === 0, "missing assistant content")
assert(v2Pending([{ id: "permission" }], undefined), "permission requests block working")
assert(v2Pending(undefined, [{ id: "form" }]), "forms block working")
assert(!v2Pending(undefined, undefined), "pending inbox is not treated as human request")
const toast = { sessionID: "session-1", title: "Retrying", message: "attempt 1", variant: "warning", duration: 4000, location: { directory: "/repo", workspaceID: "worktree-a" } }
assert(parseTurboToast(toast)?.sessionID === "session-1", "valid RPC toast payload")
assert(!parseTurboToast({ ...toast, sessionID: "" }), "reject missing session id")
assert(!parseTurboToast({ ...toast, variant: "purple" }), "reject invalid toast variant")
assert(!parseTurboToast({ ...toast, duration: Infinity }), "reject invalid toast duration")
assert(!parseTurboToast({ ...toast, location: undefined }), "reject missing payload location")
assert(!parseTurboToast(null), "reject non-object toast")
assert(matchesToastLocation({ directory: "/repo" }, toast.location, { directory: "/repo", workspaceID: "worktree-a" }), "public envelope and full payload location match")
assert(!matchesToastLocation({ directory: "/repo" }, { directory: "/repo", workspaceID: "worktree-b" }, { directory: "/repo", workspaceID: "worktree-a" }), "different worktree rejects toast")
assert(!matchesToastLocation({ directory: "/other" }, toast.location, { directory: "/repo", workspaceID: "worktree-a" }), "envelope directory must match payload directory")
assert(matchesToastLocation({ directory: "/repo" }, { directory: "/repo" }, { directory: "/repo" }), "default location accepts matching directory")
assert(failedV2Outcome("failed") && !failedV2Outcome("succeeded") && !failedV2Outcome("interrupted"), "terminal idle outcomes are distinguished")
assert(completedV2Outcome("succeeded") && completedV2Outcome(undefined), "successful and legacy terminal states may show done")
assert(!completedV2Outcome("failed") && !completedV2Outcome("interrupted"), "failed or stopped turn never shows done")

const settle = { since: 0, base: { tool: 0, thinking: 0, work: 0, wait: 0 } }
const waiting = { thinking: 0, waiting: true, working: false, textTokens: 0, waitElapsed: 100 }
assert(settledV2Row(waiting, 1000, settle).includes("Waiting"), "initial status appears")
const toolState = { thinking: 0, waiting: false, working: false, textTokens: 0, tool: { name: "read", elapsed: 20 } }
assert(settledV2Row(toolState, 1100, settle).includes("Waiting"), "status transition settles for 300ms")
assert(settledV2Row(toolState, 1300, settle).includes("read"), "new status appears after settle interval")

let claim: { append?: string; render?: (input: { sessionID: string }) => unknown } | undefined
let removed = false
let subscriptions = 0
let unsubscribed = 0
let receivedToast: ((event: { data: unknown; location: unknown }) => void) | undefined
const shown: unknown[] = []
const fakeContext = {
  location: { directory: "/repo", workspaceID: "worktree-a" },
  client: { rpc: () => ({ events: { on: (_name: string, listener: (event: { data: unknown; location: unknown }) => void) => { subscriptions++; receivedToast = listener; return () => { unsubscribed++ } } } }) },
  ui: {
    toast: { show: (value: unknown) => shown.push(value) },
    slot(value: { append?: string; render?: (input: { sessionID: string }) => unknown }) { claim = value; return () => { removed = true } },
  },
}
const cleanup = v2TuiSetup(fakeContext as never)
assert(claim?.append === "sidebar.content", "v2 sidebar slot registration")
assert(subscriptions === 1, "one global RPC toast subscription")
receivedToast?.({ data: toast, location: { directory: "/repo" } })
receivedToast?.({ data: { ...toast, location: { directory: "/repo", workspaceID: "worktree-b" } }, location: { directory: "/repo" } })
receivedToast?.({ data: { ...toast, variant: "purple" }, location: { directory: "/repo" } })
receivedToast?.({ data: toast, location: { directory: "/elsewhere" } })
receivedToast?.({ data: toast, location: undefined })
assert(shown.length === 1, "invalid RPC event is ignored")
if (typeof cleanup === "function") cleanup()
assert(removed && unsubscribed === 1, "v2 slot and RPC listener cleanup")

const rendererProbe = `
  import { testRender } from "@opentui/solid"
  import { createSignal } from "solid-js"
  import { reactiveTextNode } from ${JSON.stringify(new URL("./tui-v2.tsx", import.meta.url).href)}
  const [line, setLine] = createSignal("initial status")
  const renderer = await testRender(() => reactiveTextNode(line))
  try {
    await renderer.flush()
    if (!renderer.captureCharFrame().includes("initial status")) throw new Error("initial status was not rendered")
    setLine("updated status")
    await renderer.flush()
    if (!renderer.captureCharFrame().includes("updated status")) throw new Error("reactive status did not update")
  } finally { renderer.renderer.destroy() }
`
const rendered = spawnSync(process.execPath, ["--conditions=browser", "-e", rendererProbe], { encoding: "utf8" })
assert(rendered.status === 0, `OpenTUI reactive renderer check: ${rendered.stderr || rendered.stdout}`)

console.log("ok: V2 TUI adapter checks")
