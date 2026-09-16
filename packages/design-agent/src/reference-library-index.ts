import { existsSync, lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { PageLayoutFamily } from './page.js'
import { record } from './parse.js'
import { containedWorkspaceFile, readWorkspaceFile } from './workspace-files.js'

const FAMILIES: Array<[RegExp, PageLayoutFamily]> = [
  [/hero|banner|masthead/, 'hero'],
  [/footer/, 'footer'],
  [/faq|question/, 'faq'],
  [/pricing|plans/, 'pricing'],
  [/testimonial|client|partner|trusted|logo|award/, 'social_proof'],
  [/(?:^|-)(?:metrics?|stats?|statistics|numbers?)(?:-|$)/, 'stats'],
  [/contact|cta|closing|newsletter/, 'cta'],
  [/process|approach|steps|how-it-works/, 'how_it_works'],
  [/about|intro|manifesto|story|statement|team|values|mission|vision|studio/, 'about'],
  [
    /work|project|portfolio|case-stud|service|feature|expertise|gallery|showreel|catalog|artist|collection|benefit|article|blog|video|playbook/,
    'feature',
  ],
]

/** Index complete, labeled generated views; visual approval still happens in the consuming run. */
export function generatedReferenceCandidates(root: string) {
  const candidates = []
  for (const site of readdirSync(root, { withFileTypes: true })) {
    if (!site.isDirectory()) continue
    const directory = path.join(root, site.name)
    const generated = path.join(directory, 'generated')
    if (!existsSync(generated) || !lstatSync(generated).isDirectory()) continue
    const metadataPath = path.join(directory, 'manifest.json')
    const metadata = existsSync(metadataPath)
      ? record(
          JSON.parse(
            readWorkspaceFile(
              containedWorkspaceFile(root, path.relative(root, metadataPath), 'reference manifest'),
              2_000_000,
            ).toString(),
          ),
          'reference manifest',
        )
      : {}
    let source = metadata.sourceUrl ?? metadata.source
    const readme = path.join(directory, 'README.md')
    if (typeof source !== 'string' && existsSync(readme)) {
      source = readWorkspaceFile(
        containedWorkspaceFile(root, path.relative(root, readme), 'reference README'),
        200_000,
      )
        .toString()
        .match(/^Source:\s*(https?:\/\/\S+)/im)?.[1]
    }
    if (typeof source !== 'string' || !/^https?:\/\//.test(source)) continue
    const sections = new Map<string, { desktop?: string; mobile?: string }>()
    for (const file of readdirSync(generated, { withFileTypes: true })) {
      if (!file.isFile()) continue
      // Numbered fragments, lower crops and threshold variants are not complete section views.
      const match =
        /^([a-z0-9][a-z0-9-]*?)-(desktop|mobile)(?:-(full|v\d+))?\.(png|jpe?g|webp)$/i.exec(
          file.name,
        )
      if (!match || /threshold|partial|crop|fragment/.test(match[1]!)) continue
      const [, section, viewport] = match
      const views = sections.get(section!) ?? {}
      const key = viewport!.toLowerCase() as 'desktop' | 'mobile'
      const previous = views[key]
      const rank = (name: string) =>
        name.includes('-full.') ? 1000 : Number(/-v(\d+)\./i.exec(name)?.[1] ?? 0)
      if (!previous || rank(file.name) > rank(previous)) views[key] = file.name
      sections.set(section!, views)
    }
    for (const [section, views] of sections) {
      if (!views.desktop) continue
      const label = section.replace(/^\d+-/, '')
      const family = FAMILIES.find(([pattern]) => pattern.test(label))?.[1]
      if (!family) continue
      const sectionMetadata = Array.isArray(metadata.sections)
        ? metadata.sections
            .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
            .map((item) => record(item, 'reference section'))
            .find(
              (item) =>
                item.label === label ||
                item.type === label ||
                (item.order !== undefined &&
                  String(item.order) === String(Number(/^\d+/.exec(section)?.[0]))),
            )
        : undefined
      if (
        /reject|revision-needed|pending-capture|incomplete|truncated/i.test(
          String(sectionMetadata?.status ?? ''),
        )
      )
        continue
      const id = `${site.name}-${section}`.toLowerCase()
      candidates.push({
        id,
        group: id,
        family,
        source,
        tags: [],
        imagePath: path.join(site.name, 'generated', views.desktop),
        ...(views.mobile
          ? {
              mobileImagePath: path.join(site.name, 'generated', views.mobile),
              pairEvidence:
                'Candidate pairing from section labels, not a verified responsive match. Inspect both images and reconcile differences before planning.',
            }
          : {}),
        cue: `Generated ${label} section from ${site.name}. Preserve the composition visible in the image.`,
        reviewStatus: 'candidate',
        reviewNotes: `Visual review is pending. Inspect the selected pixels before use; generation alone is not quality approval. ${typeof sectionMetadata?.notes === 'string' ? sectionMetadata.notes : ''}`,
      })
    }
  }
  return candidates
}
