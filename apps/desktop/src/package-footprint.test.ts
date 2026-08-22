import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const desktopPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  build?: { electronLanguages?: unknown; files?: unknown }
}

describe('packaged Electron footprint', () => {
  it('ships only the locale used by the English product UI', () => {
    expect(desktopPackage.build?.electronLanguages).toEqual(['en-US'])
  })

  it('does not bundle Claude SDK executables that the external CLI path never uses', () => {
    expect(desktopPackage.build?.files).toContain(
      '!node_modules/@anthropic-ai/claude-agent-sdk-*{,/**/*}',
    )
  })
})
