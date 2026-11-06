import type { ParamsOf } from '@harness/contracts'
import { canCapturePreview, isDesktop } from './bridge.js'

/** The chats whose own browser tab this window shows, one entry per workspace panel. */
const shown = new Map<symbol, string>()

/**
 * What this window tells the server it can do. The desktop app runs agent browser commands on a
 * chat's own tab; the server sends them only for the chats listed here.
 */
export function clientCapabilities(): ParamsOf<'client.capabilities'> {
  return {
    previewCapture: canCapturePreview,
    ...(isDesktop
      ? { browserTools: true, browserThreads: [...new Set(shown.values())].slice(0, 16) }
      : {}),
  }
}

/**
 * A workspace panel shows this chat; the returned function says it stopped. Each change is sent
 * at once, on a chat switch, never per streamed event.
 */
export function showBrowserThread(
  send: (capabilities: ParamsOf<'client.capabilities'>) => Promise<unknown>,
  threadId: string,
): () => void {
  const key = Symbol(threadId)
  shown.set(key, threadId)
  void send(clientCapabilities()).catch(() => undefined)
  return () => {
    shown.delete(key)
    void send(clientCapabilities()).catch(() => undefined)
  }
}
