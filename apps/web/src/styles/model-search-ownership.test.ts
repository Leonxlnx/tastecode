import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const owner = readFileSync(new URL('../ui/ModelSearchField.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./settings.css', import.meta.url), 'utf8')
const shared = readFileSync(new URL('./model-search.css', import.meta.url), 'utf8')

describe('model search ownership', () => {
  it('keeps shared model-search styles with the shared field component', () => {
    expect(owner).toContain("import '../styles/model-search.css'")
    expect(settings).not.toContain('.model-search')
    expect(shared).toMatch(/\.model-search input \{[^}]*appearance: none;/s)
    expect(shared).toMatch(/\.model-search input \{[^}]*border: 0;[^}]*outline: none;/s)
    expect(shared).toMatch(/\.model-search:focus-within \{[^}]*box-shadow:/s)
  })
})
