import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./account-limits.css', import.meta.url), 'utf8')

describe('account limits layout', () => {
  it('keeps the limits section compact and readable', () => {
    const usage = css.match(/\.account-menu__usage \{(?<body>[\s\S]*?)\n\}/)?.groups?.['body']
    const reveal = css.match(/\.account-menu__usage-reveal \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    const details = css.match(/\.account-menu__usage-details \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]
    const separator = css.match(
      /\.account-menu__source \+ \.account-menu__source \{(?<body>[\s\S]*?)\n\}/,
    )?.groups?.['body']

    expect(usage).toContain('gap: 0')
    expect(usage).toContain('font-size: var(--t-xs)')
    expect(usage).toContain('padding: 0 0 3px')
    expect(reveal).toContain('order: -1')
    expect(reveal).toContain('grid-template-rows: 1fr')
    expect(reveal).toContain('grid-template-rows var(--dur-slow) var(--ease-out)')
    expect(reveal).toContain('opacity var(--dur-slow) var(--ease-out)')
    expect(css).toMatch(
      /\.account-menu__usage-reveal\[data-open='false'\] \{[^}]*grid-template-rows: 0fr;[^}]*opacity: 0;/s,
    )
    expect(css).toMatch(
      /@starting-style \{[\s\S]*?\.account-menu__usage-reveal \{[^}]*grid-template-rows: 0fr;[^}]*opacity: 0;/s,
    )
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.account-menu__usage-reveal \{[^}]*transition: opacity var\(--dur-fast\) var\(--ease-out\) !important;/s,
    )
    expect(details).toContain('max-height: min(340px, calc(100vh - 160px))')
    expect(details).toContain('overscroll-behavior: contain')
    expect(details).toContain('scrollbar-gutter: stable')
    expect(details).toContain('margin: 0 7px 3px')
    expect(details).toContain('padding: 6px 0 9px')
    expect(details).toContain('border-bottom: 1px solid var(--line-strong)')
    expect(separator).toContain('border-top: 1px solid var(--line-strong)')
    expect(separator).toContain('margin-top: 9px')
    expect(separator).toContain('padding-top: 9px')
    expect(css).toMatch(/\.account-menu__usage-head \{[^}]*min-height: 30px;/s)
    expect(css).toMatch(/\.account-menu__source \{[^}]*gap: 7px;/s)
    expect(css).toMatch(/\.account-menu__limit \{[^}]*gap: 4px;/s)
    expect(css).toMatch(/\.account-menu__limit-bar \{[^}]*height: 3px;/s)
  })
})
