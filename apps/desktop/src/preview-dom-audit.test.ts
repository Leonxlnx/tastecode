import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PreviewDomAuditSchema } from '@harness/contracts'
import { PREVIEW_DOM_AUDIT_SCRIPT } from './preview-dom-audit.js'

type ElementFixture = {
  id?: string
  label?: string
  labelledBy?: string
  associatedLabel?: string
  kind?: 'button' | 'menuitem'
  width: number
  height: number
  left?: number
  top?: number
  disabled?: boolean
  hiddenByAncestor?: boolean
}

function runAudit(
  h1Count: number,
  fixtures: ElementFixture[],
  referencedLabels: Record<string, string> = {},
) {
  const elements = fixtures.map((fixture) => ({
    id: fixture.id ?? '',
    localName: 'button',
    parentElement: undefined,
    labels: fixture.associatedLabel ? [{ textContent: fixture.associatedLabel }] : [],
    textContent: fixture.label ?? '',
    getAttribute(name: string) {
      if (name === 'aria-label') return fixture.label ?? null
      if (name === 'aria-labelledby') return fixture.labelledBy ?? null
      return null
    },
    getBoundingClientRect() {
      const left = fixture.left ?? 0
      const top = fixture.top ?? 0
      return {
        width: fixture.width,
        height: fixture.height,
        left,
        right: left + fixture.width,
        top,
        bottom: top + fixture.height,
      }
    },
    checkVisibility() {
      return !fixture.hiddenByAncestor
    },
    matches(selector: string) {
      return Boolean(fixture.disabled && selector.includes(':disabled'))
    },
    fixture,
  }))
  const result = vm.runInNewContext(PREVIEW_DOM_AUDIT_SCRIPT, {
    CSS: { escape: (value: string) => value },
    Number,
    Math,
    Array,
    innerWidth: 390,
    innerHeight: 844,
    document: {
      querySelectorAll: (selector: string) =>
        selector === 'h1'
          ? Array.from({ length: h1Count })
          : elements.filter(
              (element) =>
                element.fixture.kind !== 'menuitem' || selector.includes('[role="menuitem"]'),
            ),
      getElementById: (id: string) =>
        referencedLabels[id] ? { textContent: referencedLabels[id] } : null,
    },
    getComputedStyle: () => ({
      display: 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
    }),
  })
  return PreviewDomAuditSchema.parse(result)
}

describe('preview DOM audit', () => {
  it('reports visible undersized targets across the whole document', () => {
    expect(
      runAudit(0, [
        { id: 'small', label: 'Open menu', width: 32, height: 40 },
        { id: 'large', width: 44, height: 44 },
        { id: 'disabled', width: 20, height: 20, disabled: true },
        { id: 'hidden', width: 20, height: 20, hiddenByAncestor: true },
        { id: 'below-fold', width: 20, height: 20, top: 900 },
        { id: 'above-fold', width: 20, height: 20, top: -20 },
        { id: 'left-of-screen', width: 20, height: 20, left: -20 },
      ]),
    ).toEqual({
      h1Count: 0,
      interactiveTargetViolations: [
        { selector: '#small', label: 'Open menu', width: 32, height: 40 },
        { selector: '#below-fold', label: '', width: 20, height: 20 },
      ],
    })
  })

  it('covers roving-focus controls and accessible label sources', () => {
    expect(
      runAudit(
        1,
        [
          { id: 'item', kind: 'menuitem', labelledBy: 'item-label', width: 30, height: 30 },
          { id: 'email', associatedLabel: 'Email address', width: 30, height: 30 },
        ],
        { 'item-label': 'Account menu' },
      ).interactiveTargetViolations,
    ).toEqual([
      { selector: '#item', label: 'Account menu', width: 30, height: 30 },
      { selector: '#email', label: 'Email address', width: 30, height: 30 },
    ])
  })

  it('bounds evidence to the shared contract limits', () => {
    const audit = runAudit(
      10_001,
      Array.from({ length: 201 }, (_, index) => ({
        id: `target-${index}`,
        label: 'x'.repeat(201),
        width: 20,
        height: 20,
      })),
    )
    expect(audit.h1Count).toBe(10_000)
    expect(audit.interactiveTargetViolations).toHaveLength(200)
    expect(audit.interactiveTargetViolations[0]?.label).toHaveLength(200)
  })
})
