import { readFileSync } from 'node:fs'
import { isDashboardBrief, type DesignBrief } from './brief.js'
import type { PageBlueprint } from './page.js'

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

const DASHBOARD_MOTION_GUIDANCE = `DASHBOARD INTERACTION AND MOTION:
Build an operating product interface from the selected dashboard references. Implement real state changes for the visible filters, sorting, tabs, navigation, drawers and chart controls that the task needs. Preserve the reference shell, information density and desktop/mobile hierarchy. Do not add marketing heroes, promotional sections or scroll reveals merely to satisfy website animation rules.

Unless the user explicitly requests no animation, animate useful state transitions by default: selected-tab movement, navigation or drawer opening, filter/sort result changes, and chart changes tied to an actual period or metric selection. Keep interactions interruptible, around 120-250ms with clear ease-out, and preserve chart scales, readable values and stable row identity. Do not replay entrances on every data refresh, hide essential data behind an animation, count up invented metrics or use perpetual decorative motion. Use native CSS or Web Animations where sufficient and reuse installed motion tools.

Wire each visible control to its real action, not unused keyframes or hover-only decoration. Support keyboard operation, visible focus, Escape and focus return for dismissible overlays, and semantic selected/expanded states. Respect prefers-reduced-motion with immediate readable final states and equivalent operation. Test actual filtering, sorting, tab/navigation changes and drawer/chart transitions in the browser where present, including rapid repeated input, desktop/mobile layouts and reduced motion. Record what was exercised; a still screenshot cannot prove interaction behavior or animation timing.`

export function designMotionGuidance(
  brief?: Pick<DesignBrief, 'pageType' | 'originalRequest'>,
  page?: PageBlueprint,
): string {
  return (brief && isDashboardBrief(brief)) || page?.architecture?.mode === 'operate_monitor'
    ? DASHBOARD_MOTION_GUIDANCE
    : DESIGN_MOTION_GUIDANCE
}
