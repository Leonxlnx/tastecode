import { readSseData } from '@harness/proc'
import { isJsonObject, parseJsonValue, type JsonObject, type JsonValue } from './json.js'

export type ServerSentEvent = JsonObject

export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  for await (const data of readSseData(body)) {
    if (!data || data === '[DONE]') continue
    let value: JsonValue
    try {
      value = parseJsonValue(data)
    } catch {
      continue
    }
    if (isJsonObject(value)) yield value
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
  const { body, incomplete } = await readErrorBody(response)
  let detail = redact
    .filter((secret) => secret.length > 0)
    .toSorted((a, b) => b.length - a.length)
    .reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), body)
  if (incomplete) {
    // The byte/time bound can split a credential. Hide any unfinished suffix
    // before the final display limit can expose that prefix.
    for (const secret of redact) {
      for (let length = Math.min(secret.length - 1, detail.length); length > 0; length--) {
        if (detail.endsWith(secret.slice(0, length))) {
          detail = `${detail.slice(0, -length)}[REDACTED]`
          break
        }
      }
    }
  }
  detail = detail.trim().slice(0, 400)
  return `${vendor} request failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`
}

const MAX_ERROR_BODY_BYTES = 64 * 1024
const ERROR_BODY_TIMEOUT_MS = 1_000

async function readErrorBody(response: Response): Promise<{ body: string; incomplete: boolean }> {
  if (!response.body) return { body: '', incomplete: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('error body timed out')), ERROR_BODY_TIMEOUT_MS)
  })
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await Promise.race([reader.read(), timeout])
      if (done) return { body: body + decoder.decode(), incomplete: false }
      const part = value.subarray(0, MAX_ERROR_BODY_BYTES - bytes)
      bytes += part.byteLength
      body += decoder.decode(part, { stream: true })
    }
  } catch {
    // Public status remains useful when the body is stalled or broken.
  } finally {
    clearTimeout(timer)
    // A custom response stream may never finish cancellation; do not let it
    // keep an otherwise bounded error request alive.
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return { body, incomplete: true }
}
