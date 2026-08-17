import { JsonObjectSchema, type JsonObject, type JsonValue } from './json.js'

export type ServerSentEvent = JsonObject

export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      if (done && buffer.trim()) {
        blocks.push(buffer)
        buffer = ''
      }
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data && data !== '[DONE]') {
          // Keepalives and vendor extensions send non-JSON data lines; one of
          // those aborting the whole stream mid-turn is worse than skipping it.
          let value: JsonValue
          try {
            value = JSON.parse(data)
          } catch {
            continue
          }
          const event = JsonObjectSchema.safeParse(value)
          if (event.success) yield event.data
        }
      }
      if (done) break
    }
  } finally {
    // An early generator exit (throw, break in the consumer) must release the
    // connection instead of leaking the socket. cancel(), not releaseLock():
    // releasing the lock alone leaves the stream — and the fetch behind it —
    // open until garbage collection.
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * A thrown HTTP failure that carries the body's actual reason — "credit
 * balance too low" is actionable where a bare status code is not. Error
 * bodies can echo credentials back, so everything in `redact` is stripped
 * before the text can reach a log or a toast.
 */
export async function httpError(
  vendor: string,
  response: Response,
  redact: readonly string[] = [],
): Promise<string> {
  const body = await response.text().catch(() => '')
  const detail = redact
    .filter((secret) => secret.length > 0)
    .reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), body.trim().slice(0, 400))
  return `${vendor} request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}
