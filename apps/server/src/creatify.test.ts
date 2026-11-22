import { describe, expect, it } from 'vitest'
import {
  CREATIFY_ATTACHMENT,
  CREATIFY_NOTE_CLOSE,
  CREATIFY_NOTE_OPEN,
  creatifyNote,
  isCreatifyAttachment,
  withoutCreatifyNote,
} from './creatify.js'

const SKILLS = [
  { name: 'cinetic', summary: 'motion design made in code', file: '/skills/cinetic/SKILL.md' },
  { name: 'plain', summary: '', file: '/skills/plain/SKILL.md' },
]

describe('Creatify', () => {
  it('knows its own marker and nothing else', () => {
    expect(isCreatifyAttachment(CREATIFY_ATTACHMENT)).toBe(true)
    expect(isCreatifyAttachment('tastecode://design-brief-v1')).toBe(false)
    expect(isCreatifyAttachment('/work/creatify-v1.png')).toBe(false)
  })

  it('names every skill with its file, between the markers history looks for', () => {
    const note = creatifyNote(SKILLS)

    expect(note.startsWith(CREATIFY_NOTE_OPEN)).toBe(true)
    expect(note.endsWith(CREATIFY_NOTE_CLOSE)).toBe(true)
    expect(note).toContain('\n- cinetic: motion design made in code (/skills/cinetic/SKILL.md)\n')
    expect(note).toContain('\n- plain (/skills/plain/SKILL.md)\n')
  })

  it('writes no note when no skill is installed', () => {
    expect(creatifyNote([])).toBe('')
  })

  it('takes the note off the end of a prompt', () => {
    const words = 'Build a pricing page.\n\nUser request:\nis part of what I wrote.'
    const note = creatifyNote(SKILLS)

    expect(withoutCreatifyNote(`${words}${note}`)).toBe(words)
    // A provider may store the prompt with a line break after it.
    expect(withoutCreatifyNote(`${words}${note}\n`)).toBe(words)
  })

  it('leaves text alone that only looks like the note', () => {
    const words = 'Build a pricing page.'
    const note = creatifyNote(SKILLS)

    expect(withoutCreatifyNote(words)).toBe(words)
    // Quoted in the middle of a prompt, it is the user's own text.
    expect(withoutCreatifyNote(`${words}${note}\nWhat does this note do?`)).toBe(
      `${words}${note}\nWhat does this note do?`,
    )
    // A closing tag without the note's opening is not ours either.
    expect(withoutCreatifyNote(`<tastecode_creatify>\nmy example${CREATIFY_NOTE_CLOSE}`)).toBe(
      `<tastecode_creatify>\nmy example${CREATIFY_NOTE_CLOSE}`,
    )
  })
})
