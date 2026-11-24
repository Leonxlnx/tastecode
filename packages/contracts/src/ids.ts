import { z } from 'zod'

/**
 * Provider and account identities, kept apart from the rest of the protocol so a client can
 * import them (`@harness/contracts/ids`) without evaluating every message schema. The root
 * entry re-exports all of them through `domain.ts`.
 */

export const ProviderIdSchema = z.enum([
  'codex',
  'claude-code',
  'grok',
  'cursor',
  'opencode',
  'antigravity',
  'pi',
  'acp',
  'api',
])
export type ProviderId = z.infer<typeof ProviderIdSchema>

/** The account that uses the provider CLI's own config folder. Every provider has one. */
export const DEFAULT_ACCOUNT_ID = 'default'

/**
 * A provider account's identity, unique within its provider. Server-chosen;
 * `default` is reserved for the CLI's own config folder.
 */
export const AccountIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'expected a lowercase account id')
export type AccountId = z.infer<typeof AccountIdSchema>
