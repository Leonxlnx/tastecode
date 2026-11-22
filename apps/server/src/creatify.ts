/**
 * Creatify: the composer's switch for creative work. A prompt sent with it on
 * carries CREATIFY_ATTACHMENT, which is no file. The server takes it off and
 * puts a note behind the user's words that names the creative skills shipped
 * with TasteCode, so the agent applies the one that fits. No workflow of
 * TasteCode's own runs: the skill leads, in an ordinary turn.
 *
 * The note follows the words instead of leading them because a provider names
 * a session after the start of its first prompt: in front, the user's own
 * Codex or Claude Code history would list the chat under the note's opening.
 */
export const CREATIFY_ATTACHMENT = 'tastecode://creatify-v1'

export function isCreatifyAttachment(path: string): boolean {
  return path === CREATIFY_ATTACHMENT
}

/**
 * Opens and closes the note. Provider history takes the note off imported
 * prompts by these exact texts, so neither may change; write a new pair instead.
 */
export const CREATIFY_NOTE_OPEN = '\n\n<tastecode_creatify>\nCreatify is on for the request above: '
export const CREATIFY_NOTE_CLOSE = '\n</tastecode_creatify>'

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
 * not there. A skill of the user's own may share a bundled one's name, so the
 * note names each file.
 */
export function creatifyNote(skills: readonly CreatifySkill[]): string {
  if (skills.length === 0) return ''
  return [
    `${CREATIFY_NOTE_OPEN}it is creative work, where how the result looks, moves, sounds and feels matters as much as whether it works.`,
    "Before you start, choose the skill or skills below that fit the request and use them. They ship with TasteCode: load one through your skill tool where it lists TasteCode's skills, otherwise read its SKILL.md in full and follow it.",
    ...skills.map(
      (skill) => `- ${skill.name}${skill.summary ? `: ${skill.summary}` : ''} (${skill.file})`,
    ),
    'Combine skills when the request spans them, such as a game demo that also needs sound. When none fits, ignore this note and do the request as usual.',
    `Decide open details yourself and say briefly what you chose. Ask the user only when the work cannot start without an answer.${CREATIFY_NOTE_CLOSE}`,
  ].join('\n')
}

/** The user's words of a prompt that carried the note; any other text as it is. */
export function withoutCreatifyNote(text: string): string {
  if (!text.trimEnd().endsWith(CREATIFY_NOTE_CLOSE)) return text
  const open = text.lastIndexOf(CREATIFY_NOTE_OPEN)
  return open === -1 ? text : text.slice(0, open)
}
