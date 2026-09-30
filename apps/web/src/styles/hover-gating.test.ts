import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const inboxCss = readFileSync(new URL('./inbox-sidebar.css', import.meta.url), 'utf8')
const threadCss = readFileSync(new URL('./thread.css', import.meta.url), 'utf8')

describe('hover gating', () => {
  it('keeps hover-only motion on precise pointers', () => {
    expect((appCss.match(/\.sessrow:hover \.sess__actions/g) ?? []).length).toBe(1)
    expect(
      (
        appCss.match(
          /\.sessrow:hover \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\)/g,
        ) ?? []
      ).length,
    ).toBe(1)
    expect((appCss.match(/\.proj__head:hover \.dots/g) ?? []).length).toBe(1)
    expect((appCss.match(/\.menutrigger:hover \.dots/g) ?? []).length).toBe(1)
    expect(
      (inboxCss.match(/\.thread-card\.has-actions:hover \.thread-card__actions/g) ?? []).length,
    ).toBe(1)
    expect((inboxCss.match(/\.thread-row:hover \.thread-row__action/g) ?? []).length).toBe(1)
    expect((threadCss.match(/\.said:hover > \.said__actions/g) ?? []).length).toBe(1)
    expect(appCss).not.toMatch(
      /\.sessrow:hover \.sess__actions,\s*\.sessrow:focus-within \.sess__actions/s,
    )
    expect(appCss).not.toMatch(
      /\.sessrow:hover \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\),\s*\.sessrow:focus-within/s,
    )
    expect(appCss).not.toContain('@media (hover: none) and (pointer: coarse)')
    expect(appCss).toMatch(/\.sessrow:focus-within \.sess__actions \{[^}]*pointer-events: auto;/s)
    expect(appCss).toMatch(
      /\.sessrow:focus-within \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\) \{[^}]*opacity: 0;/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.sessrow:hover \.sess__actions,[\s\S]*?\.proj__head:hover \.dots \{/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.sessrow:hover \.sess__source :is\(\.source-identity__label, \.source-identity__qualifier\) \{/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.menutrigger:hover \.dots \{/s,
    )
    expect(appCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.composer__design:hover > span \{/s,
    )
    expect(inboxCss).toMatch(
      /\.thread-card\.has-actions:focus-within \.thread-card__actions,[^{]*\{[^}]*pointer-events: auto;/s,
    )
    expect(inboxCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.thread-card\.has-actions:hover \.thread-card__actions/s,
    )
    expect(inboxCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.thread-row:hover \.thread-row__action/s,
    )
    expect(threadCss).toMatch(/\.said:focus-within > \.said__actions \{[^}]*pointer-events: auto;/s)
    expect(threadCss).toMatch(
      /@media \(hover: hover\) and \(pointer: fine\) \{[\s\S]*?\.said:hover > \.said__actions \{/s,
    )
  })
})
