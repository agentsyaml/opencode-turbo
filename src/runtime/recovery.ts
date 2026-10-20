import type { MessageLike, PromptPart } from "../core"

export interface RecoveryRuntime {
  statusRequired?: boolean
  messages(sessionID: string, signal?: AbortSignal): Promise<MessageLike[]>
  status(sessionID: string, signal?: AbortSignal): Promise<string | undefined>
  prompt(input: { sessionID: string; messageID: string; parts: PromptPart[]; model?: { providerID: string; modelID: string }; agent?: string }): Promise<void>
}

const RETRYABLE_V2_ERRORS = new Map([
  ["provider.internal", 500], ["internal", 500],
  ["provider.rate-limit", 429], ["rate-limit", 429],
  ["provider.transport", 503], ["transport", 503],
  ["provider.timeout", 408], ["timeout", 408],
])

export function normalizeV2Error(error: unknown): unknown {
  if (!error || typeof error !== "object") return error
  const value = error as { type?: unknown; message?: unknown; status?: unknown; response?: { body?: unknown } }
  if (typeof value.type !== "string" || typeof value.message !== "string") return error
  const type = value.type.trim().toLowerCase().replace(/_/g, "-")
  const retryStatus = RETRYABLE_V2_ERRORS.get(type)
  const message = value.message.toLowerCase()
  if (retryStatus !== undefined && /\b(quota|billing|insufficient credits|payment required)\b/.test(message)) return error
  const statusCode = typeof value.status === "number" ? value.status : retryStatus
  return {
    name: retryStatus === undefined ? value.type : "APIError",
    message: value.message,
    data: { message: value.message, ...(statusCode === undefined ? {} : { statusCode }) },
  }
}

interface V2Content {
  type?: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  uri?: string
  name?: string
  state?: { status?: string }
}

interface V2Message {
  id?: string
  type?: string
  parentID?: string
  error?: unknown
  finish?: string
  time?: { created?: number; completed?: number }
  content?: V2Content[]
  text?: string
  files?: Array<{ uri?: string; name?: string; mime?: string; data?: string; source?: { type?: string; uri?: string } }>
  outcome?: "succeeded" | "failed" | "interrupted"
}

export function normalizeV2Messages(sessionID: string, messages: unknown): MessageLike[] {
  if (!Array.isArray(messages)) return []
  const source = messages as V2Message[]
  const normalized = source.filter((message) => message.type === "user" || message.type === "assistant").map((message) => {
    const content: V2Content[] = message.content ?? [
      ...(typeof message.text === "string" ? [{ type: "text", text: message.text }] : []),
      ...(message.files?.map((file) => ({ type: "file", url: file.source?.uri ?? file.uri ?? (file.data ? `data:${file.mime ?? "application/octet-stream"};base64,${file.data}` : undefined), filename: file.name, mime: file.mime })) ?? []),
    ]
    return {
      info: {
        id: message.id, sessionID, role: message.type, parentID: message.parentID,
        error: normalizeV2Error(message.error), finish: message.finish ?? (message.time?.completed ? "stop" : undefined),
        time: message.time,
      },
      parts: content.map((part) => ({
        type: part.type, text: part.text, mime: part.mime, filename: part.filename, url: part.url ?? part.uri,
        name: part.name, state: part.state?.status ? { status: part.state.status === "streaming" ? "pending" : part.state.status } : undefined,
      })) as unknown as MessageLike["parts"],
    }
  })
  const idle = source.at(-1)
  const assistant = [...normalized].reverse().find((message) => message.info?.role === "assistant")
  if (idle?.type === "idle" && idle.outcome === "failed" && assistant?.info) {
    assistant.info.error ??= normalizeV2Error(idle.error)
    assistant.info.finish ??= "error"
  }
  return normalized
}
