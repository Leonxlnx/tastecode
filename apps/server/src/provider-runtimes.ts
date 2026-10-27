import { CLAUDE_CAPABILITIES } from '@harness/adapter-claude-code/capabilities'
import { CODEX_CAPABILITIES } from '@harness/adapter-codex/capabilities'
import { GROK_CAPABILITIES } from '@harness/adapter-grok/capabilities'
import type { ProviderId, ProviderRuntimeOption } from '@harness/contracts'

/** What each adapter declared; these modules are constants, not vendor SDKs. */
const RUNTIMES = {
  codex: CODEX_CAPABILITIES.runtimes,
  'claude-code': CLAUDE_CAPABILITIES.runtimes,
  grok: GROK_CAPABILITIES.runtimes,
  cursor: undefined,
  opencode: undefined,
  antigravity: undefined,
  pi: undefined,
  acp: undefined,
  api: undefined,
} satisfies Readonly<Record<ProviderId, readonly ProviderRuntimeOption[] | undefined>>

export function providerRuntimes(provider: ProviderId): readonly ProviderRuntimeOption[] {
  return RUNTIMES[provider] ?? []
}

/** Refuses a runtime the provider never declared, before it is stored. */
export function validateRuntime(provider: ProviderId, runtime: string | null): void {
  if (runtime === null) return
  if (!providerRuntimes(provider).some((option) => option.id === runtime))
    throw new Error(`This provider cannot run through "${runtime}".`)
}

/**
 * What a launch receives. The default runs without one, and a runtime stored
 * while an older engine declared it is dropped quietly once the engine no
 * longer does, so an update never leaves sessions that refuse to start.
 */
export function runtimeForLaunch(
  provider: ProviderId,
  runtime: string | undefined,
): string | undefined {
  const [defaultRuntime, ...others] = providerRuntimes(provider)
  if (!defaultRuntime || runtime === defaultRuntime.id) return undefined
  return others.some((option) => option.id === runtime) ? runtime : undefined
}
