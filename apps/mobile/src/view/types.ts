import type { ApprovalDecision, ApprovalMode } from '@harness/contracts'

/**
 * What the native screens render, already worded. The phone's logic builds
 * these; SwiftUI (and a later Compose layer) only lays them out, so both
 * platforms say the same thing. Every field is JSON: absent values are null.
 */

export type LinkPhase = 'idle' | 'connecting' | 'open' | 'waiting' | 'refused'

export type LinkView = {
  /** A computer is paired and has answered at least once. */
  paired: boolean
  /** A pairing code was read and its first handshake is still under way. */
  pairing: boolean
  /** The name the person chose for the computer, or its own. */
  computerName: string | null
  /** The computer's own name, shown again when the chosen one is cleared. */
  defaultName: string | null
  phase: LinkPhase
  host: string | null
  error: string | null
  /** Groups of four characters, for comparing keys aloud. */
  computerKey: string | null
  phoneKey: string
}

export type ChatState = 'idle' | 'starting' | 'working' | 'queued' | 'approval' | 'input' | 'failed'

export type ChatView = {
  id: string
  title: string
  projectPath: string
  projectName: string
  state: ChatState
  unread: boolean
  pinned: boolean
  archived: boolean
  /** Last activity, epoch milliseconds. */
  at: number
  /** The private checkout's branch, when the chat has one. */
  branch: string | null
  /** The agent the chat runs on, as the model picker names it. */
  sourceName: string
  /** The model of the chat's setup; null while it uses the agent's default. */
  modelName: string | null
}

export type ProjectView = { path: string; name: string; pinned: boolean; chats: number }

export type ChatsView = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  projects: ProjectView[]
  /** Needs-you first, then by last activity. */
  chats: ChatView[]
}

export type EffortView = { id: string; label: string }

export type ModelView = {
  id: string
  name: string
  /** Listed under "More Models" rather than with the source's curated set. */
  more: boolean
  efforts: EffortView[]
  /** Faster routings the provider offers for this model, such as Fast. */
  tiers: TierView[]
}

export type TierView = { id: string; name: string }

export type AccessView = { mode: ApprovalMode; title: string; detail: string }

export type SourceView = {
  key: string
  name: string
  status: 'loading' | 'ready' | 'error'
  images: boolean
  models: ModelView[]
  access: AccessView[]
}

export type CatalogView = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  sources: SourceView[]
}

/** Where the next prompt goes and with what: a chat's current setup, or a new chat's. */
export type SetupView = {
  sourceKey: string | null
  sourceName: string | null
  model: string | null
  modelName: string | null
  effort: string | null
  effortLabel: string | null
  /** The faster routing chosen; null is the standard one. */
  tier: string | null
  tierName: string | null
  access: ApprovalMode
  accessTitle: string
  images: boolean
  /** Other sources can be chosen only while nothing runs. */
  switchable: boolean
}

export type StepKind = 'command' | 'file' | 'tool' | 'agent' | 'thinking' | 'plan' | 'other'

export type StepView = {
  id: string
  kind: StepKind
  title: string
  detail: string | null
  added: number | null
  removed: number | null
  running: boolean
  failed: boolean
}

export type RowView =
  | { key: string; kind: 'user'; text: string; attachments: string[] }
  | { key: string; kind: 'assistant'; text: string; streaming: boolean }
  | {
      key: string
      kind: 'steps'
      live: boolean
      summary: string
      /** How long the turn took, once it ended. */
      duration: string | null
      failed: boolean
      steps: StepView[]
    }
  | { key: string; kind: 'notice'; text: string }
  | { key: string; kind: 'error'; text: string }

export type ApprovalView = {
  id: string
  title: string
  subject: string | null
  reason: string | null
  where: string | null
}

export type OptionView = { label: string; detail: string }

export type QuestionView = {
  id: string
  header: string
  question: string
  options: OptionView[]
  multiple: boolean
  other: boolean
  secret: boolean
}

export type QuestionsView = { id: string; questions: QuestionView[] }

export type QueuedView = { id: string; text: string }

export type PlanView = { text: string; status: 'pending' | 'running' | 'done' }

export type ChangesView = { files: number; added: number; removed: number }

export type ThreadMetaView = {
  id: string
  title: string
  projectName: string | null
  projectPath: string | null
  pinned: boolean
  archived: boolean
  status: 'loading' | 'ready' | 'error'
  error: string | null
  running: boolean
  /** The agent works but nothing streams yet: show that it is busy. */
  waiting: boolean
  hasOlder: boolean
  loadingOlder: boolean
  setup: SetupView
  approval: ApprovalView | null
  questions: QuestionsView | null
  queue: QueuedView[]
  canSteer: boolean
  plan: PlanView[]
  changes: ChangesView | null
}

/**
 * One update to an open chat. `rows` holds only rows that changed since the
 * last update; `order` is present when rows were added, removed or moved.
 */
export type ThreadPatch = {
  meta: ThreadMetaView
  rows: RowView[]
  order: string[] | null
  /** True when this update replaces everything shown (a fresh read). */
  reset: boolean
}

export type NewChatView = {
  projectPath: string | null
  projectName: string | null
  isolate: boolean
  setup: SetupView
}

/** What the native screens ask for. Requests carry an id and expect `resolve`. */
export type Action =
  | { type: 'pair'; link: string }
  | { type: 'forget' }
  | { type: 'reconnect' }
  | { type: 'attachment.read'; threadId: string; path: string }
  | { type: 'computer.rename'; name: string }
  | { type: 'refresh' }
  | { type: 'thread.open'; threadId: string }
  | { type: 'thread.close'; threadId: string }
  | { type: 'thread.loadOlder'; threadId: string }
  | { type: 'thread.send'; threadId: string; text: string; attachments: string[] }
  | { type: 'thread.stop'; threadId: string }
  | { type: 'thread.decide'; threadId: string; approvalId: string; decision: ApprovalDecision }
  | {
      type: 'thread.answer'
      threadId: string
      requestId: string
      answers: Record<string, string[]>
    }
  | { type: 'thread.steer'; threadId: string; queuedId: string }
  | { type: 'thread.unqueue'; threadId: string; queuedId: string }
  | { type: 'thread.setAccess'; threadId: string; access: ApprovalMode }
  | { type: 'thread.setModel'; threadId: string; sourceKey: string; model: string }
  | { type: 'thread.setEffort'; threadId: string; effort: string }
  | { type: 'thread.setTier'; threadId: string; tier: string | null }
  | { type: 'thread.moveQueued'; threadId: string; queuedId: string; direction: 'up' | 'down' }
  | { type: 'thread.pin'; threadId: string; pinned: boolean }
  | { type: 'thread.archive'; threadId: string }
  | { type: 'thread.restore'; threadId: string }
  | { type: 'thread.rename'; threadId: string; title: string }
  | { type: 'thread.diff'; threadId: string }
  | { type: 'newChat.open'; projectPath: string | null }
  | {
      type: 'newChat.set'
      projectPath?: string
      isolate?: boolean
      sourceKey?: string
      model?: string
      effort?: string
      tier?: string | null
      access?: ApprovalMode
    }
  | { type: 'newChat.start'; text: string; attachments: string[] }
  | { type: 'project.browse'; path: string | null }
  | { type: 'project.add'; path: string }
  | { type: 'attach'; mimeType: string; data: string }
