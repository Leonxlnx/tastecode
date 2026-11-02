import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FilePartInput, TextPartInput } from '@opencode-ai/sdk'

const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.pdf', 'application/pdf'],
])

/**
 * The parts of a v1 prompt: the text, then each attachment as a file part
 * with a `file:` URL. opencode reads such a part on its own side; an image or
 * PDF becomes a `data:` part the model receives as pixels, and any other file
 * goes through its Read tool, which is why other files are sent as
 * `text/plain` (opencode 1.18.13: the `case"file:"` branch of its prompt
 * builder).
 */
export function openCodePromptParts(
  text: string,
  attachments: readonly string[],
): Array<TextPartInput | FilePartInput> {
  return [
    { type: 'text', text },
    ...attachments.map((file): FilePartInput => ({
      type: 'file',
      mime: MIME_TYPES.get(path.extname(file).toLowerCase()) ?? 'text/plain',
      filename: path.basename(file),
      url: pathToFileURL(file).href,
    })),
  ]
}

/**
 * The `files` of a v2 prompt, typed after the SDK's `PromptInputFileAttachment`
 * ({ uri, name }); no v2 server with a model catalog was available to capture.
 */
export function openCodeV2Files(attachments: readonly string[]) {
  if (attachments.length === 0) return {}
  return {
    files: attachments.map((file) => ({
      uri: pathToFileURL(file).href,
      name: path.basename(file),
    })),
  }
}
