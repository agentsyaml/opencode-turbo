# opencode-turbo

Peace of mind for OpenCode. Long-running sessions can hit provider failures
that OpenCode does not retry, while the live status line makes session activity
visible. This plugin handles explicit failures plus silent stalls and empty
turns — zero config required, all knobs optional.

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
- narrow connection/transport failures such as connection reset/closed/lost
  (including auxiliary forms like `connection was closed`), `ECONN*`, unable to
  connect, `cannot connect to host` / `connect call failed`, socket hang up,
  fetch failure, request/connection/response/read/SSE timeouts, `ETIMEDOUT`,
  broken pipe, and stream closed/ended or premature close
- a bare provider timeout, accepted as the bare sentence
  `the operation timed out` with or without a trailing period, from an
  unclassified error; the tool-timeout variant carrying the larger-timeout
  hint stays excluded
- silent stalls: a session that makes no stream progress for `stallTimeoutMs`
  (default 30 min) with no running tool is probed and, only when the session is
  idle, resumed through the same recovery path; a busy session is probed under
  the preflight budget and never aborted
- empty turns: a turn that finishes with no visible text or tool output is
  continued with a short prompt asking for the actual answer

Recovery per session: verify the failed assistant message → capture the partial
output → append a continuation prompt while retaining the full history. Guardrails:
user stops, auth errors, permanent failures, and model/tool output errors are
never recovered. TLS/certificate errors are
never recovered except for the exact Bun code paired with one of the exact
messages `unknown certificate verification error`,
`Error: unknown certificate verification error`, or full
`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR: unknown certificate verification error`.
The only code-less exception is OpenCode's exact `UnknownError` wrapper with
`data.message` set to the exact bare message `unknown certificate verification error`
(the exact `Error: unknown certificate verification error` serialization is also
accepted).
Bare certificate phrases, bare codes, and other certificate errors do not
recover.
model/tool errors stay excluded even when an API status code would otherwise be
retryable. Status preflight probes wait for both the failed message to be ready
and the session status probe to be idle, retrying for up to 10 minutes with
exponential backoff capped at 30s before giving up visibly; they do not widen
the error matcher.
at most 10 consecutive recoveries with exponential backoff capped at 30 minutes
(counter resets only after a confirmed recovery continuation succeeds); OpenCode's
own retry loop is never touched. Logs:
`~/.local/share/opencode/logs/auto-recover.log`.

A user abort (Esc) permanently cancels the chain for that session: the plugin
never auto-retries a user abort and never auto-aborts a busy session, and never
revives a cancelled chain on its own. The barrier clears only when the next
genuine user message arrives, after which later failures can recover again.

### Live status line

One status line in the sidebar, updating as parts stream in:

- `🔧 bash · 12.5s` — the running tool with elapsed time; when the model set
  an explicit timeout it shows the budget too: `🔧 bash · 12.5s / 30s`; content
  tools also show their input tokens: `🔧 edit · 2.5s · 567 tokens`; active
  `task`/`subagent` calls with a prompt (including resumed calls) show its estimated size, e.g.
  `🔧 task · 2.5s · ~567 prompt tokens` (not child-context or billing usage)
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

Retry-style events: OpenCode's own retries (`⚠️ Retrying · attempt 2`) and
auto-recovery (`🔄 Auto-recovering · 1/10`). Terminal recovery exhaustion also
shows `⛔ Auto-recovery stopped`. All display is display-only; it never touches
session state.

## Install

Supports OpenCode V1 **>=1.19.0** and the OpenCode V2 **2.0.27** API. The same package provides server recovery and the TUI status line; the server plugin automatically supplies its TUI companion.

### OpenCode V2 (recommended)

Install the pinned release for the current CLI user:

```sh
opencode plugin add @alexsun-top/opencode-turbo@0.2.1
opencode plugin list
```

This is a user-level install; do not use `npm -g`. The plugin includes server recovery and registers its TUI status line automatically. Do not add this package separately to `cli.json` for a normal install: that file is for terminal-client settings and CLI-only plugins, while this package is a server plugin. Notifications use the public plugin RPC; headless recovery works without an open CLI.

Alternatively, add it to the global server config at `~/.config/opencode/opencode.json` or `opencode.jsonc`:

```json
{
  "plugins": ["@alexsun-top/opencode-turbo@0.2.1"]
}
```

To set options, use the package object form:

```json
{
  "plugins": [{
    "package": "@alexsun-top/opencode-turbo@0.2.1",
    "options": { "stallTimeoutMs": 1800000, "emptyOutput": true }
  }]
}
```

OpenCode watches server configuration, so a server restart is generally unnecessary. If the status line does not appear in an already-open terminal client, reopen that CLI.

V2 terminal-client settings are read from the global `~/.config/opencode/cli.json`. This replaces the V1 `tui.json` / `tui.jsonc` location; migration happens only when `cli.json` does not exist, and old files are left in place. Do not create a project-local `cli.json`.

See the [V2 plugin guide](https://opencode.ai/v2/docs/plugins), [V2 configuration reference](https://opencode.ai/v2/docs/config), and [V1 terminal-config migration notes](https://opencode.ai/v2/docs/migrate-v1#terminal-client-configuration).

### OpenCode V1 (>=1.19.0)

V1 uses the singular `plugin` key and tuple syntax for options:

```json
{
  "plugin": ["@alexsun-top/opencode-turbo@0.2.1"]
}
```

V1 options are the second tuple element:

```json
{
  "plugin": [
    ["@alexsun-top/opencode-turbo@0.2.1", { "stallTimeoutMs": 1800000, "emptyOutput": true }]
  ]
}
```

- `stallTimeoutMs` (default `1800000`, 30 min): event silence before the
  watchdog treats a session as stalled; `0` disables the watchdog.
- `emptyOutput` (default `true`): recover a turn that finished with no output.

The same options can be placed in the V2 package object shown above.

### Local development

Point both versions at the package directory; V2 uses `plugins` (plural), while V1 uses `plugin` (singular). V2 resolves the shared server and TUI exports from the package directory, so do not point directly at `src/index.ts`.

```json
{
  "plugins": ["file:///path/to/opencode-turbo"]
}
```

```json
{
  "plugin": ["file:///path/to/opencode-turbo"]
}
```

> The TUI status line is served from the built TUI entry. After editing a TUI
> TSX file, run `bun run build:tui` before testing or publishing.

## Development

```bash
bun install
bun run check   # typecheck + self-checks
```

## License

MIT
