export type ServerSentEvent = Record<string, unknown>

export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') {
        const value: unknown = JSON.parse(data)
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          yield value as ServerSentEvent
        }
      }
    }
    if (done) break
  }
}
