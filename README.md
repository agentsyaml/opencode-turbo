# opencode-turbo

Peace of mind for OpenCode. Long-running sessions fail in two ways: provider
errors OpenCode doesn't retry, and the quiet fear that a session has silently
stalled. This plugin fixes both — zero config, zero options.

## Why

- **Errors handle themselves.** When a session hits a terminal failure OpenCode
  gives up on, the plugin recovers it automatically: it captures what the model
  already produced and re-sends a continuation prompt with the same model, so
  the work resumes exactly where it stopped. No babysitting, no lost output,
  no re-running an hour-long session.
- **You can see it working.** A single live status line in the sidebar shows
  exactly what OpenCode is doing right now — thinking, writing, running a
  tool — so a quiet screen never looks like a stuck one. Step away; come back
  to a finished session, not a dead one.

## Features

### Auto-recovery

Recovers the response from the exact interruption point when a session hits
a terminal failure:

- mid-stream closures (`provider closed the stream before sending a completion
  marker`) that reach `session.error` instead of OpenCode's retry path —
  common with the `task` tool / sub-agents
- status codes OpenCode treats as non-retryable: 400, 402, 403, 405, 408,
  409, 422, 429 (plus 500, 502, 503, 504, 524, 529)
- model-output errors a retry lets the model fix itself (`bad request`,
  `reasoning_opaque`, malformed tool calls)
- transient SQLite errors (`Failed to execute statement`,
  `database is locked`) from concurrent OpenCode instances

Recovery per session: abort → capture the partial output → revert to the last
user message → re-send a continuation prompt with the same model. Guardrails:
user aborts, auth errors and permanent failures are never recovered; at most
10 consecutive recoveries with exponential backoff capped at 30 minutes
(counter resets on success); OpenCode's own unbounded retry loop is never
touched. Logs: `~/.local/share/opencode/logs/auto-recover.log`.

### Live status line

One status line in the sidebar, updating as parts stream in:

- `🔧 bash · 12.5s` — the running tool with elapsed time
- `🤔 Thinking · 1,234 tokens` — estimated token count while reasoning
- `✍️ Writing · 567 tokens` — estimated tokens received while composing
  its reply or preparing edits (shown even at 0)
- `⏳ Waiting · 1.5s` — first-response phase
- `✅ Done · 1m 30s · 14:30:22` — last turn's duration and local time

States must persist 300 ms before they render, so the line never flickers
through short-lived transitions. Token counts are estimates (CJK-aware), not
billing numbers.

### Notice toasts

Retry-style events only: OpenCode's own retries (`⚠️ Retrying · attempt 2`)
and auto-recovery (`🔄 Auto-recovering · 1/10`). All display is display-only;
it never touches session state.

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

No configuration. Restart OpenCode after changing config.

> The TUI status line is served from `dist/tui.js`. After editing `src/tui.tsx`,
> run `bun run build:tui` — otherwise the sidebar line silently won't load.

## Development

```bash
bun install
bun run check   # typecheck + self-checks
```

## License

MIT
