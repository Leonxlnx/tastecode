import { spawnOwned, StdioJsonRpc } from '@harness/proc'
import { grokCommand } from './adapter.js'

const TIMEOUT_MS = 10_000

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer in time`)), TIMEOUT_MS)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * One call to a Grok Build ACP extension in a short-lived provider process.
 * The process owns its credentials, request headers and token refresh
 * lifecycle; TasteCode only receives the response it deliberately exposes.
 */
export async function requestGrokExtension(method: string, label: string): Promise<unknown> {
  const child = spawnOwned(grokCommand(), ['agent', '--no-leader', 'stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const rpc = new StdioJsonRpc(child, label)
  try {
    await bounded(
      rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'tastecode', version: '0.0.0' },
      }),
      label,
    )
    return await bounded(rpc.request(method, {}), label)
  } finally {
    await rpc.dispose()
  }
}
