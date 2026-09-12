import { fontFamilyFromPreference, fontPreferenceForFamily } from './theme.js'

type LocalFontRecord = {
  family?: unknown
}

type LocalFontGlobal = typeof globalThis & {
  queryLocalFonts?: () => Promise<unknown>
}

const CACHE_KEY = 'harness.installed-font-families.v1'
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1_000
type FontCache = { savedAt: number; families: readonly string[] }
let memoryCache: FontCache | undefined
let storageUnavailable = false
let pending: Promise<readonly string[]> | undefined

function readCache(): FontCache | undefined {
  if (storageUnavailable) return memoryCache
  let raw: string | null
  try {
    raw = localStorage.getItem(CACHE_KEY)
  } catch {
    storageUnavailable = true
    return memoryCache
  }
  if (!raw) return undefined
  try {
    const cache: unknown = JSON.parse(raw)
    if (
      typeof cache !== 'object' ||
      cache === null ||
      !('savedAt' in cache) ||
      typeof cache.savedAt !== 'number' ||
      !Number.isFinite(cache.savedAt) ||
      cache.savedAt < 0 ||
      cache.savedAt > Date.now() ||
      !('families' in cache) ||
      !Array.isArray(cache.families) ||
      !cache.families.every(
        (family: unknown) =>
          typeof family === 'string' && fontPreferenceForFamily(family) === `local:${family}`,
      )
    ) {
      return undefined
    }
    return { savedAt: cache.savedAt, families: cache.families }
  } catch {
    return undefined
  }
}

/** A stale complete list stays usable while the next open refreshes it. */
export function readInstalledFontFamilies(): readonly string[] | undefined {
  if (typeof (globalThis as LocalFontGlobal).queryLocalFonts !== 'function') return []
  return readCache()?.families
}

/**
 * Chromium returns one record per face, so a family with regular, italic and
 * bold faces appears several times. The interface picker operates on families
 * and keeps the operating system's full set in a stable alphabetical order.
 */
export function listInstalledFontFamilies(): Promise<readonly string[]> {
  const queryLocalFonts = (globalThis as LocalFontGlobal).queryLocalFonts
  if (typeof queryLocalFonts !== 'function') return Promise.resolve([])
  if (pending) return pending

  const cached = readCache()
  if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
    return Promise.resolve(cached.families)
  }

  pending = queryInstalledFontFamilies(queryLocalFonts)
    .then((families) => {
      if (!families) return cached?.families ?? []
      memoryCache = { savedAt: Date.now(), families }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache))
      } catch {
        // Keep this session fast when storage is full or disabled.
        storageUnavailable = true
      }
      return families
    })
    .finally(() => {
      pending = undefined
    })
  return pending
}

async function queryInstalledFontFamilies(
  queryLocalFonts: () => Promise<unknown>,
): Promise<readonly string[] | undefined> {
  try {
    const records = await queryLocalFonts.call(globalThis)
    if (!Array.isArray(records)) return undefined

    const families = new Map<string, string>()
    for (const record of records as LocalFontRecord[]) {
      if (typeof record?.family !== 'string') continue
      const preference = fontPreferenceForFamily(record.family)
      if (!preference) continue
      const family = fontFamilyFromPreference(preference)
      if (!family) continue
      const key = family.normalize('NFKC').toLocaleLowerCase('en-US')
      if (!families.has(key)) families.set(key, family)
    }

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    return [...families.values()].sort(collator.compare)
  } catch {
    // Browsers may reject when local font access is unsupported or denied. The
    // bundled presets remain usable, so opening Appearance must never fail.
    return undefined
  }
}
