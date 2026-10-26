/**
 * The switch for dashboards and app screens built from the tasteskill v2.1 app library (owner
 * request, 2026-10-25).
 *
 * While this is true, a dashboard or app-screen brief routes into dashboard mode again: Briefing
 * records it as a dashboard, the server deals one app style, shell and screen patterns from
 * `references/app-screens/app.json` (see app-screens.ts), and the Brand, Page, Build and Review
 * phases plan and judge one working screen from that sheet and the quoted tasteskill rules. The
 * library holds no images, so this path needs neither the parked dashboard image catalog
 * (dashboard-references.ts stays off) nor an image-capable provider.
 */
export const APP_SCREENS_ENABLED: boolean = false
