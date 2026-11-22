/**
 * Creatify: the composer's switch for creative work. A prompt sent with it on
 * carries CREATIFY_ATTACHMENT, which is no file. The server takes it off and
 * puts a note in front of the user's words that names the creative skills
 * shipped with TasteCode, so the agent applies the one that fits. No workflow
 * of TasteCode's own runs: the skill leads, in an ordinary turn.
 */
export const CREATIFY_ATTACHMENT = 'tastecode://creatify-v1'

export function isCreatifyAttachment(path: string): boolean {
  return path === CREATIFY_ATTACHMENT
}

/**
 * Opens and closes the note. Provider history takes the note off imported
 * prompts by these exact texts, so neither may change; write a new pair instead.
 */
export const CREATIFY_NOTE_OPEN = '<tastecode_creatify>\n'
export const CREATIFY_NOTE_REQUEST = '\n</tastecode_creatify>\n\nUser request:\n'

export type CreatifySkill = {
  name: string
  /** What the skill is for, in a few words; the agent chooses by it. */
  summary: string
  /** Absolute path of its SKILL.md. */
  file: string
}

/**
 * The note for one prompt, or '' when no skill is installed: then the prompt
 * goes as the user wrote it instead of pointing the agent at files that are
 * not there.
 */
export function creatifyNote(skills: readonly CreatifySkill[]): string {
  if (skills.length === 0) return ''
  return [
    `${CREATIFY_NOTE_OPEN}The user turned on Creatify for this request: it is creative work, where how the result looks, moves, sounds and feels matters as much as whether it works.`,
    'Before you start, choose the skill or skills below that fit the request and use them: load a skill by its name where your tools list it, otherwise read its SKILL.md in full and follow it.',
    ...skills.map(
      (skill) => `- ${skill.name}${skill.summary ? `: ${skill.summary}` : ''} (${skill.file})`,
    ),
    'Combine skills when the request spans them, such as a game demo that also needs sound. When none fits, ignore this note and do the request as usual.',
    `Decide open details yourself and say briefly what you chose. Ask the user only when the work cannot start without an answer.${CREATIFY_NOTE_REQUEST}`,
  ].join('\n')
}

/** The user's words of a prompt that carried the note; any other text as it is. */
export function withoutCreatifyNote(text: string): string {
  if (!text.startsWith(CREATIFY_NOTE_OPEN)) return text
  const request = text.indexOf(CREATIFY_NOTE_REQUEST)
  return request === -1 ? text : text.slice(request + CREATIFY_NOTE_REQUEST.length)
}
