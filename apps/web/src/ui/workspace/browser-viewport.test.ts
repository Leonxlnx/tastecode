import { describe, expect, it } from 'vitest'
import { BROWSER_VIEWPORTS, fitBrowserViewport } from './browser-viewport.js'

describe('browser viewport fitting', () => {
  it('fills the canvas in fluid mode', () => {
    expect(fitBrowserViewport(643.8, 901.2, viewport('fluid'))).toEqual({
      width: 643,
      height: 901,
    })
  })

  it('preserves desktop aspect ratio while scaling down', () => {
    const fitted = fitBrowserViewport(600, 1000, viewport('desktop'))

    expect(fitted).toMatchObject({
      width: 600,
      height: 375,
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
    })
    expect(fitted.width / fitted.height).toBe(1.6)
  })

  it('fits portrait devices by height and never stretches them', () => {
    expect(fitBrowserViewport(1200, 700, viewport('tablet'))).toMatchObject({
      width: 525,
      height: 700,
      viewport: { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true },
    })
    expect(fitBrowserViewport(500, 1000, viewport('mobile'))).toMatchObject({
      width: 390,
      height: 844,
    })
  })
})

function viewport(id: (typeof BROWSER_VIEWPORTS)[number]['id']) {
  return BROWSER_VIEWPORTS.find((candidate) => candidate.id === id)!
}
