import { describe, expect, it } from 'vitest'
import { allowsMicrophoneRequest, isOwnRendererPermission } from './media-permissions.js'

describe('allowsMicrophoneRequest', () => {
  it('allows an explicit audio-only request', () => {
    expect(allowsMicrophoneRequest({ mediaTypes: ['audio'] })).toBe(true)
  })

  it('rejects video and mixed capture requests', () => {
    expect(allowsMicrophoneRequest({ mediaTypes: ['video'] })).toBe(false)
    expect(allowsMicrophoneRequest({ mediaTypes: ['audio', 'video'] })).toBe(false)
  })

  it.each([
    undefined,
    null,
    true,
    'audio',
    [],
    {},
    { mediaTypes: 'audio' },
    { mediaTypes: [] },
    { mediaTypes: [null] },
    { mediaTypes: [1] },
    { mediaTypes: ['unknown'] },
    { mediaTypes: ['audio', 'unknown'] },
    { mediaTypes: ['audio', 'audio'] },
    { mediaTypes: ['Audio'] },
  ])('rejects malformed or unsupported details: %j', (details) => {
    expect(allowsMicrophoneRequest(details)).toBe(false)
  })
})

describe('own renderer permissions', () => {
  it('limits the default session to microphone and installed-font access', () => {
    expect(isOwnRendererPermission('media', 'audio')).toBe(true)
    for (const mediaType of [undefined, null, 'unknown', 'video', ['audio']])
      expect(isOwnRendererPermission('media', mediaType)).toBe(false)
    expect(isOwnRendererPermission('local-fonts')).toBe(true)
    expect(isOwnRendererPermission('geolocation')).toBe(false)
    expect(isOwnRendererPermission('unknown')).toBe(false)
  })
})
