import { createContext } from 'react'
import type { AccountId, ProviderId } from '@harness/contracts'
import type { ProviderAccountsSnapshot } from '../provider-accounts-state.js'
import type { UsageSummaryState } from '../usage-summary-state.js'

/**
 * What the ledger picker reads beyond `ModelSelectorProps`: plan limits,
 * accounts, the open chat and how each source's listing went. Every field is
 * optional; without them the ledger shows models and effort only.
 */
export type ModelLedgerData = {
  /** The usage controller's snapshot, as the app holds it. */
  limits?: readonly UsageSummaryState[] | undefined
  /** Called while the ledger is open so on-demand sources are read; returns the release. */
  onShowLimits?: (() => () => void) | undefined
  accounts?: ProviderAccountsSnapshot | undefined
  /** The open chat, when it can move to another engine. Absent in a new chat. */
  chat?: { source: string; provider: ProviderId; accountId?: AccountId | undefined } | undefined
  /** Sources still listing their models. */
  pendingSources?: ReadonlySet<string> | undefined
  /** The last listing error of each source that failed. */
  sourceErrors?: Readonly<Record<string, { message: string }>> | undefined
  onRetrySources?: (() => void) | undefined
}

/** The open ledger panel's frame, set by the trigger that opened it. */
export type ModelLedgerFrame = {
  close: () => void
  /** The panel's height in CSS px, fitted to the room beside the trigger. */
  height: number
}

export const ModelLedgerFrameContext = createContext<ModelLedgerFrame | undefined>(undefined)
