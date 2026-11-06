import { isDashboardBrief, isDashboardPageMode, type DesignBrief } from './brief.js'
import type { PageBlueprint } from './page.js'
import { websiteMotion } from './website-motion.js'

export { REFERENCE_REVEAL_SOURCE } from './website-motion.js'

/** The website motion block for the current WEBSITE_MOTION_MODE (website-motion.ts). */
export const DESIGN_MOTION_GUIDANCE = websiteMotion().guidance

const DASHBOARD_MOTION_GUIDANCE = `DASHBOARD INTERACTION AND MOTION:
Build an operating product interface from its dealt app sheet or its selected dashboard reference. Implement real state changes for the visible filters, sorting, tabs, navigation, drawers and chart controls that the task needs. Preserve the shell, information density and desktop/mobile hierarchy. Do not add marketing heroes, promotional sections or scroll reveals merely to satisfy website animation rules. Motion on an app screen is feedback: a press, hover, focus, a menu or sheet opening, a row arriving, a filter applied. Nothing on the screen performs an entrance.

Unless the user explicitly requests no animation, animate useful state transitions by default: selected-tab movement, navigation or drawer opening, filter/sort result changes, and chart changes tied to an actual period or metric selection. Use one shared duration and easing pair for these transitions across every view. Keep interactions interruptible, around 120-250ms with clear ease-out, and preserve chart scales, readable values and stable row identity. Do not replay entrances on every data refresh, hide essential data behind an animation, count up invented metrics or use perpetual decorative motion. Use native CSS or Web Animations where sufficient and reuse installed motion tools.

Wire each visible control to its real action, not unused keyframes or hover-only decoration. Support keyboard operation, visible focus, Escape and focus return for dismissible overlays, and semantic selected/expanded states. Respect prefers-reduced-motion with immediate readable final states and equivalent operation. Test actual filtering, sorting, tab/navigation changes and drawer/chart transitions in the browser where present, including rapid repeated input, desktop/mobile layouts and reduced motion. Record what was exercised; a still screenshot cannot prove interaction behavior or animation timing.`

export function designMotionGuidance(
  brief?: Pick<DesignBrief, 'pageType' | 'originalRequest'>,
  page?: PageBlueprint,
): string {
  return (brief && isDashboardBrief(brief)) || isDashboardPageMode(page?.architecture?.mode)
    ? DASHBOARD_MOTION_GUIDANCE
    : DESIGN_MOTION_GUIDANCE
}
