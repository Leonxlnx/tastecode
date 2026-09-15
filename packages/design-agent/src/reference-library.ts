import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesignBrief } from './brief.js'
import { PAGE_LAYOUT_FAMILIES } from './page.js'
import { array, member, record, string, strings } from './parse.js'
import type { ReferenceDirection } from './reference-directions.js'
import { readRasterMetadata } from './raster-metadata.js'
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
  throw new Error(
    'Design reference library is not configured. Set TASTECODE_REFERENCE_LIBRARY or libraryPath in ~/.tastecode/design-references.json, then restart Design mode. You can also attach your own reference images.',
  )
}

export function loadReviewedReferences(root = referenceLibraryRoot()): ReferenceDirection[] {
  try {
    const catalog = record(
      JSON.parse(readWorkspaceFile(path.join(root, 'catalog.json'), 2_000_000).toString()),
      'reference catalog',
    )
    if (catalog.version !== 1) throw new Error('catalog version must be 1')
    const entries = array(catalog.references, 'catalog.references')
    if (entries.length > 10_000) throw new Error('catalog exceeds 10000 entries')
    const approved = entries.filter((value) => {
      const entry = record(value, 'reference')
      return (
        entry.reviewStatus === 'reviewed' &&
        ![entry.imagePath, entry.mobileImagePath].some(
          (file) => typeof file === 'string' && /(?:^|[\\/])threshold-/iu.test(file),
        )
      )
    })
    // Parse each entry independently; the per-turn deck has a separate 64-reference bound.
    const references = approved.flatMap((value) => {
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
    if (!references.length) throw new Error('catalog has no visually reviewed references')
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
      `Design reference library could not be loaded: ${error instanceof Error ? error.message : String(error)}. Repair catalog.json or its files, then restart Design mode.`,
    )
  }
}

export function selectReviewedReferences(
  brief: DesignBrief,
  references = loadReviewedReferences(),
): ReferenceDirection[] {
  const request = JSON.stringify(brief).toLowerCase()
  const words = new Set(request.match(/[\p{L}\p{N}]+/gu) ?? [])
  const score = (entry: ReferenceDirection) =>
    (request.includes(entry.id.toLowerCase()) ? 1000 : 0) +
    (entry.source && request.includes(entry.source.toLowerCase()) ? 500 : 0) +
    (entry.tags ?? []).reduce((total, tag) => total + (words.has(tag.toLowerCase()) ? 1 : 0), 0)
  const ranked = [...references].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  const preferred = ranked[0]
  if (!preferred) throw new Error('No reviewed Design references are available')
  const selected: ReferenceDirection[] = []
  const groups = new Set<string>()
  const families = new Set<string>()
  // A group identifies revisions of one section, not a site. One revision gets one vote.
  for (const entry of ranked) {
    const explicit =
      request.includes(entry.id.toLowerCase()) ||
      !!(entry.source && request.includes(entry.source.toLowerCase()))
    const compatible = (entry.tags ?? []).filter((tag) => preferred.tags?.includes(tag)).length >= 2
    if (
      entry.source !== preferred.source &&
      !explicit &&
      (!compatible || families.has(entry.family))
    )
      continue
    const group = entry.group ?? entry.id
    if (groups.has(group)) continue
    groups.add(group)
    families.add(entry.family)
    selected.push(entry)
  }
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
