import { describe, expect, it } from 'vitest'
import type { Item, ProviderAccount } from '@harness/contracts'
import {
  accountAtLimit,
  continueAccounts,
  continuationNote,
  continuedIn,
  lastRequest,
} from './continue-account.js'
import type { ProviderAccountsSnapshot } from './provider-accounts-state.js'
import type { UsageSummaryState } from './usage-summary-state.js'

const NOW = 1_800_000_000_000
const totals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
}

function ready(
  limits: Array<{ usedPercent: number; resetsAt?: number; valueLabel?: string }>,
  accountId?: string,
): UsageSummaryState {
  return {
    status: 'ready',
    provider: 'codex',
    ...(accountId ? { accountId } : {}),
    summary: {
      session: totals,
      today: totals,
      limits: limits.map((limit) => ({ label: '5 hours', ...limit })),
    },
  }
}

const account = (id: string, extra: Partial<ProviderAccount> = {}): ProviderAccount =>
  id === 'default'
    ? { id, provider: 'codex', label: 'Personal', managed: false, ...extra }
    : { id, provider: 'codex', label: id, home: `C:\\accounts\\${id}`, managed: true, ...extra }

describe('continue on another account', () => {
  it('reads an account as at its limit only while a used-up window has not reset', () => {
    expect(accountAtLimit([ready([{ usedPercent: 100 }])], 'codex', undefined, NOW)).toBe(true)
    expect(accountAtLimit([ready([{ usedPercent: 99.5 }])], 'codex', undefined, NOW)).toBe(false)
    expect(
      accountAtLimit([ready([{ usedPercent: 100, resetsAt: NOW - 1 }])], 'codex', undefined, NOW),
    ).toBe(false)
    // A balance row is not a window.
    expect(
      accountAtLimit([ready([{ usedPercent: 100, valueLabel: '$0.00' }])], 'codex', undefined, NOW),
    ).toBe(false)
    // Another account's limit says nothing about this one.
    expect(accountAtLimit([ready([{ usedPercent: 100 }], 'work')], 'codex', undefined, NOW)).toBe(
      false,
    )
    expect(accountAtLimit([ready([{ usedPercent: 100 }], 'work')], 'codex', 'work', NOW)).toBe(true)
    expect(accountAtLimit([], 'codex', undefined, NOW)).toBe(false)
  })

  it('offers only the other accounts known to be signed in', () => {
    const snapshot: ProviderAccountsSnapshot = {
      phase: 'ready',
      accounts: [
        account('default'),
        account('work', { email: 'work@example.test' }),
        account('spare'),
        account('team', { plan: 'team' }),
      ],
      active: {},
    }
    const ids = (chat: string | undefined, defaultSignedIn: boolean) =>
      continueAccounts(snapshot, 'codex', chat, defaultSignedIn).map((entry) => entry.id)
    expect(ids(undefined, true)).toEqual(['work', 'team'])
    expect(ids('work', true)).toEqual(['default', 'team'])
    expect(ids('work', false)).toEqual(['team'])
    expect(continueAccounts(snapshot, 'claude-code', undefined, true)).toEqual([])
  })

  it('finds the newest chat that continues one and the last request', () => {
    const projects = [
      {
        sessions: [
          { id: 'a', createdAt: 1 },
          { id: 'b', createdAt: 2, continuedFrom: 'a' },
        ],
      },
      { sessions: [{ id: 'c', createdAt: 3, continuedFrom: 'a' }] },
    ]
    expect(continuedIn(projects, 'a')?.id).toBe('c')
    expect(continuedIn(projects, 'b')).toBeUndefined()
    const message = (role: 'user' | 'assistant', text: string): Item => ({
      id: text,
      turnId: 't',
      type: 'message',
      role,
      status: 'completed',
      text,
      createdAt: 1,
    })
    expect(
      lastRequest([
        message('user', 'First'),
        message('user', ' Second '),
        message('assistant', 'Answer'),
      ]),
    ).toBe('Second')
    expect(lastRequest([message('assistant', 'Only an answer')])).toBeUndefined()
  })
})

describe('the note in a chat that continues another', () => {
  it("says where the earlier chat's uncommitted changes are", () => {
    expect(continuationNote('Webhook retries', 'Work', undefined)).toBe(
      'Continues “Webhook retries” on Work. Its conversation goes with your first message.',
    )
    expect(continuationNote('Webhook retries', 'Work', { carried: true })).toBe(
      "Continues “Webhook retries” on Work. Its conversation goes with your first message, and its uncommitted changes are already in this chat's checkout.",
    )
    expect(
      continuationNote('Webhook retries', 'Work', {
        carried: false,
        keptIn: 'C:\\TasteCode\\trees\\a1b2c3',
      }),
    ).toBe(
      'Continues “Webhook retries” on Work. Its conversation goes with your first message. Its uncommitted changes could not be carried over; they are still in C:\\TasteCode\\trees\\a1b2c3.',
    )
  })
})
