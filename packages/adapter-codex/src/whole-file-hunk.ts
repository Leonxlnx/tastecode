/** A created or deleted file, which Codex records as its whole content, as one hunk. */
export function wholeFileHunk(kind: 'add' | 'delete', content: string): string {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length) return ''
  return kind === 'add'
    ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
    : `@@ -1,${lines.length} +0,0 @@\n${lines.map((line) => `-${line}`).join('\n')}\n`
}
