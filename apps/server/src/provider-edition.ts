import type { ProviderId } from '@harness/contracts'

/**
 * Which providers this build offers.
 *
 * The packaged desktop passes HARNESS_EDITION: `release` for public builds,
 * `dev` for the developer scripts. Every provider's code ships in both; a
 * release build only leaves the others out of the listings and refuses to
 * start them, so promotion between branches never has to delete adapters.
 * Unset (pnpm dev, `pnpm harness`) offers what a dev build offers.
 */
const RELEASE_PROVIDERS: readonly ProviderId[] = [
  'claude-code',
  'codex',
  'grok',
  'cursor',
  'antigravity',
]

/**
 * Providers no build offers for now, whatever its edition. They are treated
 * like a provider a release build leaves out: missing from every listing and
 * refused to install, sign in to or start, while their adapters stay and
 * their old chats stay readable. Bringing one back is deleting its line here.
 *
 * OpenCode: Leon, 2026-11-03.
 */
const WITHHELD_PROVIDERS: readonly ProviderId[] = ['opencode']

/** The edition's own providers; undefined offers every provider not withheld. */
let offered: ReadonlySet<ProviderId> | undefined
/**
 * Empty until the server reads its edition. Unit tests of other modules never
 * do, so they still drive every adapter, the withheld ones included.
 */
let withheld: ReadonlySet<ProviderId> = new Set()

/**
 * Reads the edition once and removes it from the environment, so agent CLIs
 * and terminals started by this server do not inherit it.
 */
export function takeEdition(env: NodeJS.ProcessEnv): void {
  const edition = env['HARNESS_EDITION']
  delete env['HARNESS_EDITION']
  if (edition && edition !== 'dev' && edition !== 'release') {
    throw new Error(`Unknown HARNESS_EDITION "${edition}".`)
  }
  withheld = new Set(WITHHELD_PROVIDERS)
  offered = edition === 'release' ? new Set(RELEASE_PROVIDERS) : undefined
}

/** Back to the state before any edition was read: every provider offered. */
export function resetEditionForTests(): void {
  offered = undefined
  withheld = new Set()
}

export function providerOffered(provider: ProviderId): boolean {
  return !withheld.has(provider) && (!offered || offered.has(provider))
}

export function assertProviderOffered(provider: ProviderId): void {
  if (!providerOffered(provider)) {
    throw new Error(`${provider} is not part of this TasteCode build. This chat stays readable.`)
  }
}
