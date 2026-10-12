import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDashboardBrief, type DesignBrief } from './brief.js'
import { PAGE_LAYOUT_FAMILIES, WEBSITE_LAYOUT_FAMILIES, type PageLayoutFamily } from './page.js'
import { array, member, record, string, strings } from './parse.js'
import {
  REFERENCE_ROLES,
  type ReferenceDirection,
  type ReferenceRole,
} from './reference-directions.js'
import { readRasterMetadata } from './raster-metadata.js'
import { generatedReferenceCandidates } from './reference-library-index.js'
import {
  referenceRelevance,
  relevanceScore,
  relevanceWords,
  type ReferenceRelevance,
} from './reference-relevance.js'
import {
  isStyleOutlier,
  loadReferenceStyleProfiles,
  referenceSite,
  styleProfileSummary,
  styleSimilarity,
  type ReferenceStyleProfile,
  type ReferenceStyleProfiles,
} from './reference-style-profiles.js'
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
      ...(entry.site ? { site: string(entry.site, `${id}.site`) } : {}),
      ...(entry.role ? { role: member(entry.role, REFERENCE_ROLES, `${id}.role`) } : {}),
      ...(entry.style ? { style: string(entry.style, `${id}.style`) } : {}),
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

/**
 * A loaded catalog entry. Dashboards keep their catalog words for domain relevance; a selected
 * deck never contains them.
 */
export type LibraryReference = ReferenceDirection & { relevance?: ReferenceRelevance }

function catalogText(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

export function loadReviewedReferences(root = referenceLibraryRoot()): LibraryReference[] {
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
      // A catalog describes compositions; only the sampler assigns deck sites, roles and styles.
      const [reference] = parseReferenceDeck([
        { ...entry, site: undefined, role: undefined, style: undefined },
      ])
      return [
        {
          ...reference!,
          cue: `${reference!.cue} Review: ${entry.reviewNotes}${entry.mobileImagePath ? ` Responsive pairing: ${entry.pairEvidence}` : ' No verified mobile reference: derive and visually test the responsive layout from this desktop composition.'}`,
          // Review notes describe the inspection, not the product, so only catalog words count.
          ...(reference!.family === 'dashboard'
            ? {
                relevance: referenceRelevance(
                  [
                    ...(reference!.tags ?? []),
                    ...catalogText(entry.domain),
                    ...catalogText(entry.sourceName),
                  ],
                  [reference!.cue, ...catalogText(entry.motifs)],
                ),
              }
            : {}),
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

const COMPATIBLE_FAMILIES = {
  stats: ['social_proof', 'about'],
  pricing: ['feature'],
  how_it_works: ['feature', 'about'],
  contact: ['cta'],
  cta: ['contact'],
  faq: ['feature'],
} as const satisfies Partial<Record<PageLayoutFamily, readonly PageLayoutFamily[]>>

function compatibleFamilies(family: PageLayoutFamily): readonly PageLayoutFamily[] {
  return COMPATIBLE_FAMILIES[family as keyof typeof COMPATIBLE_FAMILIES] ?? []
}

/** A family with fewer composition groups than this may borrow compatible geometry. */
const MIN_FAMILY_GROUPS = 10

function groupCount(references: readonly ReferenceDirection[]): number {
  return new Set(references.map(groupOf)).size
}

function isSparseFamily(
  family: PageLayoutFamily,
  references: readonly ReferenceDirection[],
): boolean {
  return groupCount(references.filter((entry) => entry.family === family)) < MIN_FAMILY_GROUPS
}

/** Content topics can use a compatible image's geometry without relabeling that image. */
export function referenceCandidatesForFamily<Entry extends ReferenceDirection>(
  family: PageLayoutFamily,
  references: readonly Entry[],
): Entry[] {
  const native = references.filter((entry) => entry.family === family)
  if (!isSparseFamily(family, references)) return native
  const alternatives = compatibleFamilies(family)
  const pool = references.filter(
    (entry) =>
      entry.family === family || alternatives.some((candidate) => candidate === entry.family),
  )
  // A deliberately small custom library remains authoritative; never pad it with duplicates.
  return groupCount(pool) >= MIN_FAMILY_GROUPS ? pool : native
}

/** Ids share prefixes (`x-about`, `x-about-process`), so a mention must be a whole id. */
function containsId(text: string, id: string): boolean {
  const idCharacter = /[a-z0-9-]/u
  for (let index = text.indexOf(id); index >= 0; index = text.indexOf(id, index + 1))
    if (
      !idCharacter.test(text[index - 1] ?? '') &&
      !idCharacter.test(text[index + id.length] ?? '')
    )
      return true
  return false
}

/** A source counts with or without its scheme and trailing slash, but not as a URL prefix. */
function containsSource(text: string, source: string): boolean {
  let key = source.toLowerCase()
  try {
    const url = new URL(source)
    key = `${url.host}${url.pathname.replace(/\/+$/u, '')}${url.search}`.toLowerCase()
  } catch {}
  for (let index = text.indexOf(key); index >= 0; index = text.indexOf(key, index + 1))
    if (
      !/[a-z0-9.-]/u.test(text[index - 1] ?? '') &&
      !/^\/?(?:[a-z0-9_~%-]|[./][a-z0-9])/u.test(text.slice(index + key.length))
    )
      return true
  return false
}

function groupOf(entry: ReferenceDirection): string {
  return entry.group ?? entry.id
}

/** Revisions share a vote: choose a group first, then one of its revisions. */
function drawGroupFirst<Entry extends ReferenceDirection>(
  pool: readonly Entry[],
  chooseIndex: (length: number) => number,
): Entry {
  const groupNames = [...new Set(pool.map(groupOf))]
  const chosenGroup = groupNames[chooseIndex(groupNames.length)]
  const revisions = pool.filter((entry) => groupOf(entry) === chosenGroup)
  return revisions[chooseIndex(revisions.length)]!
}

/** How many of the most similar profiled sites may supply a section the anchor site lacks. */
const SIMILAR_SITE_COUNT = 3

function configuredStyleProfiles(): ReferenceStyleProfiles {
  try {
    return loadReferenceStyleProfiles(referenceLibraryRoot())
  } catch {
    return new Map()
  }
}

/**
 * One page keeps one design language (owner decision, 2026-10-12). The first drawn section is the
 * anchor, chosen uniformly by group like before; its source site defines the page's language.
 * Every later section comes from the first non-empty tier: the anchor site's own family, the
 * anchor site's compatible families, the most similar profiled sites, then the uniform pool.
 */
export function selectReviewedReferences(
  brief: DesignBrief,
  references = loadReviewedReferences(),
  chooseIndex: (length: number) => number = randomInt,
  styleProfiles?: ReferenceStyleProfiles,
): ReferenceDirection[] {
  const request =
    `${brief.originalRequest} ${(brief.explicitAnswers ?? []).map((answer) => answer.answer).join(' ')}`.toLowerCase()
  if (!references.length) throw new Error('No Design references are available')
  const dashboard = isDashboardBrief(brief)
  const families: readonly PageLayoutFamily[] = dashboard ? ['dashboard'] : WEBSITE_LAYOUT_FAMILIES
  // Site profiles describe marketing pages; a dashboard deck is a single screen.
  const profiles: ReferenceStyleProfiles = dashboard
    ? new Map()
    : (styleProfiles ?? configuredStyleProfiles())
  const sectionReferences = references.filter((entry) => !entry.tags?.includes('native-component'))
  const selected: ReferenceDirection[] = []
  const groups = new Set<string>()
  const unused = (entry: ReferenceDirection) => !groups.has(groupOf(entry))
  const siteOf = (entry: ReferenceDirection) => referenceSite(entry.source)
  const consistent = (entry: ReferenceDirection) =>
    !isStyleOutlier(profiles.get(siteOf(entry) ?? ''), entry)
  let anchor: { site?: string | undefined; profile?: ReferenceStyleProfile | undefined } | undefined

  // Unused, site-consistent entries that could fill a slot of this family.
  const slotCandidates = (family: PageLayoutFamily) =>
    sectionReferences.filter(
      (entry) =>
        unused(entry) &&
        consistent(entry) &&
        (entry.family === family || compatibleFamilies(family).includes(entry.family)),
    )
  // The best few other profiled sites by similarity to the anchor, ties included.
  const similarSites = (candidates: readonly ReferenceDirection[]): Set<string> => {
    const anchorProfile = anchor?.profile
    if (!anchorProfile) return new Set()
    const scores = new Map<string, number>()
    for (const entry of candidates) {
      const site = siteOf(entry)
      const profile = site && site !== anchor?.site ? profiles.get(site) : undefined
      if (site && profile && !scores.has(site))
        scores.set(site, styleSimilarity(anchorProfile, profile))
    }
    const ranked = [...scores.values()].filter((score) => score > 0).sort((a, b) => b - a)
    const cutoff = ranked[Math.min(SIMILAR_SITE_COUNT, ranked.length) - 1]
    return new Set(
      [...scores]
        .filter(([, score]) => cutoff !== undefined && score > 0 && score >= cutoff)
        .map(([site]) => site),
    )
  }
  const drawRelated = (
    family: PageLayoutFamily,
    uniformPool: readonly LibraryReference[],
  ): { entry: LibraryReference; role: ReferenceRole } | undefined => {
    const native = (entry: ReferenceDirection) => entry.family === family
    const compatible = (entry: ReferenceDirection) =>
      compatibleFamilies(family).includes(entry.family)
    const candidates = slotCandidates(family)
    const sameSite = anchor?.site
      ? candidates.filter((entry) => siteOf(entry) === anchor?.site)
      : []
    const similar = similarSites(candidates)
    const related = candidates.filter((entry) => similar.has(siteOf(entry) ?? ''))
    const tiers: [LibraryReference[], ReferenceRole][] = [
      [sameSite.filter(native), 'same-site'],
      [sameSite.filter(compatible), 'same-site'],
      [related.filter(native), 'similar-site'],
      [related.filter(compatible), 'similar-site'],
      [uniformPool.filter(unused), 'fallback'],
    ]
    const tier = tiers.find(([pool]) => pool.length)
    return tier && { entry: drawGroupFirst(tier[0], chooseIndex), role: tier[1] }
  }
  // A finance request should get a finance shell, not a random 3D or audio editor. Ties and
  // requests without a matching domain stay uniform.
  const requestWords = dashboard
    ? relevanceWords(
        [
          brief.originalRequest ?? '',
          brief.subject ?? '',
          ...(brief.requiredContent ?? []),
          ...(brief.explicitAnswers ?? []).map((answer) => answer.answer),
        ].join(' '),
      )
    : new Set<string>()
  const mostRelevant = (entries: LibraryReference[]): LibraryReference[] => {
    const scores = entries.map((entry) =>
      relevanceScore(
        requestWords,
        entry.relevance ?? referenceRelevance(entry.tags ?? [], [entry.cue]),
      ),
    )
    const top = Math.max(0, ...scores)
    return top > 0 ? entries.filter((_, index) => scores[index] === top) : entries
  }
  const relation = (family: PageLayoutFamily, entry: ReferenceDirection): ReferenceRole =>
    anchor?.site && siteOf(entry) === anchor.site
      ? 'same-site'
      : similarSites(slotCandidates(family)).has(siteOf(entry) ?? '')
        ? 'similar-site'
        : 'fallback'

  for (const family of families) {
    // Section titles are free-form and multilingual. Let Page choose the needed
    // compositions from a complete deck instead of discarding families by keywords.
    const familyEntries = referenceCandidatesForFamily(family, sectionReferences).filter(unused)
    if (!familyEntries.length) continue
    const explicit = familyEntries.filter((entry) => containsId(request, entry.id.toLowerCase()))
    const explicitSource = familyEntries.filter(
      (entry) => entry.source && containsSource(request, entry.source),
    )
    const explicitPool = explicit.length ? explicit : explicitSource
    const pool = explicitPool.length
      ? explicitPool
      : family === 'dashboard'
        ? mostRelevant(familyEntries)
        : familyEntries
    // Repeated content sections need distinct compositions within the same page too.
    const count = Math.min(groupCount(pool), family === 'feature' ? 3 : family === 'about' ? 2 : 1)
    for (let index = 0; index < count; index++) {
      let pick: { entry: LibraryReference; role: ReferenceRole } | undefined
      if (explicitPool.length) {
        const entry = drawGroupFirst(explicitPool.filter(unused), chooseIndex)
        pick = { entry, role: anchor ? relation(family, entry) : 'anchor' }
      } else if (!anchor) {
        // Outliers do not share their site's language, so they cannot define the page's.
        const eligible = pool.filter(unused)
        const coherent = eligible.filter(consistent)
        pick = {
          entry: drawGroupFirst(coherent.length ? coherent : eligible, chooseIndex),
          role: 'anchor',
        }
      } else pick = drawRelated(family, pool)
      if (!pick) break
      const { entry, role } = pick
      const site = siteOf(entry)
      if (role === 'anchor') anchor = { site, profile: site ? profiles.get(site) : undefined }
      groups.add(groupOf(entry))
      const { site: _site, role: _role, style: _style, relevance: _relevance, ...base } = entry
      const style = role === 'anchor' ? styleProfileSummary(anchor?.profile) : undefined
      selected.push({
        ...base,
        ...(entry.family === family
          ? {}
          : {
              cue: `${entry.cue} Sampled for ${family} content from compatible compositions; retain its actual ${entry.family} layout family and image geometry.`,
            }),
        ...(site ? { site } : {}),
        role,
        ...(style ? { style } : {}),
      })
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
