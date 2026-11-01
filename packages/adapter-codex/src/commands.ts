import type { ProviderCommand } from '@harness/contracts'
import { z } from 'zod'
import type { ClientRequest } from './generated/ClientRequest.js'

/**
 * The app-server's built-in thread actions that Codex's own TUI offers as
 * slash commands. The app-server has no command list of its own, so this one
 * names only the actions TasteCode routes to a request below.
 */
export const CODEX_COMMANDS: ProviderCommand[] = [
  {
    name: 'goal',
    description: 'Set, show, pause, resume or clear the goal Codex works toward',
    argumentHint: '<objective> | pause | resume | clear',
  },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  {
    name: 'review',
    description: 'Review uncommitted changes, or what your instructions ask for',
    argumentHint: '[instructions]',
  },
]

type CommandMethod = 'thread/goal/set' | 'thread/goal/get' | 'thread/goal/clear'
type TurnMethod = 'thread/compact/start' | 'review/start'
type RequestOf<Method extends ClientRequest['method']> = {
  method: Method
  params: Extract<ClientRequest, { method: Method }>['params']
}

/** A typed command as the app-server request it stands for, built from the generated protocol. */
export type CodexCommandRequest =
  | RequestOf<'thread/goal/set'>
  | RequestOf<'thread/goal/get'>
  | RequestOf<'thread/goal/clear'>
  | RequestOf<'thread/compact/start'>
  | RequestOf<'review/start'>

export type CodexReplyRequest = Extract<CodexCommandRequest, { method: CommandMethod }>
export type CodexTurnRequest = Extract<CodexCommandRequest, { method: TurnMethod }>

const COMMAND = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/i

/**
 * The request a leading `/goal`, `/compact` or `/review` stands for, or
 * undefined for anything else, which then goes to Codex as typed.
 */
export function codexCommandRequest(
  threadId: string,
  text: string,
): CodexCommandRequest | undefined {
  const match = COMMAND.exec(text.trim())
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  const args = (match[2] ?? '').trim()
  switch (name) {
    case 'goal': {
      if (!args) return { method: 'thread/goal/get', params: { threadId } }
      const word = args.toLowerCase()
      if (word === 'clear') return { method: 'thread/goal/clear', params: { threadId } }
      if (word === 'pause' || word === 'resume') {
        return {
          method: 'thread/goal/set',
          params: { threadId, status: word === 'pause' ? 'paused' : 'active' },
        }
      }
      return { method: 'thread/goal/set', params: { threadId, objective: args, status: 'active' } }
    }
    case 'compact':
      // Codex compaction takes no instructions; refusing them is clearer than
      // silently dropping words the user meant to matter.
      return args ? undefined : { method: 'thread/compact/start', params: { threadId } }
    case 'review':
      return {
        method: 'review/start',
        params: {
          threadId,
          target: args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' },
          delivery: 'inline',
        },
      }
    default:
      return undefined
  }
}

const GoalSchema = z.object({
  objective: z.string(),
  status: z.string(),
  tokenBudget: z.number().nullable().optional(),
  tokensUsed: z.number().optional(),
})
export const GoalResponseSchema = z.object({
  goal: GoalSchema.nullable().optional(),
  cleared: z.boolean().optional(),
})
export const ReviewStartResponseSchema = z.object({
  turn: z.object({ id: z.string() }),
  reviewThreadId: z.string(),
})

/** A status newer than the generated protocol shows as Codex names it. */
function goalStatusLabel(status: string): string {
  switch (status) {
    case 'usageLimited':
      return 'stopped at the usage limit'
    case 'budgetLimited':
      return 'stopped at its token budget'
    default:
      return status
  }
}

/** The line shown in the chat for a goal request's answer. */
export function describeGoalReply(
  request: CodexReplyRequest,
  response: z.infer<typeof GoalResponseSchema>,
): string {
  if (request.method === 'thread/goal/clear') {
    return response.cleared === false ? 'This chat had no goal to clear.' : 'Goal cleared.'
  }
  const goal = response.goal
  if (!goal) return 'This chat has no goal. Set one with /goal <objective>.'
  const status = goalStatusLabel(goal.status)
  const budget =
    goal.tokenBudget != null
      ? ` ${goal.tokensUsed ?? 0} of ${goal.tokenBudget} budgeted tokens used.`
      : ''
  const lead =
    request.method === 'thread/goal/get'
      ? 'Goal'
      : request.params.objective
        ? 'Goal set'
        : request.params.status === 'paused'
          ? 'Goal paused'
          : 'Goal resumed'
  // Pausing or resuming already names the new status in the lead.
  const shown =
    request.method === 'thread/goal/set' && !request.params.objective ? '' : ` (${status})`
  return `${lead}${shown}: ${goal.objective}${budget ? `\n${budget.trim()}` : ''}`
}
