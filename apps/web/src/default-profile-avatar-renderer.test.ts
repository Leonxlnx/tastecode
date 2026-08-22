import { describe, expect, it } from 'vitest'
import { renderDefaultProfileAvatar } from './default-profile-avatar-renderer.js'

describe('default profile avatar renderer', () => {
  it('generates stable DiceBear Glass avatars locally', () => {
    const avatar = renderDefaultProfileAvatar('Blue Emi')

    expect(avatar).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u)
    expect(renderDefaultProfileAvatar('Blue Emi')).toBe(avatar)
    expect(renderDefaultProfileAvatar('Leon')).not.toBe(avatar)
  })
})
