import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./media-viewer.css', import.meta.url), 'utf8')

describe('media viewer zoom', () => {
  it('fills the measured zoom frame without changing the initial image fit', () => {
    const fittedImageRule = css.match(
      /\.media-viewer__frame\[data-sized='true'\] img \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']

    expect(fittedImageRule).toContain('width: 100%')
    expect(fittedImageRule).toContain('height: 100%')
    expect(fittedImageRule).toContain('object-fit: contain')
  })
})
