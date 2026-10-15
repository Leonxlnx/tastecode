/** Streamdown's Suspense fallback has --sdm-c: inherit, but no Shiki dark colour. */
export function highlightedTokens(host: ParentNode): NodeListOf<HTMLSpanElement> {
  return host.querySelectorAll<HTMLSpanElement>(
    'code span[style*="--sdm-c:"][style*="--shiki-dark:"]',
  )
}

export function highlightingReady(host: ParentNode, blockCount: number): boolean {
  const blocks = [...host.querySelectorAll('pre code')]
  return (
    blocks.length === blockCount &&
    !host.querySelector('[data-highlight-pending="true"]') &&
    blocks.every((block) => highlightedTokens(block).length > 0)
  )
}
