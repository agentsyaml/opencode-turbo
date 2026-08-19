# opencode-turbo

Peace of mind for OpenCode. Long-running sessions can hit provider failures
that OpenCode does not retry, while the live status line makes session activity
visible. This plugin handles the explicit failure cases — zero config.

## Why

- **Explicit transient failures handle themselves.** When a session hits a
  matching API, SQL, or connection/transport failure, the plugin captures what
  the model already produced and re-sends a continuation prompt with the same
  model, so the work resumes from where it stopped.
- **You can see it working.** A single live status line in the sidebar shows
  exactly what OpenCode is doing right now — thinking, writing, running a
  tool — so a quiet screen never looks like a stuck one. Step away; come back
  to a finished session, not a dead one.

## Features

### Auto-recovery

Recovers the response from the exact interruption point when a session hits
a matching API, SQL, or connection/transport failure:

- explicit `APIError` status codes: 400, 402, 403, 405, 408, 409, 422, 429
  (plus 500, 502, 503, 504, 524, 529); without a status code, only a small
  set of explicit service messages is accepted, never the same text from an
  unclassified error
- explicit SQL/SQLite/Database errors containing `Failed to execute
  statement` or `database is locked`; `Failed query:` is accepted without an
  error class only when it is immediately followed by a SQL statement keyword
  such as `insert`, `select`, or `update`
- narrow connection/transport failures such as connection reset/closed/lost,
  `ECONN*`, unable to connect, socket hang up, fetch failure, request/connection/
  response/read/SSE timeouts, `ETIMEDOUT`, broken pipe, and stream
  closed/ended or premature close

Recovery per session: verify the failed assistant message → capture the partial
output → append a continuation prompt while retaining the full history. Guardrails:
user stops, auth errors, permanent failures, model/tool output errors,
TLS/certificate errors, empty output, and silent stalls are never recovered;
model/tool errors stay excluded even when an API status code would otherwise be
retryable. Status preflight probes are bounded to three attempts and only wait
for the failed message to become ready; they do not widen the error matcher.
at most 10 consecutive recoveries with exponential backoff capped at 30 minutes
(counter resets on success); OpenCode's own retry loop is never touched. Logs:
`~/.local/share/opencode/logs/auto-recover.log`.

### Live status line

One status line in the sidebar, updating as parts stream in:

- `🔧 bash · 12.5s` — the running tool with elapsed time; when the model set
  an explicit timeout it shows the budget too: `🔧 bash · 12.5s / 30s`; content
  tools also show their input tokens: `🔧 edit · 2.5s · 567 tokens`
- `🤔 Thinking · 12.0s · 1,234 tokens` — elapsed time, then the estimated
  token count while reasoning
- `⠋ Working · 3.2s · 567 tokens` — an animated spinner, the phase's elapsed
  time, then the tokens accumulated between phases
- `⏳ Waiting · 1.5s` — first-response phase
- `✅ Done · 1m 30s · 14:30:22` — last turn's duration and local time
- `❌ Failed` — a terminally-failed turn is shown, never disguised as idle

A new state replaces the shown one after a 300ms settle (killing
rapid-transition flicker), while the shown numbers — spinner and timers —
keep ticking live on every heartbeat, so the line never freezes and never
looks stuck. Token counts are estimates (CJK-aware), not billing numbers.

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

> The TUI status line is served from `dist/tui.js`. After editing `src/tui.tsx`,
> run `bun run build:tui` — otherwise the sidebar line silently won't load.

## Development

```bash
bun install
bun run check   # typecheck + self-checks
```

## License

MIT
