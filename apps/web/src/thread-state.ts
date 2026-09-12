import type {
  ApprovalRequest,
  ApprovalReview,
  Item,
  PlanStep,
  Usage,
  UserInputRequest,
} from '@harness/contracts'

export type TurnTiming = Readonly<Record<string, { startedAt?: number; completedAt?: number }>>

export type LiveItemUpdate = {
  item: Item
  version: number
  textUpdate: { kind: 'append'; text: string }
}

export type ThreadState = {
  items: Item[]
  liveItems: ReadonlyMap<number, LiveItemUpdate>
  itemVersion: number
  liveStart: number
  running: boolean
  /** The live turn whose elapsed time and activity the UI is presenting. */
  activeTurn: { id: string; startedAt: number } | undefined
  /** Durable server-owned lifecycle boundaries used by live and replayed elapsed labels. */
  turnTiming: TurnTiming
  /** The agent's plan for the current turn. Replaced wholesale when it changes. */
  plan: PlanStep[]
  usage?: Usage
  /** Everything the current turn changed, as one unified diff. */
  diff?: string | undefined
  /** The turn that owns `diff`, so actions target the exact displayed block. */
  diffTurnId?: string | undefined
  /** Permission requests still waiting on an answer. */
  approvals: ApprovalRequest[]
  /** Structured questions still blocking the current agent turn. */
  userInputs: UserInputRequest[]
  /** Automatic approval reviews, upserted by their stable provider id. */
  reviews: Record<string, ApprovalReview>
}

export const EMPTY_LIVE_ITEMS: ReadonlyMap<number, LiveItemUpdate> = new Map()

export const emptyThread: ThreadState = {
  items: [],
  liveItems: EMPTY_LIVE_ITEMS,
  itemVersion: 0,
  liveStart: 0,
  running: false,
  activeTurn: undefined,
  turnTiming: {},
  plan: [],
  approvals: [],
  userInputs: [],
  reviews: {},
}
