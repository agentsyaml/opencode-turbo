// Production-shared watchdog and SQL recovery regressions.
import { isRecoverable } from "./matcher.ts"
import { createStallWatch, lastPartIsRunningTool } from "./stall.ts"

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FAIL: ${label}`)
}

let now = 0
const watch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => now })
const tool = (id: string, status: string) => ({ sessionID: "s", part: { type: "tool", id, callID: `call-${id}`, messageID: "m1", state: { status } } })
watch.note("message.part.updated", tool("A", "running"))
watch.note("message.part.updated", tool("B", "running"))
watch.note("message.part.updated", tool("B", "completed"))
watch.note("message.part.updated", { sessionID: "s", part: { type: "text", messageID: "m1", text: "still working" } })
watch.note("message.updated", { info: { id: "m1", sessionID: "s", role: "assistant" } })
now = 101
check(watch.snapshot("s")?.lastPartIsRunningTool === true, "tool A survives B completion and text/metadata activity")
check(watch.sweep(now).length === 0, "remaining tool wait blocks stale candidate")
watch.note("message.part.updated", tool("A", "completed"))
check(watch.snapshot("s")?.lastPartIsRunningTool === false, "last tool completion clears wait")
now = 202
check(watch.sweep(now)[0] === "s", "session can stall after final tool completion")
check(lastPartIsRunningTool([{ type: "tool", state: { status: "running" } }, { type: "text" }]), "any outstanding running tool is detected")

now = 0
const deltaWatch = createStallWatch({ timeoutMs: 100, checkMs: 30_000, maxPerSweep: 3, now: () => now })
deltaWatch.note("message.part.updated", { sessionID: "d", part: { type: "reasoning", messageID: "m1" } })
now = 99
deltaWatch.note("message.part.delta", { sessionID: "d", messageID: "m1", partID: "p1", field: "reasoning", delta: "more" })
now = 101
check(deltaWatch.sweep(now).length === 0, "reasoning delta refreshes current message liveness")
deltaWatch.note("message.part.updated", { sessionID: "d", part: { type: "text", messageID: "m2" } })
now = 202
deltaWatch.note("message.part.delta", { sessionID: "d", messageID: "m1", partID: "p1", field: "text", delta: "stale" })
check(deltaWatch.sweep(now)[0] === "d", "historical message delta does not refresh current identity")
deltaWatch.note("session.idle", { sessionID: "d" })
check(deltaWatch.snapshot("d") === undefined, "terminal event clears watchdog entry")
deltaWatch.dispose()
check(deltaWatch.snapshot("d") === undefined, "dispose clears watchdog entries")

check(!isRecoverable({ name: "UnknownError", data: { message: "Failed query: select * from missing_table\nSQLITE_ERROR: no such table: missing_table" } }), "missing-table SQL failure stays permanent")
check(!isRecoverable({ name: "UnknownError", data: { message: "Failed query: select from\nSQLITE_ERROR: near from: syntax error" } }), "SQL syntax failure stays permanent")
check(!isRecoverable({ name: "UnknownError", data: { message: "Failed query: insert into session (id) values (?)\nSQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: session.id" } }), "uniqueness failure stays permanent")
check(isRecoverable({ name: "UnknownError", data: { message: "database is locked" } }), "transient locked database remains recoverable")
for (const message of ["SSL handshake failed: database is locked", "certificate has expired SQLITE_BUSY", "TLS error SQLITE_LOCKED"]) {
  check(!isRecoverable({ name: "UnknownError", data: { message } }), "permanent certificate failure wins over SQL lock: " + message)
}
check(isRecoverable({ name: "UnknownError", data: { message: "Failed query: insert into session (id) values (?)" } }), "opaque failed-query policy remains recoverable")

console.log("ok: watchdog concurrency, deltas, terminal cleanup, and SQL classifications")
