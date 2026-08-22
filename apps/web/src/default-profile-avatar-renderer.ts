import { Avatar, Style } from '@dicebear/core'
import glass from '@dicebear/styles/glass.json' with { type: 'json' }

const DEFAULT_AVATAR_STYLE = new Style(glass)

export function renderDefaultProfileAvatar(seed: string): string {
  return new Avatar(DEFAULT_AVATAR_STYLE, {
    seed,
    size: 128,
  }).toDataUri()
}
