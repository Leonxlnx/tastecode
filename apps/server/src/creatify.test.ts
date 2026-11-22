import { describe, expect, it } from 'vitest'
import {
  CREATIFY_ATTACHMENT,
  CREATIFY_NOTE_OPEN,
  CREATIFY_NOTE_REQUEST,
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
    expect(note.endsWith(CREATIFY_NOTE_REQUEST)).toBe(true)
    expect(note).toContain('\n- cinetic: motion design made in code (/skills/cinetic/SKILL.md)\n')
    expect(note).toContain('\n- plain (/skills/plain/SKILL.md)\n')
  })

  it('writes no note when no skill is installed', () => {
    expect(creatifyNote([])).toBe('')
  })

  it('takes the note off a prompt and leaves any other text alone', () => {
    const words = 'Build a pricing page.\n\nUser request:\nis part of what I wrote.'

    expect(withoutCreatifyNote(`${creatifyNote(SKILLS)}${words}`)).toBe(words)
    expect(withoutCreatifyNote(words)).toBe(words)
    // Opened but never closed is not our note; nothing is cut.
    expect(withoutCreatifyNote(`${CREATIFY_NOTE_OPEN}${words}`)).toBe(
      `${CREATIFY_NOTE_OPEN}${words}`,
    )
  })
})
