import type { ProviderId } from '@harness/contracts'

/**
 * Which providers this build offers.
 *
 * The packaged desktop passes HARNESS_EDITION: `release` for public builds,
 * `dev` for the developer scripts. Every provider's code ships in both; a
 * release build only leaves the others out of the listings and refuses to
 * start them, so promotion between branches never has to delete adapters.
 * Unset (pnpm dev, `pnpm harness`, tests) offers every provider.
 */
const RELEASE_PROVIDERS: readonly ProviderId[] = [
  'claude-code',
  'codex',
  'grok',
  'cursor',
  'antigravity',
]

let offered: ReadonlySet<ProviderId> | undefined

/**
 * Reads the edition once and removes it from the environment, so agent CLIs
 * and terminals started by this server do not inherit it.
 */
export function takeEdition(env: NodeJS.ProcessEnv): void {
  const edition = env['HARNESS_EDITION']
  delete env['HARNESS_EDITION']
  if (!edition || edition === 'dev') {
    offered = undefined
    return
  }
  if (edition !== 'release') throw new Error(`Unknown HARNESS_EDITION "${edition}".`)
  offered = new Set(RELEASE_PROVIDERS)
}

export function providerOffered(provider: ProviderId): boolean {
  return !offered || offered.has(provider)
}

export function assertProviderOffered(provider: ProviderId): void {
  if (!providerOffered(provider)) {
    throw new Error(`${provider} is not part of this TasteCode build. This chat stays readable.`)
  }
}
