import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PreviewDomAuditSchema } from '@harness/contracts'
import { PREVIEW_DOM_AUDIT_SCRIPT } from './preview-dom-audit.js'

type ElementFixture = {
  id?: string
  label?: string
  width: number
  height: number
  disabled?: boolean
  hidden?: boolean
}

function runAudit(h1Count: number, fixtures: ElementFixture[]) {
  const elements = fixtures.map((fixture, index) => ({
    id: fixture.id ?? '',
    localName: 'button',
    parentElement: undefined,
    textContent: fixture.label ?? '',
    getAttribute(name: string) {
      return name === 'aria-label' ? (fixture.label ?? null) : null
    },
    getBoundingClientRect() {
      return {
        width: fixture.width,
        height: fixture.height,
        left: 0,
        right: fixture.width,
      }
    },
    matches(selector: string) {
      return Boolean(fixture.disabled && selector.includes(':disabled'))
    },
    fixture,
    index,
  }))
  const result = vm.runInNewContext(PREVIEW_DOM_AUDIT_SCRIPT, {
    CSS: { escape: (value: string) => value },
    Number,
    Math,
    Array,
    innerWidth: 390,
    document: {
      querySelectorAll: (selector: string) =>
        selector === 'h1' ? Array.from({ length: h1Count }) : elements,
    },
    getComputedStyle: (element: (typeof elements)[number]) => ({
      display: element.fixture.hidden ? 'none' : 'block',
      visibility: 'visible',
      pointerEvents: 'auto',
    }),
  })
  return PreviewDomAuditSchema.parse(result)
}

describe('preview DOM audit', () => {
  it('reports rendered heading count and only visible undersized targets', () => {
    expect(
      runAudit(0, [
        { id: 'small', label: 'Open menu', width: 32, height: 40 },
        { id: 'large', width: 44, height: 44 },
        { id: 'disabled', width: 20, height: 20, disabled: true },
        { id: 'hidden', width: 20, height: 20, hidden: true },
      ]),
    ).toEqual({
      h1Count: 0,
      interactiveTargetViolations: [
        { selector: '#small', label: 'Open menu', width: 32, height: 40 },
      ],
    })
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
