/** Narrowest the right workspace panel can be dragged. */
export const MIN_WORKSPACE_PANEL_WIDTH = 360

/** Width the right workspace panel opens at until the user resizes it. */
export const DEFAULT_WORKSPACE_PANEL_WIDTH = 520

/**
 * Restores a stored right-panel width. Anything unreadable or below the
 * minimum falls back to the default, and a width saved on a larger screen is
 * capped so the chat keeps part of this window.
 */
export function restoreWorkspacePanelWidth(stored: number, windowWidth: number): number {
  if (!Number.isFinite(stored) || stored < MIN_WORKSPACE_PANEL_WIDTH) {
    return DEFAULT_WORKSPACE_PANEL_WIDTH
  }
  return Math.min(stored, Math.max(MIN_WORKSPACE_PANEL_WIDTH, Math.floor(windowWidth * 0.78)))
}
