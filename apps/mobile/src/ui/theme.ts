import { PlatformColor } from 'react-native'
import type { ProviderId } from '@harness/contracts'

/**
 * The desktop's rule carried over: neutral by default, colour only where it
 * means something. Controls take the label colour (black in light mode, white
 * in dark); blue marks a chat that needs you, red an error.
 */
export const ACCENT = PlatformColor('label')
export const TINT = 'primary'
export const ATTENTION = 'blue'
export const FAILURE = 'red'

/** Provider identity colours, as the desktop's Usage page uses them. */
export function providerColor(provider: ProviderId): string {
  switch (provider) {
    case 'claude-code':
      return '#D97757'
    case 'cursor':
      return '#8C8CFF'
    case 'opencode':
      return '#F2A93B'
    case 'antigravity':
      return '#4C8BF5'
    default:
      return 'secondary'
  }
}
