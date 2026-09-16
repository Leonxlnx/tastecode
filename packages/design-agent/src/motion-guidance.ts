import { readFileSync } from 'node:fs'

export const REFERENCE_REVEAL_SOURCE = readFileSync(
  new URL('../references/motion/reveal.js', import.meta.url),
  'utf8',
)

export const DESIGN_MOTION_GUIDANCE = `VISIBLE MOTION:
Animate new websites by default. Reference screenshots lock composition, not stillness: animate into and between those exact layouts. Unless the user explicitly requests no animation, a static page with only button color changes or 1px pressed states is incomplete.

Plan and implement a visible hero entrance on load, distinct scroll-triggered reveals for at least two later content or media sections when present, and interaction feedback for buttons, navigation and disclosures. Use the reference geometry: stagger headline and media, reveal a photograph through its existing frame, or introduce related items in a short sequence. Do not apply the same fade-up to every section. Brief and Brand assumptions such as calm, professional, or restrained do not mean motionless.

Give each motion an actual trigger, affected elements, properties, duration, easing and reduced-motion behavior. Use roughly 450-800ms for entrances and media reveals, 60-100ms item staggering, and 120-250ms for direct feedback. Prefer native CSS, Web Animations and IntersectionObserver for these effects; reuse an installed motion library where appropriate. Keep motion inside the selected layout and avoid scroll-jacking, perpetual floating, layout shifts or interaction gated behind an animation.

SCROLL STABILITY: Reveals run once and never reset on exit, direction changes, resize or rerenders. Observe individual visual groups, not a tall section with a percentage threshold. Start just before entry (threshold 0, positive bottom rootMargin), unobserve immediately, and keep the finished state. Never wait until 20% of an already visible section is onscreen and then animate opacity from zero: that causes visible -> hidden -> visible flicker. Only prepare hidden states for elements still below the viewport; elements visible at initialization or restored scroll stay visible. CSS defaults to the final visible state, with no global opacity:0 reveal class. Do not put transforms on ancestors of sticky/fixed controls or nest reveal transforms. Animate opacity and transform, avoid large clip-path/filter/blur animations, and cap staggering at 240ms total. Rapid scrolling must never produce a backlog of invisible content. Cleanup and reduced-motion changes must cancel owned animations, disconnect observers and restore visibility; never cancel unrelated animations through document.getAnimations(). Keep page scrolling native.

Build must wire the triggers and classes, not merely declare unused keyframes. Keep content visible if scripting fails. Honor prefers-reduced-motion with immediately readable final states and equivalent controls. Verify an actual hero animation, a reveal after scrolling and the reduced-motion state in the browser; also rapidly scroll down/up twice, reload at a middle scroll position, resize and toggle reduced motion during playback. Assert every visited section remains visible and does not replay. Record actual browser evidence; do not infer smoothness from a screenshot. Review must flag missing planned motion when browser evidence proves it, while recognizing that a still screenshot alone cannot establish whether an animation ran.`
