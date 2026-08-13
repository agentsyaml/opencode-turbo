# opencode-turbo

Zero-config OpenCode plugin: auto-recovers sessions from provider errors
opencode doesn't retry, plus a live status panel in the TUI. No options,
no config — install and restart.

## Features

**Auto-recovery** — resumes the response exactly where it was cut off when a
session hits a terminal failure opencode gives up on:

- mid-stream closures (`provider closed the stream before sending a completion
  marker`) that reach `session.error` instead of opencode's retry path —
  common with the `task` tool / sub-agents
- status codes opencode treats as non-retryable: 400, 402, 403, 405, 408,
  409, 422, 429 (plus 500, 502, 503, 504, 524, 529)
- model-output errors a retry lets the model fix itself (`bad request`,
  `reasoning_opaque`, malformed tool calls)

**Live status panel** — a `⚡ Status` panel in the TUI sidebar, updating as
parts stream in:

- `🤔 Thinking · 1,234 words` — live word count while the model reasons
- `🔧 bash · 12.5s` — the running tool with elapsed time
- `✅ Done · 1m 30s · 14:30:22` — last turn's duration and local time

**Notice toasts** — retry-style events only: opencode's own retries
(`⚠️ Retrying · attempt 2`) and auto-recovery (`🔄 Auto-recovering · 1/10`).
All display is display-only; it never touches session state.

## Install

```json
{
  "plugin": ["@alexsun-top/opencode-turbo"]
}
```

Local development — point at the source:

```json
{
  "plugin": ["file:///path/to/opencode-turbo"]
}
```

No configuration. Restart opencode after changing config.

> The TUI panel is served from `dist/tui.js`. After editing `src/tui.tsx`,
> run `bun run build:tui` — otherwise the sidebar panel silently won't load.

## How recovery works

opencode retries retryable errors itself (unbounded, exponential backoff) —
the plugin never interferes with that loop. It acts only on terminal failures
(`session.error` / `message.updated` carrying an assistant error), per session:

1. `session.abort` — stop the in-flight generation
2. read messages — capture the partial output and the model in use
3. `session.revert` to the last user message — drop the interrupted response
4. re-send a continuation prompt with the partial content, **same model** —
   the model resumes from the exact point where it stopped

Guardrails: user aborts, auth errors and permanent failures are never
recovered; at most 10 consecutive recoveries with exponential backoff capped
at 30 minutes (counter resets on success); recovery is single-flight per
session with duplicate events deduplicated. Logs go to
`~/.local/share/opencode/logs/auto-recover.log`.

## Development

```bash
bun install
bun run check   # typecheck + matching-logic self-check
```

## License

MIT
