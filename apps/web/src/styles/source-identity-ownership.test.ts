import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const owner = readFileSync(new URL('../ui/SourceIdentity.tsx', import.meta.url), 'utf8')
const inbox = readFileSync(new URL('./inbox-sidebar.css', import.meta.url), 'utf8')
const shared = readFileSync(new URL('./source-identity.css', import.meta.url), 'utf8')

describe('source identity style ownership', () => {
  it('loads provider mark alignment with the shared identity component', () => {
    expect(owner).toContain("import '../styles/source-identity.css'")
    expect(inbox).not.toContain('.source-identity')
    expect(shared).toMatch(/\.source-identity \{[^}]*display: inline-flex;[^}]*gap: 5px;/s)
    expect(shared).toMatch(/\.source-identity__mark \{[^}]*place-items: center;/s)
    expect(shared).toMatch(/\.source-identity__mark > svg \{[^}]*display: block;/s)
    expect(shared).toMatch(/\.source-identity--compact \{[^}]*gap: 3px;/s)
  })
})
