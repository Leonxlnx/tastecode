import { readFileSync } from 'node:fs'
import { tasteskillSection } from './tasteskill-web.js'

/**
 * How websites move in Design mode. The one switch for it (owner decision, 2026-11-05: hybrid).
 *
 * - `hybrid` (C): tasteskill v2.5's hover layer and tech budget, no card or row reveals, plus one
 *   load motion in the hero and one creative moment in its own section on every kind of page.
 * - `tasteskill` (A): tasteskill's motion chapter as written: other pages move only on hover.
 * - `reveals` (B): the earlier Design guidance: a hero entrance and scroll reveals in at least two
 *   later sections, with TasteCode's tested reveal helper.
 *
 * Every motion sentence in the Page, Build and Review prompts for a website comes from here, so
 * changing this value changes all of them together. Dashboards keep their own rules.
 */
export type WebsiteMotionMode = 'hybrid' | 'tasteskill' | 'reveals'
export const WEBSITE_MOTION_MODE: WebsiteMotionMode = 'hybrid'

export interface WebsiteMotion {
  /** The motion block every website phase reads. */
  guidance: string
  /** Page: what each section's motion decision has to cover. */
  pagePlan: string
  /** Build: how the recorded motion is implemented. */
  build: string
  /** Build: tested source to reuse, or '' when the mode has none. */
  buildSource: string
  /** Review: how motion is judged. */
  review: string
}

export const REFERENCE_REVEAL_SOURCE = readFileSync(
  new URL('../references/motion/reveal.js', import.meta.url),
  'utf8',
)

const REVEALS_GUIDANCE = `VISIBLE MOTION:
Animate new websites by default. Reference screenshots lock composition, not stillness: animate into and between those exact layouts. Unless the user explicitly requests no animation, a static page with only button color changes or 1px pressed states is incomplete.

Plan and implement a visible hero entrance on load, distinct scroll-triggered reveals for at least two later content or media sections when present, and interaction feedback for buttons, navigation and disclosures. Use the reference geometry: stagger headline and media, reveal a photograph through its existing frame, or introduce related items in a short sequence. Give the page one motion vocabulary: two or three named reveal types (for example rise, slide and media) with shared durations, easing and stagger, reused across sections; each section picks the type that fits its geometry instead of inventing its own effect. Do not apply the same fade-up to every section. Brief and Brand assumptions such as calm, professional, or restrained do not mean motionless.

Give each motion an actual trigger, affected elements, properties, duration, easing and reduced-motion behavior. Use roughly 450-800ms for entrances and media reveals, 60-100ms item staggering, and 120-250ms for direct feedback. Prefer native CSS, Web Animations and IntersectionObserver for these effects; reuse an installed motion library where appropriate. Keep motion inside the selected layout and avoid scroll-jacking, perpetual floating, layout shifts or interaction gated behind an animation.

SCROLL STABILITY: Reveals run once and never reset on exit, direction changes, resize or rerenders. Observe individual visual groups, not a tall section with a percentage threshold. Start just before entry (threshold 0, positive bottom rootMargin), unobserve immediately, and keep the finished state. Never wait until 20% of an already visible section is onscreen and then animate opacity from zero: that causes visible -> hidden -> visible flicker. Only prepare hidden states for elements still below the viewport; elements visible at initialization or restored scroll stay visible. CSS defaults to the final visible state, with no global opacity:0 reveal class. Do not put transforms on ancestors of sticky/fixed controls or nest reveal transforms. Animate opacity and transform, avoid large clip-path/filter/blur animations, and cap staggering at 240ms total. Rapid scrolling must never produce a backlog of invisible content. Cleanup and reduced-motion changes must cancel owned animations, disconnect observers and restore visibility; never cancel unrelated animations through document.getAnimations(). Keep page scrolling native.

Build must wire the triggers and classes, not merely declare unused keyframes. Keep content visible if scripting fails. Honor prefers-reduced-motion with immediately readable final states and equivalent controls. Verify an actual hero animation, a reveal after scrolling and the reduced-motion state in the browser; also rapidly scroll down/up twice, reload at a middle scroll position, resize and toggle reduced motion during playback. Assert every visited section remains visible and does not replay. Record actual browser evidence; do not infer smoothness from a screenshot. Review must flag missing planned motion when browser evidence proves it, while recognizing that a still screenshot alone cannot establish whether an animation ran.`

const REVEALS: WebsiteMotion = {
  guidance: REVEALS_GUIDANCE,
  pagePlan:
    'Plan hero and media entrances as spatial continuity or explanation; purpose none is available for remaining static sections after the required page animations are covered, or when the user explicitly requests no animation.',
  build:
    "Implement each section's recorded motion decision as deliberately as its layout. Use the project's existing motion dependencies when present, native CSS and IntersectionObserver for simple cases, and GSAP-style timelines only when the recorded scroll, drag, pin, or sequence cannot be expressed cleanly without them. Keep interface feedback under 300ms unless the artifact gives a justified exception, animate transform and opacity instead of layout properties, never use transition: all, and never enter from scale(0). Gate hover motion behind hover-capable fine pointers and implement the recorded prefers-reduced-motion behavior. Implement the page's motion vocabulary once, as two or three named reveal types with shared timing, and reuse it; do not apply the same fade-up to every section, invent a new effect for each section, or animate decorative elements without a purpose.",
  buildSource: `Use this tested native reveal implementation for simple scroll entrances; copy or inline it in the existing script and call installReferenceReveals after mounting. Mark selected leaf groups data-reveal="rise|slide|media". Keep CSS visible by default. In React return its cleanup from the effect. An existing motion library may implement the same lifecycle guarantees. The hero is separate: use a transform-only entrance if it has already painted; never hide it late while waiting for fonts or assets.
<reference-reveal-source>
${REFERENCE_REVEAL_SOURCE}
</reference-reveal-source>`,
  review:
    "Review each section's recorded motion decision against the rendered result when the evidence makes that possible. Motion must have one clear purpose, preserve spatial continuity, reuse the page's two or three named reveal types instead of a different effect per section or one generic fade-up everywhere, and provide a reduced-motion path. Do not claim that a still screenshot proves timing or interaction behavior; use unknown confidence when the browser evidence cannot show it.",
}

/** The motion chapter's numbers: hover, press, focus and loop timings every mode except B uses. */
function quotedMotion(sections: readonly string[]): string {
  return `The text below is quoted unchanged from tasteskill v2.5's motion chapter (references/motion.md, MIT). TasteCode does not install its kit: where it names \`motion.css\`, \`motion.js\`, \`ui.js\`, \`system.js\`, a \`.btn\`, \`.card\`, \`.m-*\` or \`data-*\` hook, implement the stated motion with the page's own markup, CSS and script, at the stated numbers.

<tasteskill-motion>
${sections.map((heading) => tasteskillSection('motion.md', heading)).join('\n\n')}
</tasteskill-motion>`
}

const KINDS = `Tech means a page about software, a game or hardware (tasteskill's kinds software, gaming and tech); every other page (a physical product, a service, a place people visit) is other. Decide the kind from the brief and record it in the page plan.`

const HYBRID_GUIDANCE = `WEBSITE MOTION (TasteCode Design, hybrid):
Every page moves in three ways, and in no other:
1. The hover and focus layer on every kind, at the numbers quoted below: buttons step and press, a linked card lifts 2px, a photograph in a link zooms 1.02 to 1.03 inside its frame, links draw their underline, focus rings settle. Every change is the visitor's. It works by tap and keyboard as well, and only for a fine pointer on hover.
2. One load motion in the hero on every kind, 600 to 1200ms, settled by 1.5s: the hero's visual assembles, its media opens through its own frame, or its object turns into place. The hero text is in place on the first frame and is never faded or moved. There is no gate, loader or intro.
3. One creative moment in its own section on every kind, chosen for what the page sells and built for it, never a generic effect. Examples: the place's name or address set very large and drawn in; a before and after the visitor drags; the product's few steps shown in sequence; a route line drawn to the address; a real figure from the brief counting up once. The moment stays inside its own section, and that section keeps its one- or two-screen height. It may follow the scroll only inside its own box, pinned at most with position: sticky inside that box. Its text is live and readable at every step, and its finished frame is a complete still. It never moves a card, a row, a photograph, a price, an FAQ or the footer. On other pages it uses CSS, SVG or the Web Animations API, never WebGL, a canvas shader or an animation library. On tech pages it may use WebGL inside the tech budget below.

${KINDS} A tech page also gets the tech budget below: card loops (one per card group), one timed loop in the hero or the one visual frame, one count, and its one creative moment counts as one of the one or two moments.

Nothing else moves by itself, on load, by time or on scroll. No card, row, tile, heading or photograph reveals, fades, rises, slides or staggers in as the page scrolls. No parallax, scroll-snap, scroll-jacking or smooth-scroll library, no marquee, carousel, slider, rotating notice, timed tabs, tilt, glow at the cursor, magnetic button or random blinking. Anything still moving 5 seconds after it is seen has a pause control.

Under prefers-reduced-motion the load motion and the moment show their finished frame at once, loops hold their finished picture, counts show their final figure and colours still change on hover. Without script every element is visible in its finished state.

Give each motion its trigger, elements, properties, duration, easing and reduced-motion state.

${quotedMotion(['Tokens', 'The hover layer', "Loops inside a card's visual (tech)", 'Tech budget', 'Reduced motion, no script, phones'])}

Where the quoted chapter says an other page has no entrance, count or moment, or that nothing animates on scroll, the hybrid rules above win for the hero's one load motion and the one creative moment. Everything else in it applies as written.`

const HYBRID: WebsiteMotion = {
  guidance: HYBRID_GUIDANCE,
  pagePlan:
    "Record the page's kind (tech or other). Give the hero its one load motion and give exactly one section the creative moment, with trigger, elements, properties, duration, easing and reduced-motion state; every other section records purpose none for entrances, because it moves only through the hover layer (and, on tech, its card loops).",
  build:
    "Implement the hover layer on every interactive element, the hero's one load motion, the one creative moment and, on a tech page, its card loops, at the numbers in the motion block. Use native CSS, SVG and the Web Animations API; on a tech page a WebGL moment may use an installed library. Animate transform and opacity, never layout properties; never use transition: all and never enter from scale(0). Gate hover behind hover-capable fine pointers. Do not add scroll reveals, a reveal helper or an entrance to any other section. Verify in the browser that the hero motion runs and settles, that the moment plays and ends on its finished frame, that the hover layer answers on a button, a linked card and a linked photograph, that reduced motion shows every finished frame at once, and that rapid scrolling down and up twice leaves every section visible.",
  buildSource: '',
  review:
    'Judge motion against the motion block. Report a missing or invisible hover layer, a missing hero load motion, a missing or generic creative moment, a moment outside its own section, or WebGL on an other page as findings. Report any card, row, heading or photograph that reveals or fades in on scroll, and any parallax, marquee or carousel. Do not claim that a still screenshot proves timing or interaction behavior; use unknown confidence when the browser evidence cannot show it.',
}

const TASTESKILL_GUIDANCE = `WEBSITE MOTION (tasteskill v2.5, as written):
${KINDS} Follow the quoted chapter exactly: the hover and focus layer on every kind; on a tech page also card loops, one timed loop, one count and one or two moments in their own sections; on an other page nothing moves by itself, on load, by time or on scroll.

${quotedMotion(['Tokens', 'The hover layer', "Loops inside a card's visual (tech)", 'Tech budget', 'Scroll', 'Reduced motion, no script, phones', 'Never'])}`

const TASTESKILL: WebsiteMotion = {
  guidance: TASTESKILL_GUIDANCE,
  pagePlan:
    "Record the page's kind (tech or other). On an other page every section records purpose none for entrances; its motion is the hover layer. On a tech page record its loops, its count and its one or two moments with trigger, elements, properties, duration, easing and reduced-motion state.",
  build: HYBRID.build
    .replace(
      ", the hero's one load motion, the one creative moment and, on a tech page, its card loops,",
      ' and, on a tech page, its loops, count and moments,',
    )
    .replace(
      'that the hero motion runs and settles, that the moment plays and ends on its finished frame, ',
      "that a tech page's loops and moments play and end on their finished frame, ",
    ),
  buildSource: '',
  review:
    'Judge motion against the quoted tasteskill motion chapter. Report a missing or invisible hover layer, anything that moves by itself on an other page, and any card, row or tile that reveals on scroll. Do not claim that a still screenshot proves timing or interaction behavior; use unknown confidence when the browser evidence cannot show it.',
}

export function websiteMotion(mode: WebsiteMotionMode = WEBSITE_MOTION_MODE): WebsiteMotion {
  return mode === 'reveals' ? REVEALS : mode === 'tasteskill' ? TASTESKILL : HYBRID
}
