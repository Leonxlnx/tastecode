/**
 * The switch for the dashboard surface of Design mode (owner decision, 2026-10-16).
 *
 * The first dashboard reference set did not meet the design bar, so dashboards are parked until
 * a better reviewed set exists. While this is false:
 * - no dashboard catalog or `dashboard` family entry is loaded from any reference library,
 *   including a configured local library that still ships `dashboard-catalog.json`;
 * - `isDashboardBrief` never routes a run into dashboard mode, and no phase switches to the
 *   dashboard plan, motion, build or review prompts;
 * - the Page protocol stops offering the `operate_monitor` mode and the `dashboard` family.
 *
 * A request for a dashboard or app screen still completes as a normal website Design run built
 * from website references; the brief records that dashboard screens are not available. Turn
 * this back on only together with new reviewed assets in `dashboard-catalog.json`.
 */
export const DASHBOARD_REFERENCES_ENABLED: boolean = false
