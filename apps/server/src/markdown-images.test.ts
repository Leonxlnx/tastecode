import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { localImagePath, markdownImagePaths, showsImage } from './markdown-images.js'

const shot = path.join(os.tmpdir(), 'turn-rail-shot', 'rail-dark.png')
const spaced = path.join(os.tmpdir(), 'turn rail', 'rail light.png')

describe('markdownImagePaths', () => {
  it('finds the screenshots a reply shows by path', () => {
    const reply = `The rail now:\n![Rail, dark](${shot})\n![Rail, light](<${spaced}>)`
    expect(markdownImagePaths(reply)).toEqual([shot, spaced])
  })

  it('reads file URLs and percent-encoded paths as the files they name', () => {
    const url = pathToFileURL(spaced).href
    expect(markdownImagePaths(`![a](${url}) and ![b](${encodeURI(shot)} "title")`)).toEqual([
      spaced,
      shot,
    ])
  })

  it('leaves web addresses, links and relative paths alone', () => {
    const reply = [
      '![remote](https://example.com/a.png)',
      '![scheme-less](//example.com/a.png)',
      '![relative](shots/a.png)',
      `[a link, not an image](${shot})`,
    ].join('\n')
    expect(markdownImagePaths(reply)).toEqual([])
  })
})

describe('localImagePath', () => {
  it('keeps a path whose name has a stray percent sign', () => {
    const odd = path.join(os.tmpdir(), '100%.png')
    expect(localImagePath(odd)).toBe(odd)
  })
})

describe('showsImage', () => {
  it('matches the file however the reply spelled its path', () => {
    const reply = `![x](${pathToFileURL(shot).href})`
    expect(showsImage(reply, shot)).toBe(true)
    expect(
      showsImage(
        reply,
        path.join(os.tmpdir(), 'turn-rail-shot', '..', 'turn-rail-shot', 'rail-dark.png'),
      ),
    ).toBe(true)
    expect(showsImage(reply, spaced)).toBe(false)
  })
})
