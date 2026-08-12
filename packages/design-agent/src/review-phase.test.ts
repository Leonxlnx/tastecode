import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSinglePageHeading,
  designRepairPrompt,
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
  it('requires exactly one rendered page heading in static HTML', () => {
    expect(() => assertSinglePageHeading('<main><h2>Grid health</h2></main>')).toThrow(
      'exactly one <h1>; found 0',
    )
    expect(() => assertSinglePageHeading('<h1>Grid health</h1><h1>Events</h1>')).toThrow(
      'exactly one <h1>; found 2',
    )
    expect(() =>
      assertSinglePageHeading(`
        <!-- <h1>Comment</h1> -->
        <script>const example = '<h1>Script</h1>'</script>
        <textarea><h1>Example source</h1></textarea>
        <template><h1>Template</h1></template>
        </template>
        <H1 class='page-title' data-label=">">Grid health</H1>
      `),
    ).not.toThrow()
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
})
