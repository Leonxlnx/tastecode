import { describe, expect, it } from 'vitest'
import { allowsMicrophoneRequest } from './media-permissions.js'

describe('allowsMicrophoneRequest', () => {
  it('allows audio when Electron omits its optional mediaTypes field', () => {
    expect(allowsMicrophoneRequest({})).toBe(true)
  })

  it('allows an explicit audio-only request', () => {
    expect(allowsMicrophoneRequest({ mediaTypes: ['audio'] })).toBe(true)
  })

  it('rejects video and mixed capture requests', () => {
    expect(allowsMicrophoneRequest({ mediaTypes: ['video'] })).toBe(false)
    expect(allowsMicrophoneRequest({ mediaTypes: ['audio', 'video'] })).toBe(false)
  })
})
