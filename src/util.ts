// Small shared helpers for opencode-turbo (server plugin, tui plugin, self-check).

const CJK_CHARACTER = /[\p{Script=Han}\u2e80-\u2fff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31a0-\u31bf\uff00-\uffef]/u

export function estimateTokens(text: string): number {
  // ponytail: chars/4 approximation for non-CJK text, 1 char = 1 token for CJK
  // (cl100k-style heuristic). Exact per-model counts need a real tokenizer
  // dependency — add when billing accuracy matters.
  let chars = 0
  let cjk = 0
  for (const char of text) {
    chars++
    if (CJK_CHARACTER.test(char)) cjk++
  }
  return Math.round(cjk + (chars - cjk) / 4)
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1_000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
