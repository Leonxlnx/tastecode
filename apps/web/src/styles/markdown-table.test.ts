import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const markdownCss = readFileSync(new URL('./markdown.css', import.meta.url), 'utf8')

const CONTROLS = String.raw`\.md \[data-streamdown='table-wrapper'\] > div:first-child:not\(:last-child\)`

/** The body of the first rule whose selector is exactly `selector` (a regex source). */
function rule(selector: string): string {
  return new RegExp(`(?:^|\\n)${selector} \\{([\\s\\S]*?)\\n\\}`).exec(markdownCss)?.[1] ?? ''
}

describe('markdown tables', () => {
  it('open with a code-block-style "table" label row instead of an empty toolbar row', () => {
    // The label is the wrapper's own first line, so the live table, whose
    // controls row is empty while it streams, has the same 32px row.
    const label = rule(String.raw`\.md \[data-streamdown='table-wrapper'\]::before`)
    expect(label).toContain("content: 'table';")
    expect(label).toContain('display: block;')
    expect(label).toContain('height: 32px;')
    expect(label).toContain('line-height: 32px;')
    expect(label).toContain('font-family: var(--font-mono);')
    expect(label).toContain('color: var(--text-3);')
    expect(markdownCss).not.toContain('min-height: 26px')
  })

  it('lifts the actions onto the label row and fades them in as a whole', () => {
    const controls = rule(CONTROLS)
    expect(controls).toMatch(/^\s*position: absolute;\s*top: 2px;\s*right: -6\.5px;/)
    expect(controls).toContain('opacity: 0;')
    expect(controls).toContain('transition: opacity var(--dur-hover) var(--ease-out);')
    expect(markdownCss).toMatch(
      new RegExp(
        String.raw`\[data-streamdown='table-wrapper'\]:is\(:hover, :focus-within\)\s*> div:first-child:not\(:last-child\) \{\s*opacity: 1;`,
      ),
    )
    expect(markdownCss).toMatch(
      new RegExp(String.raw`@media \(hover: none\) \{\s*${CONTROLS} \{\s*opacity: 1;`),
    )
  })

  it('draws the actions as the same ghost buttons as a code block', () => {
    const controls = rule(CONTROLS)
    const button = /> button,\s*> div > button \{([\s\S]*?)\n {4}svg/.exec(controls)?.[1] ?? ''
    expect(button).toMatch(/width: 28px;\s*height: 28px;/)
    expect(button).toContain('background: transparent;')
    expect(button).toContain('border: 0;')
    expect(button).not.toContain('opacity')
    expect(button).toMatch(
      /&:hover,\s*&:focus-visible \{\s*background: var\(--surface\);\s*color: var\(--text-2\);/,
    )
    expect(controls).toMatch(/svg \{\s*width: 15px;\s*height: 15px;\s*stroke-width: 1\.7;/)
  })

  it('sets the copy and download menus in the app font', () => {
    expect(rule(CONTROLS)).toMatch(/> div > div \{[\s\S]*?button \{[^}]*font: inherit;/)
  })

  it('puts the table in a rounded card that scrolls inside its edge', () => {
    const card = rule(String.raw`\.md \[data-streamdown='table-wrapper'\] > div:last-child`)
    expect(card).toContain('overflow-x: auto;')
    expect(card).toContain('border: 1px solid var(--line);')
    expect(card).toContain('border-radius: var(--r-lg);')
  })

  it('draws only inner cell lines inside the card', () => {
    expect(rule(String.raw`\.md \[data-streamdown='table-wrapper'\] :is\(th, td\)`)).toMatch(
      /border: 0;\s*border-bottom: 1px solid var\(--line\);/,
    )
    expect(
      rule(String.raw`\.md \[data-streamdown='table-wrapper'\] :is\(th, td\):not\(:first-child\)`),
    ).toContain('border-left: 1px solid var(--line);')
    expect(
      rule(
        String.raw`\.md \[data-streamdown='table-wrapper'\] table > :last-child > tr:last-child > :is\(th, td\)`,
      ),
    ).toContain('border-bottom: 0;')
  })
})
