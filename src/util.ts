// Small shared helpers for opencode-turbo (server plugin, tui plugin, self-check).

export function estimateTokens(text: string): number {
  // ponytail: chars/4 approximation for non-CJK text, 1 char = 1 token for CJK
  // (cl100k-style heuristic). Exact per-model counts need a real tokenizer
  // dependency — add when billing accuracy matters.
  const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 4)
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1_000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}
