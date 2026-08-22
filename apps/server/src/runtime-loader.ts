import type {
  CustomHarness,
  CustomHarnessVerification,
  ProviderId,
  StoredModelConnection,
} from '@harness/contracts'
import type { AgentSession, ProviderRuntime, StartOptions, TurnOptions } from './adapters.js'

type AdaptersModule = typeof import('./adapters.js')

let adaptersModule: Promise<AdaptersModule> | undefined

function loadAdapters(): Promise<AdaptersModule> {
  return (adaptersModule ??= import('./adapters.js'))
}

function deferredRuntime(
  load: () => Promise<ProviderRuntime>,
  supportsResume: boolean,
): ProviderRuntime {
  let runtime: Promise<ProviderRuntime> | undefined
  const resolve = () => (runtime ??= load())
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

const SUPPORTED_PROVIDERS = new Set<ProviderId>([
  'acp',
  'antigravity',
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'opencode',
  'pi',
])

const RESUMABLE_PROVIDERS = new Set<ProviderId>([
  'acp',
  'claude-code',
  'codex',
  'cursor',
  'grok',
  'opencode',
])

export function providerRuntime(
  provider: ProviderId,
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined = () => undefined,
): ProviderRuntime {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`provider "${provider}" is not implemented yet`)
  }
  return deferredRuntime(
    async () => (await loadAdapters()).providerRuntime(provider, onLog, resolveHarness),
    RESUMABLE_PROVIDERS.has(provider),
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
