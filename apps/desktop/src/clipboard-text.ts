/**
 * Large enough for complete long-context prompts and responses while keeping
 * the renderer-to-main IPC payload bounded.
 */
export const MAX_CLIPBOARD_TEXT_BYTES = 8 * 1024 * 1024

const ClipboardTextSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_CLIPBOARD_TEXT_BYTES)

export function clipboardText(value: BoundaryValue): string {
  const parsed = ClipboardTextSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Invalid clipboard text')
  }
  return parsed.data
}
import { z } from 'zod'
import type { BoundaryValue } from './boundary.js'
