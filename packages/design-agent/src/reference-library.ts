import { randomInt } from 'node:crypto'
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
  chooseIndex: (length: number) => number = randomInt,
): ReferenceDirection[] {
  const request = JSON.stringify(brief).toLowerCase()
  const words = new Set(request.match(/[\p{L}\p{N}]+/gu) ?? [])
  const score = (entry: ReferenceDirection) =>
    (request.includes(entry.id.toLowerCase()) ? 1000 : 0) +
    (entry.source && request.includes(entry.source.toLowerCase()) ? 500 : 0) +
    (entry.tags ?? []).reduce((total, tag) => total + (words.has(tag.toLowerCase()) ? 1 : 0), 0)
  const ranked = [...references].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
  if (!ranked.length) throw new Error('No reviewed Design references are available')
  const best = score(ranked[0]!)
  const preferredPool = ranked.filter((entry) => score(entry) === best)
  const preferred = preferredPool[chooseIndex(preferredPool.length)]
  if (!preferred) throw new Error('No reviewed Design references are available')
  const selected: ReferenceDirection[] = []
  const groups = new Set<string>()
  const sectionContent = brief.requiredContent.join(' ').toLowerCase()
  const requestedFamilies = PAGE_LAYOUT_FAMILIES.filter((family) => {
    const names = {
      hero: /\bhero\b/u,
      about: /\b(?:about|introduction|story)\b/u,
      feature: /\b(?:features?|services?|capabilities|projects?|products?)\b/u,
      how_it_works: /\b(?:process|steps|how it works)\b/u,
      social_proof: /\b(?:testimonials?|clients?|social proof)\b/u,
      stats: /\b(?:statistics|stats|metrics|numbers)\b/u,
      faq: /\b(?:faq|frequently asked|questions)\b/u,
      cta: /\b(?:cta|call to action|contact|invitation)\b/u,
      pricing: /\b(?:pricing|plans|packages)\b/u,
      contact: /\b(?:contact form|inquiry form|enquiry form)\b/u,
      footer: /\bfooter\b/u,
    }
    return names[family].test(sectionContent)
  })
  // A group identifies revisions of one section, not a site. One revision gets one vote.
  const candidates = ranked.filter((entry) => {
    const explicit =
      request.includes(entry.id.toLowerCase()) ||
      !!(entry.source && request.includes(entry.source.toLowerCase()))
    const compatible = (entry.tags ?? []).filter((tag) => preferred.tags?.includes(tag)).length >= 2
    return explicit || entry.source === preferred.source || compatible
  })
  for (const family of PAGE_LAYOUT_FAMILIES) {
    if (
      requestedFamilies.length &&
      !requestedFamilies.includes(family) &&
      !references.some(
        (entry) => entry.family === family && request.includes(entry.id.toLowerCase()),
      )
    )
      continue
    const compatibleEntries = candidates.filter((entry) => entry.family === family)
    // A style preference must not remove content the user requested. Brand adaptation
    // unifies a reviewed fallback when that collection has no composition for the family.
    const familyEntries = compatibleEntries.length
      ? compatibleEntries
      : ranked.filter((entry) => entry.family === family)
    if (!familyEntries.length) continue
    const explicit = familyEntries.filter((entry) => request.includes(entry.id.toLowerCase()))
    // Revisions share a vote: choose a group first, then its reviewed revision.
    const pool = explicit.length ? explicit : familyEntries
    const groupNames = [...new Set(pool.map((entry) => entry.group ?? entry.id))]
    const chosenGroup = groupNames[chooseIndex(groupNames.length)]
    const revisions = pool.filter((entry) => (entry.group ?? entry.id) === chosenGroup)
    const entry = revisions[chooseIndex(revisions.length)]!
    const group = entry.group ?? entry.id
    if (groups.has(group)) continue
    groups.add(group)
    selected.push(entry)
  }
  if (!selected.length)
    throw new Error(
      'No reviewed references match the requested sections. Add matching catalog entries or attach your own reference images.',
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
