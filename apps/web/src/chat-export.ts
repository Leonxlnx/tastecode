import type { Item } from '@harness/contracts'

/**
 * A chat as a portable Markdown document. Deliberately lossy: reasoning and
 * raw tool noise stay out, what the user said, what the agent answered, what
 * it ran and touched stay in — the parts someone would paste into an issue
 * or hand to a colleague.
 */
export function chatToMarkdown(title: string, items: Item[]): string {
  const lines: string[] = [`# ${title}`, '']
  for (const item of items) {
    if (item.type === 'message' && item.text?.trim()) {
      lines.push(item.role === 'user' ? '## You' : '## Assistant', '', item.text.trim(), '')
      continue
    }
    if (item.type === 'command' && item.command) {
      const exit =
        item.exitCode !== undefined && item.exitCode !== 0 ? ` # exit ${item.exitCode}` : ''
      lines.push('```shell', `$ ${item.command}${exit}`, '```', '')
      continue
    }
    if (item.type === 'file_change' && item.path) {
      const counts = [
        item.linesAdded ? `+${item.linesAdded}` : '',
        item.linesRemoved ? `-${item.linesRemoved}` : '',
      ]
        .filter(Boolean)
        .join(' ')
      lines.push(`> Edited \`${item.path}\`${counts ? ` (${counts})` : ''}`, '')
    }
  }
  return lines.join('\n')
}

export function exportFilename(title: string, now = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'chat'
  const stamp = now.toISOString().slice(0, 10)
  return `${slug}-${stamp}.md`
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
