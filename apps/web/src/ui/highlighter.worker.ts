import { createHighlighterWorkerRuntime } from './highlighter-worker-runtime.js'
import type { HighlighterRequest, HighlighterResponse } from './highlighter-protocol.js'

const runtime = createHighlighterWorkerRuntime()

globalThis.addEventListener('message', (event: MessageEvent<HighlighterRequest>) => {
  const request = event.data
  void runtime
    .then(async (highlighter): Promise<HighlighterResponse> => {
      if (request.type === 'warm') {
        await highlighter.warm(request.languages)
        return { type: 'warmed', id: request.id }
      }
      const result = await highlighter.highlight(request.code, request.language)
      return { type: 'highlighted', id: request.id, result: result ?? null }
    })
    .then((response) => globalThis.postMessage(response))
    .catch(() =>
      globalThis.postMessage({ type: 'failed', id: request.id } satisfies HighlighterResponse),
    )
})
