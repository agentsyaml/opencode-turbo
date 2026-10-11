import {
  contentToolTokens,
  delegationPromptTokensOf,
  panelRow,
  runningToolOf,
  toolInputTokensOf,
  updateToolTokenCache,
} from "./tui"
import { estimateTokens } from "./util"

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

assert(estimateTokens("12345678") === 2, "ASCII estimate")
assert(estimateTokens("中文") === 2, "CJK estimate")
assert(estimateTokens("𠀀") === 1, "supplementary Han estimate")
assert(estimateTokens("") === 0, "empty estimate")

assert(delegationPromptTokensOf("task", { prompt: "12345678" }) === 2, "task prompt estimate")
assert(delegationPromptTokensOf("subagent", { prompt: "中文" }) === 2, "subagent prompt estimate")
assert(delegationPromptTokensOf("task", {}) === undefined, "missing prompt")
assert(delegationPromptTokensOf("task", { prompt: "  " }) === undefined, "blank prompt")
assert(delegationPromptTokensOf("task", { prompt: "12345678", task_id: "resume-1" }) === 2, "resumed task prompt estimate")
assert(delegationPromptTokensOf("task", { task_id: "resume-1" }) === undefined, "resume without prompt")
assert(delegationPromptTokensOf("task", null) === undefined, "malformed prompt input")
assert(delegationPromptTokensOf("bash", { prompt: "12345678" }) === undefined, "unrelated tool unchanged")
assert(contentToolTokens("edit", { content: "12345678" }) === toolInputTokensOf({ content: "12345678" }), "content tool behavior unchanged")

const cache: Parameters<typeof updateToolTokenCache>[0] = {}
const changingInput: { prompt?: string; task_id?: string } = {}
const cachedToolRow = () => panelRow({
  tool: { name: "task", elapsed: 1000, tokens: cache.tokens, tokenLabel: cache.tokenLabel },
  thinking: 0,
  waiting: false,
  working: false,
  textTokens: 0,
})
updateToolTokenCache(cache, "task", changingInput)
assert(cache.tokens === undefined && cache.tokenLabel === undefined && !cachedToolRow().includes("prompt tokens"), "pending empty prompt has no estimate")
changingInput.prompt = "12345678"
updateToolTokenCache(cache, "task", changingInput)
assert(cache.tokens === 2 && cache.tokenLabel === "prompt" && cachedToolRow().includes("~2 prompt tokens"), "pending-to-populated prompt refreshes same input")
changingInput.prompt = "1234567890123456"
updateToolTokenCache(cache, "task", changingInput)
assert(cache.tokens === 4 && cache.tokenLabel === "prompt", "changed prompt refreshes same input")
changingInput.prompt = undefined
changingInput.task_id = "resume-1"
updateToolTokenCache(cache, "task", changingInput)
assert(cache.tokens === undefined && cache.tokenLabel === undefined && !cachedToolRow().includes("prompt tokens"), "prompt removal clears cached count and label")
changingInput.prompt = "12345678"
updateToolTokenCache(cache, "task", changingInput)
assert(cache.tokens === 2 && cache.tokenLabel === "prompt", "resumed task prompt refreshes cached estimate")
const freshDispatch = { prompt: "12345678" }
assert(delegationPromptTokensOf("task", freshDispatch) === cache.tokens, "fresh and resumed prompt estimate match")

const cyclic: { self?: unknown } = {}
cyclic.self = cyclic
assert(toolInputTokensOf(cyclic) === undefined, "malformed cyclic input")
assert(toolInputTokensOf({}) === undefined, "empty pending input")

assert(
  runningToolOf([
    { type: "tool", tool: "task", state: { status: "completed", input: { prompt: "historic child prompt" } } },
  ]) === undefined,
  "historical child prompt is not an active tool",
)
assert(
  runningToolOf([{ type: "subtask", text: "historical child result" }]) === undefined,
  "separate subtask parts do not act as active tools",
)
assert(
  panelRow({
    tool: { name: "task", elapsed: 2500, tokens: 2, tokenLabel: "prompt" },
    thinking: 0,
    waiting: false,
    working: false,
    textTokens: 0,
  }) === "🔧 task · 2.5s · ~2 prompt tokens",
  "prompt tokens are identified as estimates",
)

console.log("ok: TUI delegation prompt token checks")
