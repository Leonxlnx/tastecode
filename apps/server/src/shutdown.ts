type ShutdownSignal = 'SIGINT' | 'SIGTERM'

type ShutdownProcess = {
  once(signal: ShutdownSignal, handler: () => void): unknown
  exit(code: number): unknown
}

export function installShutdownHandlers(
  server: { close(): Promise<void> },
  runtime: ShutdownProcess = process,
  report: (message: string) => void = console.error,
): void {
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    runtime.once(signal, () => {
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
    })
  }
}
