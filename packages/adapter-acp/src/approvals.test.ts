import { describe, expect, it } from 'vitest'
import { optionFor, type PermissionOption } from './approvals.js'

/** The exact option set gemini-cli offers for a shell command. */
const GEMINI: PermissionOption[] = [
  { optionId: 'proceed_always', name: 'Always Allow node', kind: 'allow_always' },
  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
]

describe('optionFor', () => {
  it('sends the matching option for each decision', () => {
    expect(optionFor(GEMINI, 'approve')).toBe('proceed_once')
    expect(optionFor(GEMINI, 'approve-session')).toBe('proceed_always')
    expect(optionFor(GEMINI, 'deny')).toBe('cancel')
    expect(optionFor(GEMINI, 'abort')).toBe('cancel')
  })

  it('never turns a refusal into an approval when the exact option is absent', () => {
    const noRejectOnce: PermissionOption[] = [
      { optionId: 'yes', kind: 'allow_once' },
      { optionId: 'never', kind: 'reject_always' },
    ]
    expect(optionFor(noRejectOnce, 'deny')).toBe('never')
  })

  it('never turns an approval into a refusal when the exact option is absent', () => {
    const noAllowAlways: PermissionOption[] = [
      { optionId: 'yes', kind: 'allow_once' },
      { optionId: 'no', kind: 'reject_once' },
    ]
    expect(optionFor(noAllowAlways, 'approve-session')).toBe('yes')
  })

  it('returns nothing when the agent offers no option in that direction', () => {
    const allowOnly: PermissionOption[] = [{ optionId: 'yes', kind: 'allow_once' }]
    // The caller cancels rather than picking the only option on offer, which
    // would be an approval the user did not give.
    expect(optionFor(allowOnly, 'deny')).toBeUndefined()
  })

  it('ignores options with no id rather than sending undefined', () => {
    const broken: PermissionOption[] = [{ name: 'Allow', kind: 'allow_once' }]
    expect(optionFor(broken, 'approve')).toBeUndefined()
  })

  it('returns nothing for an empty option list', () => {
    expect(optionFor([], 'approve')).toBeUndefined()
  })
})
