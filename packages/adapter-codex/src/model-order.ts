import type { Model } from '@harness/contracts'

/**
 * Codex names its lineup `gpt-<generation>-<tier>`, such as `gpt-6.1-sol`.
 * Tiers run from the most capable to the smallest.
 */
const CODEX_TIERS = ['astra', 'sol', 'terra', 'luna']
const CODEX_TIERED_ID = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)$/

type Release = { tier: number; major: number; minor: number }

function codexRelease(id: string): Release | undefined {
  const match = CODEX_TIERED_ID.exec(id)
  if (!match) return undefined
  const tier = CODEX_TIERS.indexOf(match[3]!)
  if (tier < 0) return undefined
  return { tier, major: Number(match[1]), minor: Number(match[2] ?? 0) }
}

function compareGenerations(left: Release, right: Release): number {
  return right.major - left.major || right.minor - left.minor
}

/**
 * The newest generation of each tier comes first, in tier order (Astra, Sol,
 * Terra, Luna). Older generations follow, newest first and in tier order
 * within one generation. Anything else, such as a tier Codex adds later or an
 * untiered legacy model, keeps Codex's own order after them.
 */
export function orderCodexModels(models: readonly Model[]): Model[] {
  const releases = new Map(models.map((model) => [model, codexRelease(model.id)]))
  const newest = new Map<number, Release>()
  for (const release of releases.values()) {
    if (!release) continue
    const current = newest.get(release.tier)
    if (!current || compareGenerations(release, current) < 0) newest.set(release.tier, release)
  }
  const group = (release: Release | undefined) => {
    if (!release) return 2
    return compareGenerations(release, newest.get(release.tier)!) === 0 ? 0 : 1
  }
  // Array sort is stable, so rows that compare equal keep Codex's order.
  return [...models].sort((left, right) => {
    const leftRelease = releases.get(left)
    const rightRelease = releases.get(right)
    const leftGroup = group(leftRelease)
    const rightGroup = group(rightRelease)
    if (leftGroup !== rightGroup) return leftGroup - rightGroup
    if (!leftRelease || !rightRelease) return 0
    if (leftGroup === 0) return leftRelease.tier - rightRelease.tier
    return compareGenerations(leftRelease, rightRelease) || leftRelease.tier - rightRelease.tier
  })
}
