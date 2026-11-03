import { createContext } from 'react'
import type { AccountId, ProviderId } from '@harness/contracts'

/** A model a chat runs on, as the server records it: the id the picker sent. */
export type ModelTarget = {
  provider: ProviderId
  agent?: string | undefined
  accountId?: AccountId | undefined
  modelId: string
}

/** The picker's name for a model, or nothing while the app does not list it. */
export type ModelLabel = (target: ModelTarget) => string | undefined

/** Names models where the app shows them deep in a view, such as a chat moving to one. */
export const ModelLabelContext = createContext<ModelLabel | undefined>(undefined)
