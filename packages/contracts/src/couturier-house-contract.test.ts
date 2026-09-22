import { describe, expect, it } from 'vitest'
import { CouturierSourceRefSchema, CouturierViewStateSchema, methods } from './protocol.js'

const commissionId = '11111111-1111-4111-8111-111111111111'
const preparationId = '22222222-2222-4222-8222-222222222222'
const requestId = '33333333-3333-4333-8333-333333333333'
const draftId = '44444444-4444-4444-8444-444444444444'
const submissionId = '55555555-5555-4555-8555-555555555555'

const view = {
  mode: 'overview' as const,
  referenceDirectionId: null,
  slicePath: null,
  productionPath: null,
  comparedDirectionIds: [],
  captureView: 'desktop' as const,
  captureFrame: 'initial' as const,
  fittingFilter: 'all' as const,
  finisherFilter: 'open' as const,
}

describe('Couturier House contracts', () => {
  it('requires a hash exactly when a source is readable', () => {
    expect(
      CouturierSourceRefSchema.parse({
        root: '/commission',
        relativePath: 'DIRECTIONS.json',
        state: 'readable',
        sha256: 'a'.repeat(64),
      }),
    ).toBeTruthy()
    expect(
      CouturierSourceRefSchema.safeParse({
        root: '/commission',
        relativePath: 'DIRECTIONS.json',
        state: 'readable',
        sha256: null,
      }).success,
    ).toBe(false)
    expect(
      CouturierSourceRefSchema.safeParse({
        root: '/commission',
        relativePath: 'DIRECTIONS.json',
        state: 'missing',
        sha256: 'a'.repeat(64),
      }).success,
    ).toBe(false)
  })

  it('keeps comparison state bounded to two directions', () => {
    expect(CouturierViewStateSchema.parse(view)).toEqual(view)
    expect(
      CouturierViewStateSchema.safeParse({
        ...view,
        comparedDirectionIds: ['DIR-A', 'DIR-B', 'DIR-C'],
      }).success,
    ).toBe(false)
  })

  it('prepares either a new or existing commission, never both', () => {
    const base = {
      projectPath: '/project',
      workingDirectory: '/project/commission',
      role: 'generation' as const,
      requestId,
    }
    expect(
      methods['couturier.prepareSession'].params.parse({ ...base, displayName: 'Commission' }),
    ).toBeTruthy()
    expect(methods['couturier.prepareSession'].params.parse({ ...base, commissionId })).toBeTruthy()
    expect(
      methods['couturier.prepareSession'].params.safeParse({
        ...base,
        commissionId,
        displayName: 'Commission',
      }).success,
    ).toBe(false)
    expect(methods['couturier.prepareSession'].params.safeParse(base).success).toBe(false)
  })

  it('rejects isolated starts for a prepared session', () => {
    const start = {
      provider: 'codex' as const,
      workspacePath: '/project',
      couturierContext: { preparationId },
    }
    expect(methods['thread.start'].params.parse(start)).toEqual(start)
    expect(methods['thread.start'].params.safeParse({ ...start, isolate: true }).success).toBe(
      false,
    )
  })

  it('requires UUID submission identity only for associated drafts', () => {
    expect(
      methods['thread.sendTurn'].params.parse({
        threadId: 'thread-1',
        text: 'My edited ruling',
        clientSubmissionId: submissionId,
        couturierDraftId: draftId,
      }),
    ).toBeTruthy()
    expect(
      methods['thread.sendTurn'].params.safeParse({
        threadId: 'thread-1',
        text: 'My edited ruling',
        clientSubmissionId: 'legacy-id',
        couturierDraftId: draftId,
      }).success,
    ).toBe(false)
    expect(
      methods['thread.sendTurn'].params.parse({
        threadId: 'thread-1',
        text: 'Ordinary message',
        clientSubmissionId: 'legacy-id',
      }),
    ).toBeTruthy()
  })

  it('carries immutable House context on queued decisions', () => {
    const queued = {
      id: 'queued-1',
      text: 'Shortlist DIR-A — because authored reason',
      attachments: [],
      createdAt: 10,
      couturierContext: {
        draftId,
        clientSubmissionId: submissionId,
        commissionId,
        role: 'generation' as const,
        boundThreadId: 'thread-1',
        workingDirectory: '/project/commission',
        evidenceVersion: 'version-1',
      },
    }
    expect(methods['thread.sendTurn'].result.parse({ queued: true, queuedTurn: queued })).toEqual({
      queued: true,
      queuedTurn: queued,
    })
  })

  it('distinguishes a section error from an empty fresh projection', () => {
    const section = {
      readState: 'error' as const,
      value: null,
      reason: 'DIRECTIONS.json is unreadable',
      readAt: 10,
      sourceRefs: [],
      evidenceVersion: null,
    }
    const sections = {
      generationOverview: section,
      finishingOverview: section,
      directions: section,
      fitting: section,
      finisherReview: section,
      resumeGeneration: section,
      resumeFinishing: section,
      conditionalGates: section,
    }
    expect(
      methods['couturier.refresh'].result.parse({
        commissionId,
        requestGeneration: 3,
        readAt: 10,
        sections,
      }),
    ).toBeTruthy()
    expect(
      methods['couturier.refresh'].result.safeParse({
        commissionId,
        requestGeneration: 3,
        readAt: 10,
        sections: { ...sections, directions: { ...section, reason: null } },
      }).success,
    ).toBe(false)
  })
})
