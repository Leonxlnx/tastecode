import { describe, expect, it } from 'vitest'
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction'
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification'
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification'
import { CODEX_APPROVAL, CODEX_CAPABILITIES, mapAutoApprovalReview } from './adapter.js'

/** Sanitized frames captured from Codex 0.146.0 on Windows. */
const capturedStarted = {
  threadId: 'captured-thread',
  turnId: 'captured-turn',
  startedAtMs: 1_785_627_335_059,
  reviewId: 'captured-review',
  targetItemId: 'captured-item',
  review: {
    status: 'inProgress',
    riskLevel: null,
    userAuthorization: null,
    rationale: null,
  },
  action: {
    type: 'command',
    source: 'shell',
    command: 'pwsh -Command git status --short',
    cwd: 'D:\\repo',
  },
} satisfies ItemGuardianApprovalReviewStartedNotification

const capturedCompleted = {
  ...capturedStarted,
  completedAtMs: 1_785_627_339_124,
  decisionSource: 'agent',
  review: {
    status: 'approved',
    riskLevel: 'low',
    userAuthorization: 'high',
    rationale: 'The user explicitly authorized this read-only git status check.',
  },
} satisfies ItemGuardianApprovalReviewCompletedNotification

describe('Codex auto-review', () => {
  it('advertises the capability and maps captured lifecycle frames', () => {
    expect(CODEX_CAPABILITIES.autoReview).toBe(true)
    expect(CODEX_APPROVAL['auto-review']).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    })
    expect(mapAutoApprovalReview(capturedStarted)).toEqual({
      id: 'captured-review',
      turnId: 'captured-turn',
      status: 'in_progress',
      description: 'Run pwsh -Command git status --short',
      startedAt: 1_785_627_335_059,
    })
    expect(mapAutoApprovalReview(capturedCompleted)).toEqual({
      id: 'captured-review',
      turnId: 'captured-turn',
      status: 'approved',
      description: 'Run pwsh -Command git status --short',
      rationale: 'The user explicitly authorized this read-only git status check.',
      riskLevel: 'low',
      startedAt: 1_785_627_335_059,
      completedAt: 1_785_627_339_124,
    })
  })

  it.each([
    [
      { type: 'execve', source: 'unifiedExec', program: 'node', argv: ['script.js'], cwd: '/repo' },
      'Run node script.js',
    ],
    [{ type: 'applyPatch', cwd: '/repo', files: ['/repo/a.ts', '/repo/b.ts'] }, 'Edit 2 files'],
    [
      {
        type: 'networkAccess',
        target: 'https://example.com',
        host: 'example.com',
        protocol: 'https',
        port: 443,
      },
      'Connect to https://example.com',
    ],
    [
      {
        type: 'mcpToolCall',
        server: 'github',
        toolName: 'search',
        connectorId: null,
        connectorName: null,
        toolTitle: 'Search GitHub',
      },
      'Use Search GitHub',
    ],
    [
      {
        type: 'requestPermissions',
        reason: 'read another folder',
        permissions: { network: null, fileSystem: null },
      },
      'Request extra permissions: read another folder',
    ],
  ] satisfies Array<[GuardianApprovalReviewAction, string]>)(
    'describes %s neutrally',
    (action, description) => {
      expect(mapAutoApprovalReview({ ...capturedStarted, action })).toMatchObject({ description })
    },
  )
})
