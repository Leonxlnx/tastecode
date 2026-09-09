import { fontFamilyFromPreference, fontPreferenceForFamily } from './theme.js'

type LocalFontRecord = {
  family?: unknown
}

type LocalFontGlobal = typeof globalThis & {
  queryLocalFonts?: () => Promise<unknown>
}

/**
 * Chromium returns one record per face, so a family with regular, italic and
 * bold faces appears several times. The interface picker operates on families
 * and keeps the operating system's full set in a stable alphabetical order.
 */
export async function listInstalledFontFamilies(): Promise<string[]> {
  const queryLocalFonts = (globalThis as LocalFontGlobal).queryLocalFonts
  if (typeof queryLocalFonts !== 'function') return []

  try {
    const records = await queryLocalFonts.call(globalThis)
    if (!Array.isArray(records)) return []

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

    return [...families.values()].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }),
    )
  } catch {
    // Browsers may reject when local font access is unsupported or denied. The
    // bundled presets remain usable, so opening Appearance must never fail.
    return []
  }
}
