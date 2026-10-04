const PULL_REQUEST_TEXT_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

export function comparePullRequestText(left: string, right: string): number {
  return PULL_REQUEST_TEXT_COLLATOR.compare(left, right)
}

export function countLabel(count: number, noun: string, plural = `${noun}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : plural}`
}
