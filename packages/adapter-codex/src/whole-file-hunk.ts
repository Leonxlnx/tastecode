/** A created or deleted file, which Codex records as its whole content, as one hunk. */
export function wholeFileHunk(kind: 'add' | 'delete', content: string): string {
  const lines = content.split('\n')
  const newlineAtEnd = lines.at(-1) === ''
  if (newlineAtEnd) lines.pop()
  if (!lines.length) return ''
  // Without the marker Git expects a final newline, and Undo would fail.
  const end = newlineAtEnd ? '' : '\\ No newline at end of file\n'
  return kind === 'add'
    ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${end}`
    : `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}\n${end}`
}
