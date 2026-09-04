import type {
  CustomHarness,
  CustomHarnessVerification,
  ProviderId,
  StoredModelConnection,
} from '@harness/contracts'
import type { AgentSession, ProviderRuntime, StartOptions, TurnOptions } from './adapters.js'
import { retryableLazy } from './retryable-lazy.js'

type AdaptersModule = typeof import('./adapters.js')

const loadAdapters = retryableLazy<AdaptersModule>(() => import('./adapters.js'))

function deferredRuntime(
  load: () => Promise<ProviderRuntime>,
  supportsResume: boolean,
): ProviderRuntime {
  const resolve = retryableLazy(load)
  const deferred: ProviderRuntime = {
    async start(workspacePath, options) {
      return (await resolve()).start(workspacePath, options)
    },
    async listModels(agent) {
      return (await resolve()).listModels(agent)
    },
  }
  if (supportsResume) {
    deferred.resume = async (threadId, workspacePath, options) => {
      const loaded = await resolve()
      if (!loaded.resume) throw new Error('provider runtime cannot resume')
      return loaded.resume(threadId, workspacePath, options)
    }
  }
  return deferred
}

const PROVIDER_RESUME_SUPPORT = {
  acp: true,
  antigravity: false,
  'claude-code': true,
  codex: true,
  cursor: true,
  grok: true,
  opencode: true,
  pi: false,
} satisfies Record<Exclude<ProviderId, 'api'>, boolean>

export function providerRuntime(
  provider: ProviderId,
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined = () => undefined,
): ProviderRuntime {
  if (provider === 'api') {
    throw new Error(`provider "${provider}" is not implemented yet`)
  }
  const supportsResume = PROVIDER_RESUME_SUPPORT[provider]
  return deferredRuntime(
    async () => (await loadAdapters()).providerRuntime(provider, onLog, resolveHarness),
    supportsResume,
  )
}

export function apiRuntime(
  connection: StoredModelConnection,
  apiKey: string,
  onLog: (line: string) => void,
): ProviderRuntime {
  return deferredRuntime(
    async () => (await loadAdapters()).apiRuntime(connection, apiKey, onLog),
    false,
  )
}

export async function verifyCustomHarness(
  harness: CustomHarness,
  workspacePath?: string,
  onLog?: (line: string) => void,
): Promise<CustomHarnessVerification> {
  return (await loadAdapters()).verifyCustomHarness(harness, workspacePath, onLog)
}

export type { AgentSession, ProviderRuntime, StartOptions, TurnOptions }
