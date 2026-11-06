import {
  IconAdjustmentsHorizontal,
  IconArrowBackUp,
  IconArrowsMinimize,
  IconAt,
  IconBlocks,
  IconBrain,
  IconBug,
  IconBulb,
  IconChartDonut,
  IconChecklist,
  IconClick,
  IconCode,
  IconCoins,
  IconDownload,
  IconFileDiff,
  IconFilePlus,
  IconFolderPlus,
  IconGauge,
  IconGitFork,
  IconHelp,
  IconKeyboard,
  IconListDetails,
  IconMessages,
  IconNetwork,
  IconNews,
  IconPalette,
  IconRefresh,
  IconRepeat,
  IconRobot,
  IconShieldSearch,
  IconSlash,
  IconStethoscope,
  IconTarget,
  IconTelescope,
  IconTerminal2,
  IconWand,
  IconWebhook,
  IconZoomCode,
  type TablerIcon,
} from '@tabler/icons-react'
import { appCommandIcon } from '../app-commands.js'
import type { ComposerChipKind } from './composer-chips.js'

/** Every skill shows the icon of the Skills screen, whichever provider lists it. */
export const SKILL_ICON: TablerIcon = IconBlocks
/** Every MCP server shows the icon of the MCP servers screen. */
export const MCP_ICON: TablerIcon = IconNetwork
/** A command the app has no picture for. */
export const COMMAND_ICON: TablerIcon = IconSlash

/**
 * Built-in commands the providers list, by name. Shared by every provider: a
 * name means the same job wherever it comes from (Codex and Claude Code both
 * have `/review`), so this never asks which provider listed it.
 */
const COMMAND_ICONS = {
  goal: IconTarget,
  init: IconFilePlus,
  review: IconZoomCode,
  'code-review': IconZoomCode,
  'security-review': IconShieldSearch,
  compact: IconArrowsMinimize,
  context: IconChartDonut,
  doctor: IconStethoscope,
  simplify: IconWand,
  loop: IconRepeat,
  advisor: IconBulb,
  'deep-research': IconTelescope,
  design: IconPalette,
  help: IconHelp,
  hooks: IconWebhook,
  changelog: IconNews,
  'release-notes': IconNews,
  credits: IconCoins,
  'usage-credits': IconCoins,
  quota: IconGauge,
  effort: IconAdjustmentsHorizontal,
  plan: IconListDetails,
  memory: IconBrain,
  todos: IconChecklist,
  diff: IconFileDiff,
  undo: IconArrowBackUp,
  rewind: IconArrowBackUp,
  fork: IconGitFork,
  export: IconDownload,
  bug: IconBug,
  ide: IconCode,
  vim: IconKeyboard,
  'add-dir': IconFolderPlus,
  'pr-comments': IconMessages,
  agents: IconRobot,
  'terminal-setup': IconTerminal2,
  'reload-plugins': IconRefresh,
  mention: IconAt,
} as const satisfies Record<string, TablerIcon>

function hasCommandIcon(name: string): name is keyof typeof COMMAND_ICONS {
  return Object.hasOwn(COMMAND_ICONS, name)
}

export function commandIcon(name: string): TablerIcon {
  const key = name.toLowerCase()
  // TasteCode's own commands keep the icon their feature uses elsewhere.
  const own = appCommandIcon(key)
  if (own) return own
  if (hasCommandIcon(key)) return COMMAND_ICONS[key]
  // Claude Code lists an MCP server's prompts as `mcp__server__prompt`.
  return key.startsWith('mcp__') ? MCP_ICON : COMMAND_ICON
}

export function chipIcon(kind: ComposerChipKind, name: string): TablerIcon {
  if (kind === 'browser') return IconClick
  if (kind === 'skill') return SKILL_ICON
  if (kind === 'mcp') return MCP_ICON
  return commandIcon(name)
}
