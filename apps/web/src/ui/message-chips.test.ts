import { describe, expect, it } from 'vitest'
import { composerChipText, composerWireText } from './composer-chips.js'
import {
  composerTextWithChips,
  messageChipSegments,
  type KnownChipTokens,
} from './message-chips.js'

const NONE: KnownChipTokens = new Map()

function chips(text: string, known: KnownChipTokens = NONE) {
  return messageChipSegments(text, known).flatMap((segment) =>
    segment.type === 'chip' ? [`${segment.kind}:${segment.token}`] : [],
  )
}

describe('message chips', () => {
  it('draws the leading skills and command of a prompt as chips', () => {
    expect(chips('/goal $cook $design-taste-frontend ship the landing page')).toEqual([
      'command:/goal',
      'skill:$cook',
      'skill:$design-taste-frontend',
    ])
    // How earlier versions sent picked skills: ahead of the text.
    expect(chips('$cook\n\n/design-taste-frontend')).toEqual([
      'skill:$cook',
      'command:/design-taste-frontend',
    ])
  })

  it('keeps the text around the chips exactly as sent', () => {
    const segments = messageChipSegments('  /review the diff, please.', NONE)

    expect(segments).toEqual([
      { type: 'text', text: '  ' },
      { type: 'chip', kind: 'command', marker: '/', name: 'review', token: '/review' },
      { type: 'text', text: ' the diff, please.' },
    ])
  })

  it('leaves shell variables, paths, prices and mentions as text', () => {
    expect(chips('echo $HOME and $path')).toEqual([])
    expect(chips('/usr/bin/env is missing')).toEqual([])
    expect(chips('$5 off')).toEqual([])
    expect(chips('$HOME is unset')).toEqual([])
    expect(chips('@leon can you check')).toEqual([])
    expect(chips('@README.md explain this')).toEqual([])
    expect(chips('run /goal later')).toEqual([])
  })

  it('draws a token anywhere once this device picked it, with the kind it had', () => {
    const known: KnownChipTokens = new Map([
      ['$path', 'skill'],
      ['@officialDocs', 'mcp'],
      ['/design-taste-frontend', 'skill'],
    ])

    expect(chips('fix it with $path, then ask @officialDocs.', known)).toEqual([
      'skill:$path',
      'mcp:@officialDocs',
    ])
    expect(chips('/design-taste-frontend make it calm', known)).toEqual([
      'skill:/design-taste-frontend',
    ])
    // A command still counts only at the start.
    expect(chips('then /design-taste-frontend', known)).toEqual([])
  })

  it('marks only the blank space between two leading chips as a gap', () => {
    expect(messageChipSegments('$cook\n\n/design-taste-frontend\n\nmake it calm', NONE)).toEqual([
      { type: 'chip', kind: 'skill', marker: '$', name: 'cook', token: '$cook' },
      { type: 'text', text: '\n\n', gap: true },
      {
        type: 'chip',
        kind: 'command',
        marker: '/',
        name: 'design-taste-frontend',
        token: '/design-taste-frontend',
      },
      // The line break before the user's own words stays theirs.
      { type: 'text', text: '\n\nmake it calm' },
    ])
    // A single space needs no folding.
    expect(messageChipSegments('$cook $cinetic go', NONE)[1]).toEqual({ type: 'text', text: ' ' })
  })

  it('stops the leading run at the first word that is not a chip', () => {
    expect(chips('please $cook this')).toEqual([])
    expect(chips('$cook please /goal')).toEqual(['skill:$cook'])
  })

  it('keeps tokens whole when their names hold colons, dots or dashes', () => {
    expect(chips('/anthropic-skills:pdf summarize')).toEqual(['command:/anthropic-skills:pdf'])
    expect(chips('$cook.')).toEqual(['skill:$cook'])
  })

  it('puts a sent prompt back into the composer with its chips', () => {
    const known: KnownChipTokens = new Map([['@officialDocs', 'mcp']])
    const draft = composerTextWithChips('/goal $cook ask @officialDocs', known)

    expect(draft).toBe(
      `${composerChipText('/goal', 'command')} ${composerChipText('$cook', 'skill')} ask ${composerChipText('@officialDocs', 'mcp')}`,
    )
    expect(composerWireText(draft)).toBe('/goal $cook ask @officialDocs')
    expect(composerTextWithChips('nothing to draw', known)).toBe('nothing to draw')
    expect(composerTextWithChips(draft, known)).toBe(draft)
  })

  it('sends a prompt put back with its chips exactly as it was sent', () => {
    const known: KnownChipTokens = new Map([
      ['$cook', 'skill'],
      ['@officialDocs', 'mcp'],
    ])
    for (const sent of [
      '/taste-pro a website make something creative',
      '$cook... then more',
      'ask @officialDocs: (with $cook.)',
      '/goal: ship $cook.md',
    ]) {
      expect(composerWireText(composerTextWithChips(sent, known))).toBe(sent)
    }
  })
})
