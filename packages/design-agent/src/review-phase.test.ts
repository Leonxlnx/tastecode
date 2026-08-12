import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  designRepairPrompt,
  enforceDomAuditFindings,
  parseRepairPhaseOutput,
  parseReviewPhaseOutput,
  readVisualReview,
  writeVisualReview,
} from './review-phase.js'

let workspace: string | undefined

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  workspace = undefined
})

const review = {
  version: 1 as const,
  verdict: 'repair' as const,
  summary: 'One responsive defect remains.',
  findings: [
    {
      id: 'hero_mobile_clip',
      severity: 'major' as const,
      area: 'Hero at 390px',
      evidence: 'The primary action is clipped by the image.',
      repair: 'Stack the image after the action below 720px.',
    },
  ],
}

describe('review and repair phases', () => {
  it('persists the validated final review artifact', () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'taste-review-'))
    const result = {
      version: 1 as const,
      verdict: 'pass' as const,
      summary: 'Ready.',
      findings: [],
    }

    writeVisualReview(workspace, result)

    expect(readVisualReview(workspace)).toEqual(result)
  })

  it('rejects praise-only passes that still contain findings', () => {
    expect(() => parseReviewPhaseOutput(JSON.stringify({ ...review, verdict: 'pass' }))).toThrow(
      'passing visual review cannot contain findings',
    )
  })

  it('keeps repair bounded to the review and attempt budget', () => {
    const prompt = designRepairPrompt(review, 1, 2)
    expect(prompt).toContain('attempt 1 of 2')
    expect(prompt).toContain('Fix only the validated visual findings')
  })

  it('parses a repair completion report', () => {
    expect(
      parseRepairPhaseOutput(
        JSON.stringify({
          status: 'complete',
          summary: 'Fixed the mobile stack.',
          files: ['src/styles.css'],
          checks: ['pnpm build — passed'],
        }),
      ),
    ).toMatchObject({ status: 'complete' })
  })

  it('turns a model pass into a bounded repair from objective DOM evidence', () => {
    const result = enforceDomAuditFindings(
      { version: 1, verdict: 'pass', summary: 'Looks ready.', findings: [] },
      [
        {
          path: 'mobile.png',
          width: 390,
          height: 844,
          domAudit: {
            h1Count: 0,
            interactiveTargetViolations: [
              { selector: '#menu', label: 'Menu', width: 32, height: 40 },
            ],
          },
        },
      ],
    )

    expect(result.verdict).toBe('repair')
    expect(result.findings.map(({ id }) => id)).toEqual([
      'document_h1_count',
      'mobile_interactive_target_size',
    ])
  })

  it('preserves model findings and ignores target sizes outside mobile viewports', () => {
    expect(
      enforceDomAuditFindings(review, [
        {
          path: 'desktop.png',
          width: 1440,
          height: 1000,
          domAudit: {
            h1Count: 1,
            interactiveTargetViolations: [
              { selector: '#utility', label: 'Utility', width: 20, height: 20 },
            ],
          },
        },
      ]),
    ).toEqual(review)
  })
})
