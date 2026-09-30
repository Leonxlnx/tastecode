/** Streamdown's Suspense fallback has --sdm-c: inherit, but no Shiki dark colour. */
export function highlightedTokens(host: ParentNode): NodeListOf<HTMLSpanElement> {
  return host.querySelectorAll<HTMLSpanElement>(
    'code span[style*="--sdm-c:"][style*="--shiki-dark:"]',
  )
}
