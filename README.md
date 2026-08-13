# opencode-auto-recover

Zero-config OpenCode plugin that recovers sessions when a provider error would
otherwise kill the flow. No config file, no options — it just works.

It recovers errors that opencode itself does **not** retry by default:

- mid-stream closures: `provider closed the stream before sending a completion
  marker (upstream connection ended mid-stream)` reaching a terminal state
  (`session.error`) instead of opencode's retry path — commonly seen when
  delegating to sub-agents (`task` tool)
- 4xx status codes opencode treats as non-retryable (400, 402, 403, 405, 408,
  409, 422, 429)
- provider/model-output errors where a retry lets the model fix itself
  (`bad request`, `reasoning_opaque`, malformed tool calls such as
  `expected string, received undefined` / `Invalid input for tool` /
  `tool_use ids were found without tool_result`)

## Install

Add the plugin to `opencode.json`:

```json
{
  "plugin": ["@alexsun-top/opencode-turbo"]
}
```

For local development, point at the source directly:

```json
{
  "plugin": ["file:///path/to/opencode-turbo/src/index.ts"]
}
```

No configuration. Restart opencode after changing config.

> The TUI plugin is served from `dist/tui.js` (built). After editing `src/tui.tsx`,
> rebuild with `bun run build:tui` — otherwise the sidebar panel silently won't load.

## Live status notifications

The plugin ships two parts, loaded from the same config entry:

- a **server plugin** (`./server` → `src/index.ts`): error recovery + retry/recovery
  toast notifications
- a **TUI plugin** (`./tui` → `src/tui.tsx`): a persistent live-status panel
  rendered into the sidebar via the `sidebar_content` slot

### TUI status panel

Always visible in the sidebar while the model works (subscribes to the server
event stream, so it updates live as parts stream in):

- **Thinking** — live word count while the model reasons
  (`🤔 Thinking · 1,234 words`)
- **Current tool** — the running tool + elapsed time (`🔧 bash · 12.5s`)
- **Last completion** — duration + local timestamp of the last finished turn
  (`✅ Done · 1m 30s · 14:30:22`)

### Toast notifications (only for notice-style events)

- **Retries** — when opencode itself retries (`⚠️ Retrying · attempt 2`),
  and when this plugin auto-recovers (`🔄 Auto-recovering · attempt 1/10`)

All display is display-only: it never affects session state and never
interferes with opencode's own retry loop.

## How it works

opencode wraps every provider call in its own retry policy. Retryable errors
(429/5xx, rate limits, known connection patterns) are retried with exponential
backoff, **unbounded** — the plugin never touches that loop. Everything else
— including most 4xx and some stream closures — goes straight to a terminal
failure (`session.error`). When a sub-agent prompt fails, the child session
ends with the error attached and the parent is told the task failed.

The plugin acts only on terminal failures:

| Event | Condition | Action |
|-------|-----------|--------|
| `session.error` | error is recoverable | recover |
| `message.updated` | assistant message carries a recoverable error | recover |

Recovery, per session:

1. `session.abort` — stop opencode's own retry loop / in-flight generation
2. fetch messages — capture the partial assistant output and the model in use
3. `session.revert` to the last user message — drop the interrupted response
4. re-send a continuation prompt with the partial content, using the **same
   model** — the model resumes exactly where it was cut off

If the interrupted response had no text yet, the original user message parts
are re-sent instead; if that message carries nothing resendable (e.g. only
tool results), a generic nudge prompt is sent so the model re-engages.

### Guardrails

- user-initiated aborts (`MessageAbortedError`), auth errors and permanent
  failures are never recovered
- at most 10 consecutive recoveries per session, with exponential backoff
  (2s, 4s, 8s, ... capped at 30 minutes); the counter resets on a successful
  completion
- recovery is single-flight per session; duplicate trigger events
  (`session.error` + `message.updated` for the same failure) are deduplicated
  by error signature
- opencode's own retry events are never acted on — the unbounded retry loop is
  left untouched (only surfaced as a notification toast)
- the plugin never writes into chat history beyond the recovery prompt, and
  logs to `~/.local/share/opencode/logs/auto-recover.log`

## Limits

- Recovery always retries with the same model. There is no fallback-model
  concept — for a provider-wide outage the attempts are bounded and the
  plugin gives up with a log entry rather than loop forever.
- For a failed sub-agent session, recovery repairs the child session (it
  completes with the full response). Whether the parent re-invokes the task
  is up to opencode's task error handling.

## Development

```bash
bun install
bun run check   # typecheck + matching-logic self-check
```

## License

MIT
