/**
 * Words that say nothing about a product's domain: grammar, request verbs, surface names and
 * interface parts every dashboard has. Matching them would favor wordy cues over the domain.
 */
const GENERIC_WORDS = new Set(
  [
    // English grammar and request verbs
    'an as at be by do if in is it me my no of on or so to up us we',
    'about across after also and any are based but can could each every for from get give has have',
    'help into its just let like make more most need needs new not our out over please should show',
    'some that the their them then there these they this those use used using very want was way',
    'what when where which who will with would you your build create design',
    // German grammar and request verbs
    'da es im ob zu',
    'auf aus bitte das dem den der des die ein eine einem einen einer erstelle erstellen baue bauen',
    'fuer für mach mache machen mein meine mit oder und unser unsere von zum zur',
    // Surfaces and catalog boilerplate
    'admin anwendung app apps application dashboard desktop full generated interface mobile panel',
    'platform product screen site software tool ui ux view web webapp website oberflaeche oberfläche',
    // Interface parts nearly every dashboard has
    'button card chart column detail drawer filter form header kpi kpis layout list menu metric modal',
    'nav navigation overview page row rows search setting sidebar status tab tabs table toolbar widget',
  ]
    .join(' ')
    .split(' '),
)

/** Light plural folding so "invoices" meets "invoice"; applied to both sides of a match. */
function fold(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word
}

/** Distinct domain-bearing words of free text, case-folded and plural-folded. */
export function relevanceWords(text: string): Set<string> {
  const words = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const word = fold(raw)
    if (raw.length > 1 && !GENERIC_WORDS.has(raw) && !GENERIC_WORDS.has(word)) words.add(word)
  }
  return words
}

/**
 * Catalog words of one reference. Names (domain, tags, product name) identify what the screen
 * is for and weigh double; descriptions (cue, motifs) only mention what is on it.
 */
export interface ReferenceRelevance {
  names: readonly string[]
  descriptions: readonly string[]
}

export function referenceRelevance(names: string[], descriptions: string[]): ReferenceRelevance {
  const nameWords = relevanceWords(names.join(' '))
  return {
    names: [...nameWords],
    descriptions: [...relevanceWords(descriptions.join(' '))].filter(
      (word) => !nameWords.has(word),
    ),
  }
}

export function relevanceScore(
  requestWords: ReadonlySet<string>,
  relevance: ReferenceRelevance,
): number {
  let score = 0
  for (const word of relevance.names) if (requestWords.has(word)) score += 2
  for (const word of relevance.descriptions) if (requestWords.has(word)) score += 1
  return score
}
