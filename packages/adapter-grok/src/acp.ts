import { spawnOwned, StdioJsonRpc } from '@harness/proc'
import { commandOverride, spawnCli } from '@harness/proc/cli'
import { grokAccountEnvironment } from './account-home.js'
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
 * `accountHome` runs it as that account; absent, the default account.
 */
export async function requestGrokExtension(
  method: string,
  label: string,
  accountHome?: string,
): Promise<unknown> {
  const options = {
    ...(accountHome === undefined
      ? {}
      : { env: { ...process.env, ...grokAccountEnvironment(accountHome) } }),
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }
  const args = ['agent', '--no-leader', 'stdio']
  const child = commandOverride('grok')
    ? spawnCli(grokCommand(), args, options)
    : spawnOwned(grokCommand(), args, options)
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
