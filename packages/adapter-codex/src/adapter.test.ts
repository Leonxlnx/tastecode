import { describe, expect, it } from 'vitest'
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction'
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification'
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification'
import type { RemoteControlStatusChangedNotification } from './generated/v2/RemoteControlStatusChangedNotification'
import type { ThreadStatusChangedNotification } from './generated/v2/ThreadStatusChangedNotification'
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification'
import type { WarningNotification } from './generated/v2/WarningNotification'
import type { ErrorNotification } from './generated/v2/ErrorNotification'
import {
  CODEX_APPROVAL,
  CODEX_CAPABILITIES,
  CodexAdapter,
  formatCodexWarning,
  mapCodexError,
  mapCodexUsage,
  isIgnorableCodexNotification,
  mapApprovalResponse,
  mapApprovalRequest,
  mapAutoApprovalReview,
  mapUserInputRequest,
  permissionInterruptParams,
} from './adapter.js'

const capturedTokenUsage = {
  threadId: 'captured-thread',
  turnId: 'captured-turn',
  tokenUsage: {
    total: {
      inputTokens: 570_000,
      cachedInputTokens: 490_000,
      outputTokens: 25_000,
      reasoningOutputTokens: 6_152,
      totalTokens: 601_152,
    },
    last: {
      inputTokens: 97_000,
      cachedInputTokens: 80_000,
      outputTokens: 4_000,
      reasoningOutputTokens: 1_000,
      totalTokens: 102_000,
    },
    modelContextWindow: 258_400,
  },
} satisfies ThreadTokenUsageUpdatedNotification

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

const capturedRemoteControlStatus = {
  status: 'disabled',
  serverName: 'captured-server',
  installationId: 'captured-installation',
  environmentId: null,
} satisfies RemoteControlStatusChangedNotification

const capturedThreadStatus = {
  threadId: 'captured-thread',
  status: { type: 'idle' },
} satisfies ThreadStatusChangedNotification

const capturedWarning = {
  threadId: 'captured-thread',
  message:
    'Under-development features enabled: default_mode_request_user_input. Under-development features are incomplete and may behave unpredictably.',
} satisfies WarningNotification

const capturedError = {
  threadId: 'captured-thread',
  turnId: 'captured-turn',
  willRetry: false,
  error: {
    message: 'Failed to parse server response',
    codexErrorInfo: 'internalServerError',
    additionalDetails: null,
  },
} satisfies ErrorNotification

describe('Codex notifications', () => {
  it('does not present cumulative thread usage as current context occupancy', () => {
    expect(mapCodexUsage(capturedTokenUsage, 'gpt-5.6')).toEqual({
      model: 'gpt-5.6',
      inputTokens: 570_000,
      cachedInputTokens: 490_000,
      outputTokens: 25_000,
      reasoningTokens: 6_152,
      totalTokens: 601_152,
      cumulative: true,
      inputIncludesCached: true,
    })
  })

  it('does not collapse a failed account read into signed out', async () => {
    await expect(new CodexAdapter().account()).rejects.toThrow('adapter not started')
  })

  it('silences the captured startup-only remote-control status', () => {
    expect(capturedRemoteControlStatus.status).toBe('disabled')
    expect(isIgnorableCodexNotification('remoteControl/status/changed')).toBe(true)
    expect(isIgnorableCodexNotification('new/provider/event')).toBe(false)
  })

  it('silences the captured provider thread status', () => {
    expect(capturedThreadStatus.status).toEqual({ type: 'idle' })
    expect(isIgnorableCodexNotification('thread/status/changed')).toBe(true)
  })

  it('preserves the captured Codex warning text', () => {
    expect(formatCodexWarning(capturedWarning)).toBe(`Codex warning: ${capturedWarning.message}`)
  })

  it('surfaces a terminal turn error but leaves retries to Codex', () => {
    expect(mapCodexError(capturedError)).toEqual({
      type: 'thread.error',
      threadId: 'captured-thread',
      message: 'Failed to parse server response',
    })
    expect(mapCodexError({ ...capturedError, willRetry: true })).toBeUndefined()
  })
})

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

describe('Codex structured user input', () => {
  it('advertises support and maps the captured wire shape', () => {
    expect(CODEX_CAPABILITIES.userInput).toBe(true)
    expect(
      mapUserInputRequest({
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'questions-1',
        autoResolutionMs: null,
        questions: [
          {
            id: 'palette',
            header: 'Colour',
            question: 'Do you already have a palette?',
            isOther: true,
            isSecret: false,
            options: [{ label: 'Decide for me', description: 'Infer the strongest direction.' }],
          },
        ],
      }),
    ).toMatchObject({
      id: 'questions-1',
      turnId: 'turn-1',
      autoResolutionMs: null,
      questions: [
        {
          id: 'palette',
          header: 'Colour',
          question: 'Do you already have a palette?',
          allowOther: true,
          secret: false,
          options: [{ label: 'Decide for me', description: 'Infer the strongest direction.' }],
        },
      ],
    })
  })
})

describe('Codex permission approval', () => {
  const requested = {
    network: { enabled: true },
    fileSystem: { read: ['D:\\reference'], write: null },
  }

  it('answers the permission-profile wire request with the requested grant and scope', () => {
    expect(mapApprovalResponse('permissions', 'approve', requested)).toEqual({
      permissions: requested,
      scope: 'turn',
    })
    expect(mapApprovalResponse('permissions', 'approve-session', requested)).toEqual({
      permissions: requested,
      scope: 'session',
    })
  })

  it('denies the permission-profile wire request with an empty turn grant', () => {
    expect(mapApprovalResponse('permissions', 'deny', requested)).toEqual({
      permissions: {},
      scope: 'turn',
    })
    expect(mapApprovalResponse('permissions', 'abort', requested)).toEqual({
      permissions: {},
      scope: 'turn',
    })
  })

  it('shows the exact requested access separately from the provider reason', () => {
    expect(
      mapApprovalRequest('permissions', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'permission-1',
        environmentId: null,
        startedAtMs: 1,
        cwd: 'D:\\repo',
        reason: 'Read the supplied reference and fetch its font.',
        permissions: requested,
      }),
    ).toMatchObject({
      id: 'permission-1',
      kind: 'permissions',
      cwd: 'D:\\repo',
      reason: 'Read the supplied reference and fetch its font.',
      command: `Requested access:\n${JSON.stringify(requested, null, 2)}`,
    })
  })

  it('interrupts the exact turn after aborting its permission request', () => {
    expect(permissionInterruptParams('thread-1', 'turn-1')).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
    })
  })
})
