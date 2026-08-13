// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  PROFILE_IMAGE_MAX_BYTES,
  profileInitials,
  readProfileIdentityPreferences,
  readProfileImage,
  writeProfileIdentityPreferences,
} from './profile-preferences.js'

afterEach(() => localStorage.clear())

describe('profile preferences', () => {
  it('persists a bounded local identity and derives stable initials', () => {
    writeProfileIdentityPreferences({ displayName: '  Blue Emi  ', avatarDataUrl: undefined })

    expect(readProfileIdentityPreferences()).toEqual({ displayName: 'Blue Emi' })
    expect(profileInitials('Blue Emi')).toBe('BE')
    expect(profileInitials('Codex')).toBe('CO')
  })

  it('accepts signed raster images and rejects unsafe or oversized files', async () => {
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      'avatar.png',
      { type: 'image/png' },
    )
    await expect(readProfileImage(png)).resolves.toMatch(/^data:image\/png;base64,/u)

    await expect(
      readProfileImage(new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' })),
    ).rejects.toThrow('PNG, JPEG, or WebP')
    await expect(
      readProfileImage(new File(['not an image'], 'avatar.png', { type: 'image/png' })),
    ).rejects.toThrow('not a valid image')
    await expect(
      readProfileImage(
        new File([new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1)], 'large.png', {
          type: 'image/png',
        }),
      ),
    ).rejects.toThrow('smaller than 1 MB')
  })
})
