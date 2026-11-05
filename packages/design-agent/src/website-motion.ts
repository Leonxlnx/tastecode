import { readFileSync } from 'node:fs'

/**
 * How websites move in Design mode, as one switch.
 *
 * - `reveals`: a hero entrance and scroll reveals in at least two later sections, with
 *   TasteCode's tested reveal helper.
 *
 * Every motion sentence in the Page, Build and Review prompts for a website comes from here, so
 * changing this value changes all of them together. Dashboards keep their own rules.
 */
export type WebsiteMotionMode = 'reveals'
export const WEBSITE_MOTION_MODE: WebsiteMotionMode = 'reveals'

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

export function websiteMotion(_mode: WebsiteMotionMode = WEBSITE_MOTION_MODE): WebsiteMotion {
  return REVEALS
}
