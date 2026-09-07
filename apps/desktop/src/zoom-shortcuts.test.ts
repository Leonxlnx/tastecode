import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ZOOM_FACTOR,
  isZoomAction,
  nextZoomFactor,
  zoomShortcut,
} from './zoom-shortcuts.js'

describe('desktop zoom shortcuts', () => {
  it('maps control and command zoom keys without stealing unrelated shortcuts', () => {
    expect(zoomShortcut({ key: '=', control: true, meta: false, alt: false })).toBe('in')
    expect(zoomShortcut({ key: '-', control: false, meta: true, alt: false })).toBe('out')
    expect(zoomShortcut({ key: '0', control: true, meta: false, alt: false })).toBe('reset')
    expect(zoomShortcut({ key: '+', control: false, meta: false, alt: false })).toBeUndefined()
    expect(zoomShortcut({ key: '-', control: true, meta: false, alt: true })).toBeUndefined()
  })

  it('steps predictably and stays within the readable range', () => {
    expect(nextZoomFactor(DEFAULT_ZOOM_FACTOR, 'in')).toBe(1.2)
    expect(nextZoomFactor(DEFAULT_ZOOM_FACTOR, 'out')).toBe(1)
    expect(nextZoomFactor(1.7, 'reset')).toBe(DEFAULT_ZOOM_FACTOR)
    expect(nextZoomFactor(2, 'in')).toBe(2)
    expect(nextZoomFactor(0.5, 'out')).toBe(0.5)
  })

  it('rejects invalid renderer actions', () => {
    expect(isZoomAction('reset')).toBe(true)
    expect(isZoomAction('larger')).toBe(false)
    expect(isZoomAction({ action: 'in' })).toBe(false)
  })
})
