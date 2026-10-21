import type { CustomHarness, CustomHarnessVerification, ProviderId } from '@harness/contracts'
import type {
  AgentSession,
  ProviderRuntime,
  SavedSession,
  StartOptions,
  TurnOptions,
} from './adapters.js'
import { retryableLazy } from './retryable-lazy.js'
import { PROVIDER_CAPABILITIES } from './provider-capabilities.js'

type AdaptersModule = typeof import('./adapters.js')

let adaptersRequested = false
const loadAdapters = retryableLazy<AdaptersModule>(() => {
  adaptersRequested = true
  return import('./adapters.js')
})

/** Stops model listings still running; none can run before a runtime was loaded. */
export async function stopModelListings(): Promise<void> {
  if (!adaptersRequested) return
  await (await loadAdapters()).stopModelListings()
}

function deferredRuntime(
  load: () => Promise<ProviderRuntime>,
  supportsResume: boolean,
  supportsFork = false,
): ProviderRuntime {
  const resolve = retryableLazy(load)
  const deferred: ProviderRuntime = {
    async start(workspacePath, options) {
      return (await resolve()).start(workspacePath, options)
    },
    async listModels(agent, read) {
      return (await resolve()).listModels(agent, read)
    },
  }
  if (supportsResume) {
    deferred.resume = async (threadId, workspacePath, options) => {
      const loaded = await resolve()
      if (!loaded.resume) throw new Error('provider runtime cannot resume')
      return loaded.resume(threadId, workspacePath, options)
    }
  }
  if (supportsFork) {
    deferred.fork = async (workspacePath, from, options) => {
      const loaded = await resolve()
      if (!loaded.fork) throw new Error('provider runtime cannot carry a session on')
      return loaded.fork(workspacePath, from, options)
    }
  }
  return deferred
}

export function providerRuntime(
  provider: ProviderId,
  onLog: (line: string) => void,
  resolveHarness: (id: string) => CustomHarness | undefined = () => undefined,
  accountHome?: string,
): ProviderRuntime {
  if (provider === 'api') {
    throw new Error(
      'API key connections were removed from TasteCode. This chat stays readable; to use your own key, sign in to OpenCode with it.',
    )
  }
  const { resume, forkSession } = PROVIDER_CAPABILITIES[provider]
  return deferredRuntime(
    async () =>
      (await loadAdapters()).providerRuntime(provider, onLog, resolveHarness, accountHome),
    resume,
    forkSession,
  )
}

export async function verifyCustomHarness(
  harness: CustomHarness,
  workspacePath?: string,
  onLog?: (line: string) => void,
): Promise<CustomHarnessVerification> {
  return (await loadAdapters()).verifyCustomHarness(harness, workspacePath, onLog)
}

export type { AgentSession, ProviderRuntime, SavedSession, StartOptions, TurnOptions }
