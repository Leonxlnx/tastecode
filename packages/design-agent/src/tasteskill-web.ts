import { readFileSync } from 'node:fs'

/**
 * The switch for websites built under tasteskill v2.5's rules (owner request, 2026-11-05).
 *
 * While this is true, the Page, Build and Review phases of a website quote tasteskill's house
 * rules and its copy, layout and picture chapters from `references/tasteskill-web/`. They also
 * follow the motion mode in website-motion.ts. The reference deck still decides composition and
 * the brand system still decides type, colour, radius and spacing. Dashboards keep the app-screen
 * path.
 */
export const TASTESKILL_WEBSITE_ENABLED: boolean = true

export type TasteskillChapter = 'SKILL.md' | 'copy.md' | 'layout-v4.md' | 'motion.md' | 'photos.md'

const chapters = new Map<TasteskillChapter, string>()

export function tasteskillChapter(file: TasteskillChapter): string {
  let text = chapters.get(file)
  if (text === undefined) {
    text = readFileSync(new URL(`../references/tasteskill-web/${file}`, import.meta.url), 'utf8')
    chapters.set(file, text)
  }
  return text
}

/**
 * One `##` section of a chapter, its heading included, up to the next `##` heading. `heading` is
 * the heading text as written, with or without its number ("2. One section per screen" or
 * "One section per screen"). Throws when the chapter has no such section, so a newer copy whose
 * headings moved fails its tests instead of quoting nothing.
 */
export function tasteskillSection(file: TasteskillChapter, heading: string): string {
  const lines = tasteskillChapter(file).split('\n')
  const bare = (text: string) => text.replace(/^\d+\.\s+/, '').trim()
  const start = lines.findIndex(
    (line) =>
      line.startsWith('## ') &&
      (line.slice(3).trim() === heading || bare(line.slice(3)) === bare(heading)),
  )
  if (start < 0) throw new Error(`tasteskill ${file} has no section "${heading}"`)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines
    .slice(start, next < 0 ? undefined : next)
    .join('\n')
    .trimEnd()
}

export type WebsitePhase = 'brand' | 'page' | 'build' | 'review'

/** The sections each website phase quotes, in order. */
export const WEBSITE_RULE_SECTIONS = {
  brand: [['SKILL.md', 'House rules']],
  page: [
    ['SKILL.md', 'House rules'],
    ['SKILL.md', '1. The kind of business decides everything'],
    ['copy.md', 'Five rules'],
    ['copy.md', 'Plain versions'],
    ['copy.md', 'Headlines and text'],
    ['copy.md', 'What may be assumed'],
    ['copy.md', 'Contacts the brief does not give'],
    ['copy.md', 'Banned'],
    ['layout-v4.md', '2. One section per screen'],
    ['layout-v4.md', '4. Equal edges and the grid'],
    ['photos.md', 'Place them'],
    ['photos.md', 'Never'],
  ],
  build: [
    ['SKILL.md', 'House rules'],
    ['copy.md', 'What may be assumed'],
    ['copy.md', 'Contacts the brief does not give'],
    ['layout-v4.md', '2. One section per screen'],
    ['layout-v4.md', '4. Equal edges and the grid'],
    ['photos.md', 'Place them'],
  ],
  review: [
    ['SKILL.md', 'House rules'],
    ['SKILL.md', '5. Checklist'],
    ['SKILL.md', '6. Never'],
    ['copy.md', 'Banned'],
  ],
} as const satisfies Record<WebsitePhase, readonly (readonly [TasteskillChapter, string])[]>

const ADAPTATIONS = `The text below is quoted unchanged from tasteskill v2.5.0, the anti-slop frontend skill (references/tasteskill-web/, MIT). Read it with these TasteCode adaptations, which win where they differ:
1. No kit. TasteCode does not install or run the skill's kit: no system.css, starter.html, assets/ folder, deal.mjs, start.mjs, photos.mjs, icons.mjs, consistency.mjs, check.mjs or perf.mjs. Where the text names a kit class, token, file, script or dealer, apply the rule it states with the page's own markup and the approved brand system. Ids in brackets and braces name checks; Review and TasteCode's preview audit verify those rules instead.
2. Composition and design language. The selected references decide each section's composition, and the brand system decides type, colour, radius and spacing. tasteskill's dealt heroes, palettes, pairings and section recipes do not apply. Its rules govern inside that composition: plain copy, one section per screen, equal edges, real pictures, no captions, contacts. Where a reference shows a section that breaks a quoted rule (two sections on one screen, a caption under a picture), keep its composition and follow the rule.
3. No picture library. There are no stock, library, template or sample pictures. Pictures come from the brief, the user's files and TasteCode's Asset phase, which records each picture's source and licence; credits follow that record, never photos.mjs. Where a picture is missing, its frame stays a named slot for the client's file and the report lists it. Where the text says library frames, the draft path or stand-ins, read: the user's pictures, or a client slot.
4. Motion follows the website motion block in this prompt wherever the quoted text speaks of motion.`

/** tasteskill's rules for one website phase, with TasteCode's adaptations first. */
export function tasteskillWebsiteRules(phase: WebsitePhase): string {
  if (!TASTESKILL_WEBSITE_ENABLED) return ''
  const quoted = WEBSITE_RULE_SECTIONS[phase].map(
    ([file, heading]) => `<!-- tasteskill ${file} -->\n${tasteskillSection(file, heading)}`,
  )
  return `TASTESKILL WEBSITE RULES:
${ADAPTATIONS}

<tasteskill-rules>
${quoted.join('\n\n')}
</tasteskill-rules>`
}
