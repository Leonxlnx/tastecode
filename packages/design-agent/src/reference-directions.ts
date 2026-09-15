import { fileURLToPath } from 'node:url'
import type { BrandSystem } from './brand.js'
import type { DesignBrief } from './brief.js'
import { PAGE_LAYOUT_FAMILIES, type PageBlueprint, type PageLayoutFamily } from './page.js'

export interface ReferenceDirection {
  id: string
  family: PageLayoutFamily
  cue: string
  imagePath: string
  mobileImagePath?: string
  source?: string
  group?: string
  tags?: string[]
}

function direction(id: string, family: PageLayoutFamily, cue: string): ReferenceDirection {
  return {
    id,
    family,
    cue,
    imagePath: `references/directions/${family}/${id}.webp`,
  }
}

export const REFERENCE_DIRECTIONS = [
  direction(
    'direction-001',
    'hero',
    'Oversized split headline wraps around a centered stack of overlapping portrait cards.',
  ),
  direction(
    'direction-002',
    'hero',
    'Centered copy and email capture sit above a wide dashboard preview rising from the bottom edge.',
  ),
  direction(
    'direction-003',
    'hero',
    'Full-bleed monochrome campaign image anchors centered inset photography and a low two-line statement.',
  ),
  direction(
    'direction-004',
    'hero',
    'Two oversized type bands frame a compact central media window inside concentric construction circles.',
  ),
  direction(
    'direction-005',
    'hero',
    'Calm centered brand copy is surrounded by a perimeter orbit of rotated visual tiles.',
  ),
  direction(
    'direction-006',
    'hero',
    'Monumental centered wordmark sits above a full-width row of tall arched image slices.',
  ),
  direction(
    'direction-007',
    'hero',
    'Centered value proposition floats above an asymmetrical overlapping row of photographic proof cards.',
  ),
  direction(
    'direction-008',
    'hero',
    'Monumental centered wordmark spans the dark macro image between compact edge navigation and bottom utilities.',
  ),
  direction(
    'direction-009',
    'hero',
    'Three stacked display-type lines occupy the left two-thirds while CTA, support copy, and project thumbnails form a low baseline.',
  ),
  direction(
    'direction-010',
    'hero',
    'Centered statement sits in a deep-color upper field above a continuous five-panel architectural image strip.',
  ),
  direction(
    'direction-011',
    'hero',
    'Giant low-left word balances a floating upper-center capsule and a small bottom-right copy block across vast white space.',
  ),
  direction(
    'direction-012',
    'hero',
    'Centered two-line statement overlays black folded material while three cropped product devices rise from the bottom edge.',
  ),
  direction(
    'direction-013',
    'hero',
    'Full-height cobalt portrait anchors the left and center while vertically staggered campaign cards occupy the right rail.',
  ),
  direction(
    'direction-014',
    'about',
    'Manifesto and team portraits fill the upper-left, a glass sculpture anchors the upper-right, and metrics oppose a three-image work row below.',
  ),
  direction(
    'direction-015',
    'social_proof',
    'Left text-and-metric column balanced by a full-height portrait panel on the right.',
  ),
  direction(
    'direction-016',
    'about',
    'Large statement at left, manifesto copy centered, and a portrait anchored beneath the middle column.',
  ),
  direction(
    'direction-017',
    'feature',
    'Scattered service labels orbit two compact image chips across a nearly empty dark canvas.',
  ),
  direction(
    'direction-018',
    'about',
    'Centered headline and CTA surrounded by tilted image cards entering from all four edges.',
  ),
  direction(
    'direction-019',
    'about',
    'Seven equal vertical image strips span the top above a centered statement and four client names.',
  ),
  direction(
    'direction-020',
    'about',
    'Oversized headline occupies the upper-right while two adjacent photos and a compact CTA form the lower band.',
  ),
  direction(
    'direction-021',
    'hero',
    'Wide capsule navigation sits above a centered three-line headline, short paragraph, and paired CTAs.',
  ),
  direction(
    'direction-022',
    'about',
    'Oversized title above a dominant left portrait, narrow center portrait, and right-aligned bio block.',
  ),
  direction(
    'direction-023',
    'hero',
    'Centered stacked-photo collage intersects a split two-line headline beneath a full-width navigation.',
  ),
  direction(
    'direction-024',
    'cta',
    'Three-line centered statement embeds two product thumbnails, a directional arrow, and one bottom CTA.',
  ),
  direction(
    'direction-025',
    'about',
    'Wide cinematic image canvas sits below the title with copy bottom-left and contact card bottom-right.',
  ),
  direction(
    'direction-026',
    'about',
    'Large upper-left statement balances a lower-left paragraph and two adjacent lower-right image crops.',
  ),
  direction(
    'direction-027',
    'feature',
    'One wide dominant project card fills the left while a smaller portrait project card sits raised on the right.',
  ),
  direction(
    'direction-028',
    'feature',
    'Centered landscape project card uses a horizontal ribbon through the image with metadata directly below.',
  ),
  direction(
    'direction-029',
    'feature',
    'Oversized two-line heading and studio seal sit above a 58/42 pair of equal-height project cards.',
  ),
  direction(
    'direction-030',
    'feature',
    'Two tall editorial image cards share one centered row, with captions below and the CTA isolated at bottom-right.',
  ),
  direction(
    'direction-031',
    'feature',
    'Sparse top chrome and a centered title lead into three near-equal vertical image panels spanning the lower half.',
  ),
  direction(
    'direction-032',
    'feature',
    'A large two-line title anchors the upper-left while two tall project cards occupy only the lower-left two-thirds.',
  ),
  direction(
    'direction-033',
    'feature',
    'The entire left third stays empty while two staggered tall project cards form a right-weighted pair.',
  ),
  direction(
    'direction-034',
    'feature',
    'Centered single-line headline sits above a full-width rounded media stage with one ivory inset card slightly right of center.',
  ),
  direction(
    'direction-035',
    'feature',
    'Two full-width rounded image bands stack vertically, with compact ivory detail cards alternating upper-right then lower-left.',
  ),
  direction(
    'direction-036',
    'feature',
    'Airy title-and-counter header above two equal-width rounded image tiles.',
  ),
  direction(
    'direction-037',
    'feature',
    'Two-line full-width headline with an inline image insert above a wide panoramic project image.',
  ),
  direction(
    'direction-038',
    'cta',
    'Wide upper media panel overlapped by a skewed foreground plane with a centered circular CTA.',
  ),
  direction(
    'direction-039',
    'how_it_works',
    'Left-weighted two-line heading above three horizontally staggered tonal cards.',
  ),
  direction(
    'direction-040',
    'feature',
    'Offset title and studio note above three unequal image columns with aligned captions.',
  ),
  direction(
    'direction-041',
    'feature',
    'Centered heading stack above one dominant landscape image and a left-aligned caption.',
  ),
  direction(
    'direction-042',
    'feature',
    'Minimal split header above a full-width cinematic product photograph.',
  ),
  direction(
    'direction-043',
    'feature',
    'Centered two-line heading above a full-width image band and three horizontal service rows.',
  ),
  direction(
    'direction-044',
    'feature',
    'Full-width active service row opens directly into a cinematic image, followed by two collapsed rows.',
  ),
  direction(
    'direction-045',
    'feature',
    'Left copy-and-proof column occupies roughly 45%, paired with a dominant right-side material macro.',
  ),
  direction(
    'direction-046',
    'feature',
    'One oversized white image card is slightly rotated above a black canvas with a blurred card receding behind.',
  ),
  direction(
    'direction-047',
    'feature',
    'Editorial lead anchors the left third while staggered image and benefit cards fill the right two-thirds.',
  ),
  direction(
    'direction-048',
    'social_proof',
    'Large portrait fills the left 42%, spacious quote content sits right, with a slim far-right selector rail.',
  ),
  direction(
    'direction-049',
    'about',
    'Huge low-contrast backdrop type spans the section beneath a centered intro and three rotated portrait cards.',
  ),
  direction(
    'direction-050',
    'footer',
    'Four-column link field above a divider, closed by an oversized bottom-right wordmark.',
  ),
  direction(
    'direction-051',
    'social_proof',
    'Offset heading above a precise 4×2 partner-card grid.',
  ),
  direction(
    'direction-052',
    'feature',
    'Four staggered service cards orbit a centered proposition.',
  ),
  direction(
    'direction-053',
    'feature',
    'Editorial image column anchors a wider right-side accordion.',
  ),
  direction(
    'direction-054',
    'feature',
    'Oversized kinetic type overlaps a rounded right-center action photograph.',
  ),
  direction(
    'direction-055',
    'social_proof',
    'Wide evidence ribbon sits above an asymmetric testimonial-card grid.',
  ),
  direction(
    'direction-056',
    'pricing',
    'Quiet entry tier connects directly to a wide dark two-plan panel.',
  ),
  direction(
    'direction-057',
    'faq',
    'Narrow left editorial column with stacked contact card; wide right accordion panel.',
  ),
  direction(
    'direction-058',
    'cta',
    'Full-width rounded cinematic field with a centered two-line statement and single CTA.',
  ),
  direction(
    'direction-059',
    'footer',
    'Newsletter block on the left, three link columns on the right, oversized cropped wordmark below.',
  ),
  direction(
    'direction-060',
    'feature',
    'Benefits stacked down the left half while a large product workspace rises from the lower right.',
  ),
  direction(
    'direction-061',
    'how_it_works',
    'Two equal visual cards below a split heading row, with one wide timeline card peeking underneath.',
  ),
  direction(
    'direction-062',
    'feature',
    'One full-width timeline card above two unequal operational cards.',
  ),
  direction(
    'direction-063',
    'social_proof',
    'Two stacked proof rows pairing oversized metrics on the left with quotes and portraits on the right.',
  ),
  direction(
    'direction-064',
    'feature',
    'Left oversized portrait product panel fills roughly half the frame; right half holds a vertically centered two-line statement, short support copy, and one CTA.',
  ),
  direction(
    'direction-065',
    'faq',
    'Centered title sits above a wide five-row accordion stack; the first row expands to nearly twice the collapsed row height.',
  ),
  direction(
    'direction-066',
    'footer',
    'One large inset rounded footer spans the canvas, with a broad left CTA column, two right link columns, and a full-width legal/social baseline.',
  ),
  direction(
    'direction-067',
    'cta',
    'A single wide rounded cinematic panel is centered with a compact headline-support-button stack aligned on its central axis.',
  ),
  direction(
    'direction-068',
    'feature',
    'A narrow left editorial intro occupies one third while a gapless-feeling 2×2 service-card matrix fills the right two thirds.',
  ),
  direction(
    'direction-069',
    'social_proof',
    'Centered heading anchors the upper third; twelve equal portrait logo cards form a strict 2×6 grid across the lower field.',
  ),
  direction(
    'direction-070',
    'cta',
    'A narrow centered portrait leads a vertical closing sequence of accent rule, two-line headline, and one outlined CTA within deep negative space.',
  ),
  direction(
    'direction-071',
    'footer',
    'Two-tier grid: four utility columns above a divider, full-width wordmark below.',
  ),
  direction(
    'direction-072',
    'stats',
    'Three equal metric cards form a single low horizontal row beneath a left-aligned heading.',
  ),
  direction(
    'direction-073',
    'how_it_works',
    'Three milestones climb left-to-right along one sweeping diagonal curve.',
  ),
  direction(
    'direction-074',
    'social_proof',
    'Large portrait block on the left balances a wide quote field and controls on the right.',
  ),
  direction(
    'direction-075',
    'feature',
    'Three staggered image columns use a tall dominant center story between shorter side stories.',
  ),
  direction(
    'direction-076',
    'faq',
    'Narrow introductory column on the left pairs with a wide five-row accordion stack on the right.',
  ),
  direction(
    'direction-077',
    'cta',
    'Centered two-line headline sandwiches one narrow cinematic media strip, with support copy and CTA below.',
  ),
  direction(
    'direction-078',
    'footer',
    'Wide split grid with compact contact stack left, oversized navigation rows right, and a full-width utility rail below.',
  ),
  direction(
    'direction-079',
    'about',
    'Three-line statement anchored upper left, tactile material image lower left, and paragraph-plus-CTA cluster lower right.',
  ),
  direction(
    'direction-080',
    'feature',
    'Large two-line heading above three tall image cards, with two smaller supporting cards stacked on the far right.',
  ),
  direction(
    'direction-081',
    'feature',
    'Full-width cinematic media frame with a compact outcome caption inside left and an overlapping project card at lower right.',
  ),
  direction(
    'direction-082',
    'social_proof',
    'Centered two-line heading above three portraits on a shallow arc and two equal quote cards below.',
  ),
  direction(
    'direction-083',
    'pricing',
    'Left-aligned two-line heading above two unequal plan cards, with the emphasized plan wider and a billing toggle above it.',
  ),
  direction(
    'direction-084',
    'faq',
    'Centered single-line heading above a two-column accordion grid, with one expanded card and a cropped product detail on the right edge.',
  ),
  direction(
    'direction-085',
    'hero',
    'Centered copy inside a near-complete arc of tilted media tiles.',
  ),
  direction(
    'direction-086',
    'footer',
    'Centered brand block above distributed navigation and a cropped oversized wordmark.',
  ),
  direction(
    'direction-087',
    'about',
    'Two-line statement stacked above one wide rounded cinematic frame.',
  ),
  direction(
    'direction-088',
    'social_proof',
    'Two offset split panels alternate portrait and quote positions.',
  ),
  direction(
    'direction-089',
    'faq',
    'Large left title balances a right-side single-column accordion.',
  ),
  direction(
    'direction-090',
    'feature',
    'Three grounded service cards lead into one tilted overlapping feature card.',
  ),
  direction(
    'direction-091',
    'pricing',
    'Centered heading and billing toggle sit above three equal pricing columns.',
  ),
  direction(
    'direction-092',
    'stats',
    'Split header above three unequal stat cards and a narrow four-item trust rail.',
  ),
  direction(
    'direction-093',
    'social_proof',
    'Centered two-line intro above three overlapping landscape quote cards.',
  ),
  direction(
    'direction-094',
    'feature',
    'Split header above three equal image-led article columns.',
  ),
  direction(
    'direction-095',
    'social_proof',
    'Centered label above a strict two-by-four logo-card matrix.',
  ),
  direction(
    'direction-096',
    'about',
    'Large right-shifted two-line statement with compact copy and actions beneath.',
  ),
  direction(
    'direction-097',
    'feature',
    'Full-width dark two-by-two image grid with shallow action headers.',
  ),
  direction(
    'direction-098',
    'stats',
    'Two-line header above a wide product image beside two stacked statistic cards.',
  ),
  direction(
    'direction-099',
    'social_proof',
    'Oversized two-line heading above a three-card row with a 42% media card left and two equal quote cards right.',
  ),
  direction(
    'direction-100',
    'pricing',
    'Full-width statement heading above an asymmetric one-third inclusions card and two-thirds primary package card.',
  ),
  direction(
    'direction-101',
    'faq',
    'Wide title above a balanced 50/50 split with editorial portrait left and five-row accordion right.',
  ),
  direction(
    'direction-102',
    'cta',
    'Full-bleed cinematic image with a centered lower-middle two-line statement, single button, and quiet support line.',
  ),
  direction(
    'direction-103',
    'footer',
    'Airy four-zone horizontal grid: identity/contact, navigation, studio statement, then compact CTA at far right.',
  ),
  direction(
    'direction-104',
    'feature',
    'Header band above a disciplined three-column gallery of equal-width editorial project images with captions.',
  ),
  direction(
    'direction-105',
    'feature',
    'Centered title above three equal visual cards, followed by one full-width supporting CTA card.',
  ),
  direction(
    'direction-106',
    'about',
    'Centered compact statement punctured by three small photographic apertures.',
  ),
  direction(
    'direction-107',
    'feature',
    'Four stacked property rows with one dark active band and a portrait image overlapping its right edge.',
  ),
  direction(
    'direction-108',
    'about',
    'Centered introduction above a spacious three-column by two-row principles grid with square material crops.',
  ),
  direction(
    'direction-109',
    'feature',
    'Wide olive service panel split between left-side copy and a dominant panoramic garden image.',
  ),
  direction(
    'direction-110',
    'pricing',
    'Two equal-width pricing cards contrasted dark versus light beneath a centered introduction.',
  ),
  direction(
    'direction-111',
    'about',
    'Off-grid two-part headline above three asymmetrically sized product photographs.',
  ),
  direction(
    'direction-112',
    'faq',
    'Narrow left introduction and food image paired with a wider right-side accordion stack.',
  ),
  direction(
    'direction-113',
    'feature',
    'Dominant feature card on the left with three stacked article rows on the right.',
  ),
  direction(
    'direction-114',
    'cta',
    'Centered statement, proof row, and primary button isolated within generous whitespace.',
  ),
  direction(
    'direction-115',
    'footer',
    'Link and newsletter columns sit above an oversized cropped serif wordmark.',
  ),
  direction(
    'direction-116',
    'stats',
    'Large statement fills the left column while staggered metric and image cards stack on the right.',
  ),
  direction(
    'direction-117',
    'footer',
    'Compact navigation groups occupy the top band above a full-width cropped geometric wordmark.',
  ),
  direction(
    'direction-118',
    'social_proof',
    'Large year marker anchors the left edge beside a rigorous three-by-two logo matrix.',
  ),
  direction(
    'direction-119',
    'about',
    'Stat and statement span the top while a product image and supporting copy divide the lower half.',
  ),
  direction(
    'direction-120',
    'feature',
    'Centered identity lockup above a balanced 3×2 field of wide service cards.',
  ),
  direction(
    'direction-121',
    'hero',
    'Near-even vertical split with oversized discipline index left and full-height editorial portrait right.',
  ),
  direction(
    'direction-122',
    'faq',
    'Centered heading and filter row above one broad rounded accordion panel spanning most of the frame.',
  ),
  direction(
    'direction-123',
    'about',
    'Slim centered title band above four edge-to-edge vertical portrait columns.',
  ),
  direction(
    'direction-124',
    'footer',
    'Large subscription form left, three utility columns right, with a cropped wordmark anchoring the bottom edge.',
  ),
  direction(
    'direction-125',
    'feature',
    'Dark header above three contiguous image cards, with the center card dominant and a circular CTA bridging the first two.',
  ),
  direction(
    'direction-126',
    'how_it_works',
    'Three-column stepped card composition with a tall expanded photographic card occupying the center column.',
  ),
  direction(
    'direction-127',
    'how_it_works',
    'Three stepped accordion columns with the cobalt active panel raised at center.',
  ),
  direction(
    'direction-128',
    'about',
    'Three unequal portrait columns aligned across a dark editorial field.',
  ),
  direction(
    'direction-129',
    'social_proof',
    'Two overlapping testimonial cards stacked diagonally beneath a left-anchored heading.',
  ),
  direction(
    'direction-130',
    'faq',
    'Narrow left title-and-product zone beside a wide five-row accordion.',
  ),
  direction(
    'direction-131',
    'contact',
    'Rounded full-width shell split into an image-led introduction and tactile form.',
  ),
  direction(
    'direction-132',
    'footer',
    'Two-tier footer with newsletter/navigation above an oversized edge-to-edge wordmark.',
  ),
] as const satisfies readonly ReferenceDirection[]

export function referenceDirectionAttachmentPath(direction: ReferenceDirection): string {
  if (/^(?:[A-Za-z]:[\\/]|\/|\\\\)/u.test(direction.imagePath)) return direction.imagePath
  return fileURLToPath(new URL(`../${direction.imagePath}`, import.meta.url))
}

export function referenceDirectionAttachments(directions: readonly ReferenceDirection[]): string[] {
  return [
    ...new Set(
      directions.flatMap((direction) => [
        referenceDirectionAttachmentPath(direction),
        ...(direction.mobileImagePath ? [direction.mobileImagePath] : []),
      ]),
    ),
  ]
}

export function referenceDirectionsForPage(
  page: PageBlueprint,
  deck: readonly ReferenceDirection[] = REFERENCE_DIRECTIONS,
): ReferenceDirection[] {
  const byId = new Map(deck.map((direction) => [direction.id, direction]))
  return page.sections.flatMap((section, index) => {
    if (!section.referenceDirectionId) return []
    if (section.referenceDirectionId.startsWith('user-reference-')) return []
    const direction = byId.get(section.referenceDirectionId)
    if (!direction) {
      throw new Error(`sections[${index}].referenceDirectionId is unknown`)
    }
    if (direction.family !== section.layoutFamily) {
      throw new Error(
        `sections[${index}].referenceDirectionId must belong to ${section.layoutFamily}`,
      )
    }
    return [direction]
  })
}

export function lockPageReferenceDirections(
  page: PageBlueprint,
  deck: readonly ReferenceDirection[],
  suppliedReferenceIds: readonly string[] = [],
): PageBlueprint {
  const deckIds = new Set(deck.map(({ id }) => id))
  const suppliedIds = new Set(suppliedReferenceIds)
  let usesSuppliedReference = false
  const sections = page.sections.map((section, index) => {
    if (!section.layoutFamily) throw new Error(`sections[${index}] must select a layoutFamily`)
    const referenceDirectionId = section.referenceDirectionId
    if (
      !referenceDirectionId ||
      (!deckIds.has(referenceDirectionId) && !suppliedIds.has(referenceDirectionId))
    ) {
      throw new Error(
        `sections[${index}].referenceDirectionId must identify an attached user reference or internal direction`,
      )
    }
    if (suppliedIds.has(referenceDirectionId)) {
      usesSuppliedReference = true
      return { ...section, referenceDirectionId }
    }
    const direction = deck.find((entry) => entry.id === referenceDirectionId)
    if (!direction || direction.family !== section.layoutFamily) {
      throw new Error(
        `sections[${index}].referenceDirectionId must belong to ${section.layoutFamily}`,
      )
    }
    return { ...section, referenceDirectionId }
  })
  if (suppliedIds.size && !usesSuppliedReference) {
    throw new Error('page must select at least one attached user reference')
  }
  return { ...page, sections }
}

function hashSeed(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

export function selectReferenceDirectionDeck(
  brief: DesignBrief,
  _brand: BrandSystem,
): ReferenceDirection[] {
  const seed = JSON.stringify({
    subject: brief.subject,
    pageType: brief.pageType,
    scope: brief.scope,
    primaryGoal: brief.primaryGoal,
    audience: brief.audience,
    offer: brief.offer,
    primaryAction: brief.primaryAction,
    requiredContent: brief.requiredContent,
  })

  return PAGE_LAYOUT_FAMILIES.map((family) => {
    const candidates = REFERENCE_DIRECTIONS.filter((entry) => entry.family === family)
    const selected = candidates[hashSeed(`${seed}\u001f${family}`) % candidates.length]
    if (!selected) throw new Error(`No reference direction found for ${family}`)
    return selected
  })
}
