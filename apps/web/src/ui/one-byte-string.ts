const CHUNK = 8_192

/**
 * Returns `text` as a one-byte V8 string when every character fits in Latin-1,
 * otherwise `text` itself.
 *
 * A substring keeps the width of the string it was cut from, so one em dash
 * anywhere in a reply or patch makes every line cut from it two-byte, and V8
 * runs regular expressions over two-byte strings on a slower path.
 * `String.fromCharCode` builds a one-byte string whenever every code fits.
 */
export function oneByteString(text: string): string {
  const codes: number[] = []
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code > 0xff) return text
    codes.push(code)
  }
  if (codes.length <= CHUNK) return String.fromCharCode.apply(null, codes)
  let copy = ''
  for (let start = 0; start < codes.length; start += CHUNK) {
    copy += String.fromCharCode.apply(null, codes.slice(start, start + CHUNK))
  }
  return copy
}
