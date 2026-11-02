import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { openCodePromptParts, openCodeV2Files } from './attachments.js'

describe('OpenCode attachments', () => {
  const folder = path.join('attachments')

  it('sends images and PDFs with their mime type and other files for the Read tool', () => {
    const image = path.resolve(folder, 'Shot.PNG')
    const pdf = path.resolve(folder, 'spec.pdf')
    const notes = path.resolve(folder, 'notes.md')
    expect(openCodePromptParts('Look', [image, pdf, notes])).toEqual([
      { type: 'text', text: 'Look' },
      { type: 'file', mime: 'image/png', filename: 'Shot.PNG', url: pathToFileURL(image).href },
      { type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: pathToFileURL(pdf).href },
      { type: 'file', mime: 'text/plain', filename: 'notes.md', url: pathToFileURL(notes).href },
    ])
    expect(openCodePromptParts('Plain', [])).toEqual([{ type: 'text', text: 'Plain' }])
  })

  it('adds v2 files only when there are attachments', () => {
    const image = path.resolve(folder, 'shot.png')
    expect(openCodeV2Files([])).toEqual({})
    expect(openCodeV2Files([image])).toEqual({
      files: [{ uri: pathToFileURL(image).href, name: 'shot.png' }],
    })
  })
})
