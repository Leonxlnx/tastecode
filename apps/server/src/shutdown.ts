import { OWNED_PROCESS_SHUTDOWN_MESSAGE } from '@harness/proc'

type ShutdownSignal = 'SIGINT' | 'SIGTERM'

type ShutdownProcess = {
  once(signal: ShutdownSignal, handler: () => void): unknown
  on(event: 'message', handler: (message: unknown) => void): unknown
  exit(code: number): unknown
}

export function installShutdownHandlers(
  server: { close(): Promise<void> },
  runtime: ShutdownProcess = process,
  report: (message: string) => void = console.error,
): void {
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    void server.close().then(
      () => runtime.exit(0),
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        report(`[server] shutdown failed: ${detail}`)
        runtime.exit(1)
      },
    )
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) runtime.once(signal, close)
  runtime.on('message', (message) => {
    if (message === OWNED_PROCESS_SHUTDOWN_MESSAGE) close()
  })
}
