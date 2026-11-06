import { describe, expect, it, vi } from 'vitest'
import { newBrowserCommentId } from './browser-comments.js'
import {
  browserCommentChipText,
  composerChipAround,
  composerChipFragments,
  composerChips,
  composerChipSegments,
  composerChipText,
  composerChipTokens,
  composerChipTouching,
  composerSelectionOverChips,
  composerTextWithoutPicks,
  composerWireText,
  createComposerChipTextStore,
  hasComposerChips,
  repairComposerChips,
} from './composer-chips.js'

const cook = composerChipText('$cook', 'skill')
const goal = composerChipText('/goal', 'command')
const docs = composerChipText('@officialDocs', 'mcp')
const design = composerChipText('/design-taste-frontend', 'skill')

describe('composer chips', () => {
  it('sends every chip as the token it stands for and nothing else', () => {
    const draft = `${goal} ${cook} ${design} use ${docs} for the landing page`

    expect(composerWireText(draft)).toBe(
      '/goal $cook /design-taste-frontend use @officialDocs for the landing page',
    )
    expect(composerWireText('plain text, $HOME and /usr/bin stay')).toBe(
      'plain text, $HOME and /usr/bin stay',
    )
  })

  it('keeps a token apart from a word or a chip drawn right against it', () => {
    // The space after a pick deleted and typing went on, or text typed before a chip.
    expect(composerWireText(`${cook}x`)).toBe('$cook x')
    expect(composerWireText(`use${cook}`)).toBe('use $cook')
    expect(composerWireText(`${goal}${cook}${docs}`)).toBe('/goal $cook @officialDocs')
    expect(composerWireText(`${cook}.md`)).toBe('$cook .md')
    expect(composerWireText(`${cook}-based`)).toBe('$cook -based')
  })

  it('lets brackets, quotes and closing punctuation touch a token', () => {
    expect(composerWireText(`(${cook}), "${docs}"`)).toBe('($cook), "@officialDocs"')
    expect(composerWireText(`try ${cook}. Then ${docs}: done`)).toBe(
      'try $cook. Then @officialDocs: done',
    )
    expect(composerWireText(`end ${cook}.`)).toBe('end $cook.')
    expect(composerWireText(`${cook}!`)).toBe('$cook!')
    // Dots and colons before closing punctuation or the end still end the name.
    expect(composerWireText(`wait for ${cook}...`)).toBe('wait for $cook...')
    expect(composerWireText(`(with ${cook}.)`)).toBe('(with $cook.)')
    expect(composerWireText(`use ${docs}:`)).toBe('use @officialDocs:')
    expect(composerWireText(`${cook}.:x`)).toBe('$cook .:x')
  })

  it('keeps chip names to one token and leaves a name it cannot hold as plain text', () => {
    expect(hasComposerChips(cook)).toBe(true)
    expect(composerChipText('$two words', 'skill')).toBe('$two words')
    expect(composerChipText('@cook', 'skill')).toBe('@cook')
    expect(hasComposerChips('no chips here')).toBe(false)
  })

  it('reads each chip with its kind, marker, name and place in the draft', () => {
    const draft = `${goal} fix ${cook}`

    expect(composerChips(draft)).toEqual([
      { kind: 'command', marker: '/', name: 'goal', token: '/goal', start: 0, end: goal.length },
      {
        kind: 'skill',
        marker: '$',
        name: 'cook',
        token: '$cook',
        start: goal.length + 5,
        end: draft.length,
      },
    ])
    expect(composerChips(design)[0]).toMatchObject({ kind: 'skill', marker: '/' })
    expect(composerChipTokens(draft)).toEqual(new Set(['/goal', '$cook']))
  })

  it('splits a draft into text and chips in order', () => {
    const segments = composerChipSegments(`a ${cook} b`)

    expect(segments.map((segment) => segment.type)).toEqual(['text', 'chip', 'text'])
    expect(segments[0]).toEqual({ type: 'text', text: 'a ' })
    expect(segments[2]).toEqual({ type: 'text', text: ' b' })
  })

  it('finds the chip a caret falls inside, ends at or starts at', () => {
    const draft = `x ${cook} y`
    const start = 2
    const end = 2 + cook.length

    expect(composerChipAround(draft, start)).toBeUndefined()
    expect(composerChipAround(draft, start + 1)?.token).toBe('$cook')
    expect(composerChipAround(draft, end)).toBeUndefined()
    expect(composerChipTouching(draft, end, 'before')?.token).toBe('$cook')
    expect(composerChipTouching(draft, start, 'after')?.token).toBe('$cook')
    expect(composerChipTouching(draft, start, 'before')).toBeUndefined()
  })

  it('widens a selection that cuts through a chip to the whole chip', () => {
    const draft = `x ${cook} y`
    const end = 2 + cook.length

    expect(composerSelectionOverChips(draft, 0, 5)).toEqual([0, end])
    expect(composerSelectionOverChips(draft, 4, draft.length)).toEqual([2, draft.length])
    expect(composerSelectionOverChips(draft, 0, 1)).toEqual([0, 1])
  })

  it('removes what an edit left of a chip and moves the caret with it', () => {
    // A selection from the text into the chip's marks, replaced by "Z".
    const broken = `xZ${cook.slice(3)} y`

    expect(repairComposerChips(broken, 2)).toEqual({ text: 'xZcook y', caret: 2 })
    expect(repairComposerChips(`a ${cook} b`, 3)).toBeUndefined()
    expect(repairComposerChips('plain', 2)).toBeUndefined()
    // A chip whose name was deleted: its marks go, the caret stays before "b".
    expect(repairComposerChips('a  ⁠⁡⁠ b', 7)).toEqual({ text: 'a  b', caret: 3 })
  })

  it('finds what an edit left of a cut chip, with touching leftovers as one range', () => {
    expect(composerChipFragments(`xZ${cook.slice(3)} y`)).toEqual([[6, 7]])
    // An opener and its mark touch; the whole chip after them is no leftover.
    expect(composerChipFragments(`${cook.slice(0, 3)}x ${cook}`)).toEqual([[0, 3]])
    expect(composerChipFragments(`a ${cook} b`)).toEqual([])
    expect(composerChipFragments('plain')).toEqual([])
  })

  it('drops skill and server chips with the space after them and keeps commands', () => {
    expect(composerTextWithoutPicks(`${goal} ${cook} use ${docs} now ${design}`)).toBe(
      `${goal} use now `,
    )
    expect(composerTextWithoutPicks(`${goal} only`)).toBe(`${goal} only`)
    expect(composerTextWithoutPicks('plain $cook text')).toBe('plain $cook text')
  })

  it('keeps browser comment chips, which belong to a page and not to a provider', () => {
    const comment = browserCommentChipText({ id: newBrowserCommentId(), comment: 'Smaller' })
    expect(composerTextWithoutPicks(`${cook} ${comment} tail`)).toBe(`${comment} tail`)
  })

  it('only wakes the overlay while the draft has chips', () => {
    const store = createComposerChipTextStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.set('typing')
    store.set('typing more')
    expect(listener).not.toHaveBeenCalled()
    expect(store.get()).toBe('')

    store.set(`${cook} go`)
    expect(listener).toHaveBeenCalledOnce()
    expect(store.get()).toBe(`${cook} go`)

    store.set('cleared')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get()).toBe('')
  })
})
