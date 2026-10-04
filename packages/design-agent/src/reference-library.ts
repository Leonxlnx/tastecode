import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDashboardBrief, type DesignBrief } from './brief.js'
import { PAGE_LAYOUT_FAMILIES, WEBSITE_LAYOUT_FAMILIES, type PageLayoutFamily } from './page.js'
import { array, member, record, string, strings } from './parse.js'
import type { ReferenceDirection } from './reference-directions.js'
import { readRasterMetadata } from './raster-metadata.js'
import { generatedReferenceCandidates } from './reference-library-index.js'
import { containedWorkspaceFile, readWorkspaceFile } from './workspace-files.js'

export function parseReferenceDeck(value: unknown): ReferenceDirection[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid Design reference deck')
  const ids = new Set<string>()
  return value.map((value) => {
    const entry = record(value, 'Design reference')
    const id = string(entry.id, 'reference id')
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/u.test(id) || ids.has(id))
      throw new Error(`Invalid or duplicate Design reference id: ${id}`)
    ids.add(id)
    return {
      id,
      family: member(entry.family, PAGE_LAYOUT_FAMILIES, `${id}.family`),
      cue: string(entry.cue, `${id}.cue`),
      imagePath: string(entry.imagePath, `${id}.imagePath`),
      ...(entry.mobileImagePath
        ? { mobileImagePath: string(entry.mobileImagePath, `${id}.mobileImagePath`) }
        : {}),
      ...(entry.source ? { source: string(entry.source, `${id}.source`) } : {}),
      ...(entry.group ? { group: string(entry.group, `${id}.group`) } : {}),
      ...(entry.tags ? { tags: strings(entry.tags, `${id}.tags`) } : {}),
    }
  })
}

/** The location is user configuration, never a path taken from an opened project. */
export function referenceLibraryRoot(): string {
  if (process.env.TASTECODE_REFERENCE_LIBRARY)
    return path.resolve(process.env.TASTECODE_REFERENCE_LIBRARY)
  const configPath = path.join(os.homedir(), '.tastecode', 'design-references.json')
  if (existsSync(configPath)) {
    const config = record(
      JSON.parse(readWorkspaceFile(configPath, 16_384).toString()),
      'Design reference configuration',
    )
    const root = string(config.libraryPath, 'libraryPath')
    if (!path.isAbsolute(root)) throw new Error('Design reference libraryPath must be absolute')
    return root
  }
  const bundled = fileURLToPath(new URL('../references/library/', import.meta.url))
  // Real files retain inode/size checks; Electron's virtual ASAR stats do not.
  const unpacked = bundled.replace(/\.asar([\\/])/u, '.asar.unpacked$1')
  return existsSync(unpacked) ? unpacked : bundled
}

export function loadReviewedReferences(root = referenceLibraryRoot()): ReferenceDirection[] {
  try {
    const catalogFiles = ['catalog.json']
    if (existsSync(path.join(root, 'dashboard-catalog.json')))
      catalogFiles.push('dashboard-catalog.json')
    const listed = catalogFiles.flatMap((file) => {
      const catalog = record(
        JSON.parse(readWorkspaceFile(path.join(root, file), 8_000_000).toString()),
        file,
      )
      if (catalog.version !== 1) throw new Error(`${file} version must be 1`)
      return array(catalog.references, `${file}.references`)
    })
    const listedIds = new Set(listed.map((entry) => record(entry, 'reference').id))
    const entries = [
      ...listed,
      ...generatedReferenceCandidates(root).filter((entry) => !listedIds.has(entry.id)),
    ]
    if (entries.length > 10_000) throw new Error('catalog exceeds 10000 entries')
    const eligible = entries.filter((value) => {
      const entry = record(value, 'reference')
      return (
        (entry.reviewStatus === 'reviewed' || entry.reviewStatus === 'candidate') &&
        (entry.family !== 'dashboard' ||
          (entry.reviewStatus === 'reviewed' &&
            entry.assetType === 'generated-reference' &&
            typeof entry.mobileImagePath === 'string' &&
            entry.mobileImagePath.trim().length > 0)) &&
        ![entry.imagePath, entry.mobileImagePath].some(
          (file) => typeof file === 'string' && /(?:^|[\\/])threshold-/iu.test(file),
        )
      )
    })
    // Parse each entry independently; the per-turn deck has a separate 64-reference bound.
    const references = eligible.flatMap((value) => {
      const entry = record(value, 'reference')
      string(entry.reviewNotes, 'reviewNotes')
      string(entry.group, 'group')
      strings(entry.tags, 'tags')
      const source = new URL(string(entry.source, 'source'))
      if (!['https:', 'http:'].includes(source.protocol))
        throw new Error('reference source must be HTTP(S)')
      if (entry.mobileImagePath) string(entry.pairEvidence, 'pairEvidence')
      const [reference] = parseReferenceDeck([entry])
      return [
        {
          ...reference!,
          cue: `${reference!.cue} Review: ${entry.reviewNotes}${entry.mobileImagePath ? ` Responsive pairing: ${entry.pairEvidence}` : ' No verified mobile reference: derive and visually test the responsive layout from this desktop composition.'}`,
        },
      ]
    })
    if (!references.length)
      throw new Error('catalog has no reviewed or generated reference candidates')
    if (new Set(references.map(({ id }) => id)).size !== references.length)
      throw new Error('duplicate reference IDs')
    return references.map((entry) => ({
      ...entry,
      imagePath: containedWorkspaceFile(root, entry.imagePath, `reference ${entry.id}`),
      ...(entry.mobileImagePath
        ? {
            mobileImagePath: containedWorkspaceFile(
              root,
              entry.mobileImagePath,
              `mobile reference ${entry.id}`,
            ),
          }
        : {}),
    }))
  } catch (error) {
    throw new Error(
      `Design reference library could not be loaded: ${error instanceof Error ? error.message : String(error)}. Repair catalog.json, dashboard-catalog.json or their files, then restart Design mode.`,
    )
  }
}

/** Content topics can use a compatible image's geometry without relabeling that image. */
export function referenceCandidatesForFamily(
  family: PageLayoutFamily,
  references: readonly ReferenceDirection[],
): ReferenceDirection[] {
  const native = references.filter((entry) => entry.family === family)
  if (new Set(native.map((entry) => entry.group ?? entry.id)).size >= 10) return native
  const compatible = {
    stats: ['social_proof', 'about'],
    pricing: ['feature'],
    how_it_works: ['feature', 'about'],
    contact: ['cta'],
    cta: ['contact'],
    faq: ['feature'],
  } as const satisfies Partial<Record<PageLayoutFamily, readonly PageLayoutFamily[]>>
  const alternatives = compatible[family as keyof typeof compatible] ?? []
  const pool = references.filter(
    (entry) =>
      entry.family === family || alternatives.some((candidate) => candidate === entry.family),
  )
  // A deliberately small custom library remains authoritative; never pad it with duplicates.
  return new Set(pool.map((entry) => entry.group ?? entry.id)).size >= 10 ? pool : native
}

export function selectReviewedReferences(
  brief: DesignBrief,
  references = loadReviewedReferences(),
  chooseIndex: (length: number) => number = randomInt,
): ReferenceDirection[] {
  const request =
    `${brief.originalRequest} ${(brief.explicitAnswers ?? []).map((answer) => answer.answer).join(' ')}`.toLowerCase()
  if (!references.length) throw new Error('No Design references are available')
  const dashboard = isDashboardBrief(brief)
  const families: readonly PageLayoutFamily[] = dashboard ? ['dashboard'] : WEBSITE_LAYOUT_FAMILIES
  const sectionReferences = references.filter((entry) => !entry.tags?.includes('native-component'))
  const selected: ReferenceDirection[] = []
  const groups = new Set<string>()
  for (const family of families) {
    // Section titles are free-form and multilingual. Let Page choose the needed
    // compositions from a complete deck instead of discarding families by keywords.
    // Each composition gets the same chance, regardless of source site or style tags.
    const familyEntries = referenceCandidatesForFamily(family, sectionReferences).filter(
      (entry) => !groups.has(entry.group ?? entry.id),
    )
    if (!familyEntries.length) continue
    const explicit = familyEntries.filter((entry) => request.includes(entry.id.toLowerCase()))
    const explicitSource = familyEntries.filter(
      (entry) => entry.source && request.includes(entry.source.toLowerCase()),
    )
    // Revisions share a vote: choose a group first, then its eligible revision.
    const pool = explicit.length ? explicit : explicitSource.length ? explicitSource : familyEntries
    const groupNames = [...new Set(pool.map((entry) => entry.group ?? entry.id))]
    // Repeated content sections need distinct compositions within the same page too.
    const count = Math.min(groupNames.length, family === 'feature' ? 3 : family === 'about' ? 2 : 1)
    for (let index = 0; index < count; index++) {
      const [chosenGroup] = groupNames.splice(chooseIndex(groupNames.length), 1)
      const revisions = pool.filter((entry) => (entry.group ?? entry.id) === chosenGroup)
      const entry = revisions[chooseIndex(revisions.length)]!
      const group = entry.group ?? entry.id
      if (groups.has(group)) continue
      groups.add(group)
      selected.push(
        entry.family === family
          ? entry
          : {
              ...entry,
              cue: `${entry.cue} Sampled for ${family} content from compatible compositions; retain its actual ${entry.family} layout family and image geometry.`,
            },
      )
    }
  }
  if (!selected.length)
    throw new Error(
      dashboard
        ? 'No reviewed dashboard references are available. Add generated desktop/mobile pairs to dashboard-catalog.json.'
        : 'No references match the requested sections. Add matching catalog entries or attach your own reference images.',
    )
  if (selected.length > 24)
    throw new Error(
      'Selected Design reference collection exceeds 24 sections; narrow the catalog collection',
    )
  for (const entry of selected) {
    readRasterMetadata(entry.imagePath)
    if (entry.mobileImagePath) readRasterMetadata(entry.mobileImagePath)
  }
  return selected
}
