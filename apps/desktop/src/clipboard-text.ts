/**
 * Large enough for complete long-context prompts and responses while keeping
 * the renderer-to-main IPC payload bounded.
 */
export const MAX_CLIPBOARD_TEXT_LENGTH = 8 * 1024 * 1024

export function clipboardText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    throw new Error('Invalid clipboard text')
  }
  return value
}
