import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  designReviewPrompt,
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
      evidenceType: 'visual_inspection' as const,
      confidence: 'high' as const,
      evidence: 'The primary action is clipped by the image.',
      repair: 'Stack the image after the action below 720px.',
    },
  ],
}

describe('review and repair phases', () => {
  it('treats the visual anti-slop floor as pass-blocking', () => {
    // SAFETY: This prompt test checks fixed instructions; the function only serializes these artifact values.
    const prompt = designReviewPrompt(
      {} as Parameters<typeof designReviewPrompt>[0],
      {} as Parameters<typeof designReviewPrompt>[1],
      {} as Parameters<typeof designReviewPrompt>[2],
      [],
    )
    expect(prompt).toContain(
      'Heading size, width, line count or placement differs materially from the reference',
    )
    expect(prompt).toContain('flag missing planned motion when browser evidence proves it')
    expect(prompt).toContain(
      'Preserve concise identification of concept work or an illustrative catalog',
    )
    expect(prompt).toContain('uppercase monospace micro-heading')
    expect(prompt).toContain('open editorial content becomes boxed')
    expect(prompt).toContain('approved brand accent appears only in tiny labels')
    expect(prompt).toContain('unstyled browser default')
    expect(prompt).toContain('footer content overlaps')
    expect(prompt).toContain('visibly stretched, cropped, cut off, or oversized')
    expect(prompt).toContain('replaces the reference alignment')
    expect(prompt).toContain("each section's recorded motion decision")
    expect(prompt).toContain('referenceDirectionId')
    expect(prompt).toContain('Invented grids, separator rules, card-edge rails')
    expect(prompt).toContain('SVG is acceptable only for an explicit functional icon, logo')
  })

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
    const prompt = designRepairPrompt(
      review,
      1,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      [{ path: 'mobile.png', width: 390, height: 844 }],
    )
    expect(prompt).toContain('attempt 1 of 2')
    expect(prompt).toContain('Fix only the validated visual findings')
    expect(prompt).toContain('Remove invented SVG filler and off-reference card-edge rails')
    expect(prompt).toContain('<screenshots>')
    expect(prompt).toContain('mobile.png')
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
      'interactive_target_size',
    ])
  })

  it('enforces target sizes outside mobile viewports', () => {
    const result = enforceDomAuditFindings(review, [
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
    ])
    expect(result.verdict).toBe('repair')
    expect(result.findings.at(-1)).toMatchObject({ id: 'interactive_target_size' })
  })

  it('keeps older review findings readable with conservative evidence metadata', () => {
    const legacy = {
      ...review,
      findings: review.findings.map(
        ({ evidenceType: _type, confidence: _confidence, ...finding }) => finding,
      ),
    }
    expect(parseReviewPhaseOutput(JSON.stringify(legacy)).findings[0]).toMatchObject({
      evidenceType: 'visual_inspection',
      confidence: 'medium',
    })
  })
})
