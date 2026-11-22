/**
 * Creatify: the composer's switch for creative work. A prompt sent with it on
 * carries this marker among its attachments. It is no file: the server takes
 * it off and points the agent at the creative skills that ship with TasteCode
 * (apps/server/src/creatify.ts knows the same text).
 */
export const CREATIFY_ATTACHMENT = 'tastecode://creatify-v1'

export function withCreatify(attachments: string[]): string[] {
  return [...attachments.filter((path) => path !== CREATIFY_ATTACHMENT), CREATIFY_ATTACHMENT]
}
