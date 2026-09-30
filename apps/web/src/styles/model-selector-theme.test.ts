import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modelSelectorCss = [
  readFileSync(new URL('./model-selector.css', import.meta.url), 'utf8'),
  readFileSync(new URL('./model-selector-menu.css', import.meta.url), 'utf8'),
].join('\n')
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')
const modelSelectorSource = readFileSync(
  new URL('../ui/ModelSelector.tsx', import.meta.url),
  'utf8',
)

describe('model selector theme CSS', () => {
  it('keeps the sticky model header opaque in light mode', () => {
    expect(tokensCss).toMatch(
      /:root\[data-theme='light'\] \{[^}]*--model-picker-title-bg: var\(--model-picker-bg\);/s,
    )
    expect(modelSelectorCss).toMatch(
      /\.model-selector__search-head \{[^}]*position: sticky;[^}]*background: var\(--model-picker-title-bg\);/s,
    )
  })

  it('pins the search above the list edge in both layouts while models scroll', () => {
    expect(modelSelectorCss).toMatch(
      /\.model-selector__flat-head,\n\.model-selector__search-head \{[^}]*top: -4px;[^}]*padding: 4px 4px 3px;/s,
    )
  })

  it('slides one provider highlight instead of painting each rail button', () => {
    expect(modelSelectorCss).toMatch(
      /\.model-selector__provider\.is-active \{\s*color: var\(--text\);\s*\}/,
    )
    expect(modelSelectorCss).toMatch(
      /\.model-selector__provider-highlight \{[^}]*transform: translateY\(calc\(var\(--model-selector-provider-index\) \* 34px\)\);[^}]*transition: transform var\(--dur-fast\) var\(--ease-out\);/s,
    )
  })

  it('uses the shared control motion for provider selection', () => {
    expect(modelSelectorCss).toMatch(
      /\.model-selector__provider \{[^}]*transition:[^}]*background var\(--dur-fast\) var\(--ease-out\),[^}]*box-shadow var\(--dur-fast\) var\(--ease-out\),[^}]*color var\(--dur-fast\) var\(--ease-out\);/s,
    )
    expect(modelSelectorCss).not.toContain('model-provider-pop')
  })

  it('aligns the picker right edge with its trigger', () => {
    const menu = modelSelectorCss.match(/\.model-selector__menu \{(?<body>[\s\S]*?)\n\}/)?.groups?.[
      'body'
    ]

    expect(modelSelectorSource).toMatch(/<Menu\s+align="right"/)
    expect(menu).not.toContain('translate:')
    expect(menu).not.toContain('transform:')
  })
})
