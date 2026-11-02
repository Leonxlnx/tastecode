/**
 * Owner decision (2026-10-12): reference sampling stays random, but one page keeps one
 * design language. Every phase names the same anchor and splits authority the same way,
 * and the wording also has to read correctly for decks saved before anchor sampling,
 * whose entries carry no site or role.
 */
export const ANCHOR_REFERENCE =
  'the anchor reference (the deck entry whose role is "anchor"; in a deck without roles, the hero reference, otherwise the first reference; when the user attached references, the first attached user reference)'

export const ONE_DESIGN_LANGUAGE = `ONE DESIGN LANGUAGE:
Reference sampling stays random, but the page keeps one design language: one type system of at most two families, one palette, one radius and spacing scale, and one button, card, label and surface language. Brand derives that language from ${ANCHOR_REFERENCE}, together with its one-line style summary when the deck records one; explicit user requirements and existing brand assets still take precedence. Later phases take it only from the approved brand system and its designTokens. Every other reference contributes macro composition only: grid, column structure, media count and crop, alignment, overlap, section proportions and responsive order. Never carry another reference's typefaces, type scale, radii, spacing scale, buttons, labels, card styling or light and dark surfaces into its section; render that section in the page's one language instead.`
