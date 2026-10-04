import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../ui/Composer.tsx', import.meta.url), 'utf8')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (
    appCss.match(new RegExp(`^${escaped} \\{(?<body>[\\s\\S]*?)\\n\\}`, 'm'))?.groups?.['body'] ??
    ''
  )
}

describe('composer queue motion', () => {
  it('reveals the panel from the composer edge and keeps row motion compositor-safe', () => {
    const panel = rule('.composer__queue')
    const row = rule('.queue-row')

    expect(panel).toContain(
      'animation: composer-queue-panel-in var(--dur-slow) var(--ease-rail) both;',
    )
    expect(appCss).toMatch(
      /@keyframes composer-queue-panel-in \{[\s\S]*?clip-path: inset\(100% 0 0\);[\s\S]*?opacity: 0;[\s\S]*?clip-path: inset\(0 0 0\);[\s\S]*?opacity: 1;/,
    )
    expect(row).toContain('will-change: transform, opacity;')
    expect(row).toContain('opacity var(--dur-fast) var(--ease-out)')
    expect(row).toContain('transform var(--dur-press) var(--ease-out)')
    expect(appCss).toMatch(
      /\.queue-row\[data-queue-phase='entering'\] \{[\s\S]*?composer-queue-item-in var\(--dur-slow\) var\(--ease-in-out\)/,
    )
    expect(appCss).toMatch(
      /\.queue-row\[data-queue-phase='exiting'\] \{[\s\S]*?composer-queue-item-out var\(--dur-fast\) var\(--ease-out\)/,
    )
    expect(appCss).toContain(".queue-row[data-queue-phase='exiting'][data-queue-positioned]")
    expect(appCss).toContain(
      '@keyframes composer-queue-item-in {\n  from {\n    opacity: 0;\n  }\n}',
    )
    expect(appCss).toContain(
      '@keyframes composer-queue-item-out {\n  to {\n    opacity: 0;\n  }\n}',
    )
  })

  it('keeps queued rows compact', () => {
    const panel = rule('.composer__queue')
    const row = rule('.queue-row')
    const media = rule('.queue-row__media')
    const handle = rule('.queue-row__handle')
    const text = rule('.queue-row__text')
    const steer = rule('.queue-row__steer')
    const action = rule('.queue-row__action')

    expect(panel).toContain('padding: 3px 7px 7px;')
    expect(row).toContain('gap: 7px;')
    expect(row).toContain('min-height: 22px;')
    expect(row).toContain('padding: 0 5px;')
    expect(handle).toContain('width: 22px;')
    expect(media).toContain('width: 22px;')
    expect(media).toContain('height: 22px;')
    expect(text).toContain('font-size: var(--t-xs);')
    expect(text).toContain('line-height: 1.1;')
    expect(steer).toContain('font-size: var(--t-xs);')
    expect(steer).toContain('line-height: 1.1;')
    expect(steer).toContain('gap: 5px;')
    expect(steer).toContain('padding: 0 7px;')
    expect(action).toContain('height: 22px;')
    expect(appCss).toMatch(/\.queue-row__action \{[\s\S]*?width: 24px;[\s\S]*?padding: 0;/)
    expect(appCss).toMatch(
      /\.queue-row > \.menuwrap \.queue-row__action \{[\s\S]*?width: 24px;[\s\S]*?height: 22px;/,
    )
    expect(composerSource).toContain('<GripVertical size={12} aria-hidden />')
    expect(composerSource).toContain('<CornerDownRight size={12} aria-hidden />')
    expect(composerSource).toContain('<Pencil size={12} aria-hidden />')
    expect(composerSource).toContain('<Trash2 size={12} aria-hidden />')
    expect(composerSource).toContain('<Video size={12} /> : <ImageIcon size={12} />')
    expect(composerSource).toContain('<Play size={7} fill="currentColor" />')
  })

  it('keeps only finite opacity feedback when reduced motion is requested', () => {
    expect(appCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.composer__queue \{[\s\S]*?animation: fade-in[\s\S]*?\.queue-row\[data-queue-phase='entering'\] \{[\s\S]*?composer-queue-item-fade-in[\s\S]*?\.queue-row\[data-queue-phase='exiting'\] \{[\s\S]*?composer-queue-item-fade-out[\s\S]*?\.queue-row\.is-dragging \{[\s\S]*?transform: none;/s,
    )
  })
})
