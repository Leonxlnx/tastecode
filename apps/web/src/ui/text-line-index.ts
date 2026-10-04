const INITIAL_LINE_CAPACITY = 64

export function indexTextLines(text: string): Uint32Array {
  let starts = new Uint32Array(INITIAL_LINE_CAPACITY)
  let count = 1
  let position = 0

  while ((position = text.indexOf('\n', position)) !== -1) {
    if (count === starts.length) {
      const grown = new Uint32Array(starts.length * 2)
      grown.set(starts)
      starts = grown
    }
    starts[count] = position + 1
    count += 1
    position += 1
  }

  return count === starts.length ? starts : starts.slice(0, count)
}

export function indexedTextLine(text: string, starts: Uint32Array, index: number): string {
  const start = starts[index]
  if (start === undefined) return ''
  const next = starts[index + 1]
  return text.slice(start, next === undefined ? text.length : next - 1)
}
