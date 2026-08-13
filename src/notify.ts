// Retry/recovery notifications for opencode-turbo.
//
// The live statuses (thinking word count, tool elapsed, agent completion) are
// rendered by the TUI plugin (src/tui.tsx). This module only surfaces the two
// notification-style events via toast: opencode's own retry loop and this
// plugin's auto-recovery.

import type { PluginInput } from "@opencode-ai/plugin"

type ToastVariant = "info" | "success" | "warning" | "error"

const LIVE_THROTTLE_MS = 1_500 // min interval between refreshes of one key
const DONE_DURATION_MS = 4_000 // toast lifetime for notices
const MAX_MESSAGE_CHARS = 60 // TUI toast max width

interface PendingToast {
  title: string
  message: string
  variant: ToastVariant
  duration: number
}

interface ToastSlot {
  last: number
  timer: ReturnType<typeof setTimeout> | null
  pending: PendingToast | null
}

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

export interface Notifications {
  onSessionStatusRetry(sessionID: string, attempt: number, message: string): void
  onRecoveryStart(sessionID: string, attempt: number, maxAttempts: number): void
  dispose(): void
}

export function createNotifications(client: PluginInput["client"]): Notifications {
  const slots = new Map<string, ToastSlot>()

  function showToast(title: string, message: string, variant: ToastVariant, duration: number): void {
    client.tui.showToast({ body: { title, message, variant, duration } }).catch(() => {})
  }

  function flush(key: string, slot: ToastSlot): void {
    if (!slot.pending) return
    slot.last = Date.now()
    const pending = slot.pending
    slot.pending = null
    showToast(pending.title, pending.message, pending.variant, pending.duration)
  }

  /** Trailing-throttled toast per key: keeps the latest message, refreshes at most every LIVE_THROTTLE_MS. */
  function liveToast(
    key: string,
    title: string,
    message: string,
    variant: ToastVariant = "info",
    duration: number = DONE_DURATION_MS,
  ): void {
    let slot = slots.get(key)
    if (!slot) {
      slot = { last: 0, timer: null, pending: null }
      slots.set(key, slot)
    }
    slot.pending = { title, message, variant, duration }
    const now = Date.now()
    if (now - slot.last >= LIVE_THROTTLE_MS) {
      flush(key, slot)
    } else if (!slot.timer) {
      slot.timer = setTimeout(() => {
        slot!.timer = null
        flush(key, slot!)
      }, LIVE_THROTTLE_MS - (now - slot.last))
      slot.timer.unref?.()
    }
  }

  function onSessionStatusRetry(sessionID: string, attempt: number, message: string): void {
    liveToast(`retry:${sessionID}`, "⚠️ Retrying", `attempt ${attempt} — ${short(message, 48)}`, "warning")
  }

  function onRecoveryStart(sessionID: string, attempt: number, maxAttempts: number): void {
    liveToast(`recover:${sessionID}`, "🔄 Auto-recovering", `attempt ${attempt}/${maxAttempts}`, "info")
  }

  function dispose(): void {
    for (const slot of slots.values()) {
      if (slot.timer) clearTimeout(slot.timer)
    }
    slots.clear()
  }

  return {
    onSessionStatusRetry,
    onRecoveryStart,
    dispose,
  }
}
