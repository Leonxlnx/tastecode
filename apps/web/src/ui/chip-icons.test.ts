import { describe, expect, it } from 'vitest'
import {
  IconAdjustmentsHorizontal,
  IconArrowsMinimize,
  IconBlocks,
  IconChartBar,
  IconFilePlus,
  IconMessageCirclePlus,
  IconNetwork,
  IconShieldSearch,
  IconSlash,
  IconTarget,
  IconZoomCode,
} from '@tabler/icons-react'
import { commandIcon, MCP_ICON, SKILL_ICON } from './chip-icons.js'

describe('chip icons', () => {
  it('gives the built-in commands a picture of what they do', () => {
    expect(commandIcon('goal')).toBe(IconTarget)
    expect(commandIcon('init')).toBe(IconFilePlus)
    expect(commandIcon('review')).toBe(IconZoomCode)
    expect(commandIcon('Review')).toBe(IconZoomCode)
    expect(commandIcon('compact')).toBe(IconArrowsMinimize)
    expect(commandIcon('security-review')).toBe(IconShieldSearch)
  })

  it("keeps TasteCode's own commands on their feature icons, aliases included", () => {
    expect(commandIcon('side')).toBe(IconMessageCirclePlus)
    expect(commandIcon('btw')).toBe(IconMessageCirclePlus)
    expect(commandIcon('status')).toBe(IconChartBar)
    expect(commandIcon('model')).toBe(IconAdjustmentsHorizontal)
    expect(commandIcon('mcp')).toBe(IconNetwork)
  })

  it('falls back to the slash for commands it has no picture for', () => {
    expect(commandIcon('my-custom-command')).toBe(IconSlash)
    expect(commandIcon('constructor')).toBe(IconSlash)
    expect(commandIcon('mcp__docs__search')).toBe(IconNetwork)
  })

  it('gives every skill and every MCP server one icon', () => {
    expect(SKILL_ICON).toBe(IconBlocks)
    expect(MCP_ICON).toBe(IconNetwork)
  })
})
