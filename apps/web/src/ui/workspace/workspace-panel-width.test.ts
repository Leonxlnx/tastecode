import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE_PANEL_WIDTH,
  MIN_WORKSPACE_PANEL_WIDTH,
  restoreWorkspacePanelWidth,
} from './workspace-panel-width.js'

describe('workspace panel width', () => {
  it('lets the right panel narrow well below its default width', () => {
    expect(MIN_WORKSPACE_PANEL_WIDTH).toBe(300)
    expect(DEFAULT_WORKSPACE_PANEL_WIDTH).toBe(520)
  })

  it('restores a narrow width the user dragged to', () => {
    expect(restoreWorkspacePanelWidth(300, 1440)).toBe(300)
    expect(restoreWorkspacePanelWidth(332, 1440)).toBe(332)
  })

  it('falls back to the default for a missing or too narrow width', () => {
    expect(restoreWorkspacePanelWidth(Number.NaN, 1440)).toBe(520)
    expect(restoreWorkspacePanelWidth(0, 1440)).toBe(520)
    expect(restoreWorkspacePanelWidth(299, 1440)).toBe(520)
  })

  it('caps a width saved on a larger screen, never below the minimum', () => {
    expect(restoreWorkspacePanelWidth(1200, 1000)).toBe(780)
    expect(restoreWorkspacePanelWidth(340, 360)).toBe(300)
  })
})
