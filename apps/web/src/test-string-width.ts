import { serialize } from 'node:v8'

const ONE_BYTE_STRING_TAG = 0x22

/** V8's serializer writes a string with the tag of its storage width. */
export function isOneByteString(value: string): boolean {
  const bytes = serialize(value)
  // Skip the version header and any alignment padding before the value tag.
  let offset = 2
  while (bytes[offset] === 0) offset++
  return bytes[offset] === ONE_BYTE_STRING_TAG
}

function isLatin1(value: string): boolean {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) > 0xff) return false
  return true
}

/**
 * Runs `scan` and counts grammar scans over text that holds only Latin-1 but is
 * stored two bytes wide, which puts every match on V8's slower path. Shiki's
 * JavaScript engine compiles every grammar rule with match indices (`d`); its
 * one-pass line split does not use them and is not counted.
 */
export async function countWideGrammarScans(
  scan: () => unknown,
): Promise<{ scans: number; wide: number }> {
  const exec = RegExp.prototype.exec
  const counts = { scans: 0, wide: 0 }
  // No regex may run in here: `test` and `match` would call this patched `exec`.
  RegExp.prototype.exec = function (this: RegExp, subject: string) {
    if (this.hasIndices) {
      counts.scans++
      if (isLatin1(subject) && !isOneByteString(subject)) counts.wide++
    }
    return exec.call(this, subject)
  }
  try {
    await scan()
  } finally {
    RegExp.prototype.exec = exec
  }
  return counts
}
