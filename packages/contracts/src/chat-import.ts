import { z } from 'zod'
import { ProviderIdSchema } from './domain.js'

/**
 * Importing chats that other apps saved on this computer.
 *
 * The server reads only each app's own known store and never writes to it. A
 * client picks from the list the server scanned, so no path in a request ever
 * reaches a reader.
 */

export const ChatImportSourceSchema = z.object({
  /** Stable id, such as `codex` or `t3-code`. */
  id: z.string(),
  name: z.string(),
  /** The provider this source belongs to. Absent for an app that is not one. */
  provider: ProviderIdSchema.optional(),
  /** `scanning` until its first listing is done. A failed source hides no other source. */
  state: z.enum(['ready', 'scanning', 'failed']),
})
export type ChatImportSource = z.infer<typeof ChatImportSourceSchema>

/**
 * What continuing a chat does after it was imported. `session` picks up the
 * provider's own saved session. `copy` keeps the transcript here and hands it
 * to a new session with the next prompt.
 */
export const ChatImportContinuationSchema = z.enum(['session', 'copy'])
export type ChatImportContinuation = z.infer<typeof ChatImportContinuationSchema>

export const ChatImportChatSchema = z.object({
  /** Stable across scans; `chatImport.start` takes these. */
  id: z.string(),
  source: z.string(),
  /** Other sources that saved this same conversation. It is listed and imported once. */
  alsoIn: z.array(z.string()).optional(),
  title: z.string(),
  /** The folder it belongs to, which becomes a project when it is not one yet. */
  folder: z.string(),
  /** The provider that continues it. */
  provider: ProviderIdSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  continuation: ChatImportContinuationSchema,
  /** Already a chat in TasteCode, by this import or any other way. */
  imported: z.boolean(),
  archived: z.boolean().optional(),
})
export type ChatImportChat = z.infer<typeof ChatImportChatSchema>

export const ChatImportFolderSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** `path` as a person reads it, with `~` for the home folder. */
  label: z.string(),
  /** Already a project, so importing adds no new one. */
  isProject: z.boolean(),
  /** Gone from this computer. Its chats can be read but not continued in place. */
  missing: z.boolean(),
})
export type ChatImportFolder = z.infer<typeof ChatImportFolderSchema>

export const ChatImportJobSchema = z.object({
  state: z.enum(['running', 'finished']),
  /** Chats handled so far, whichever way each one ended. */
  done: z.number(),
  total: z.number(),
  imported: z.number(),
  failed: z.number(),
  /** Folders that became projects. */
  projects: z.array(z.string()),
})
export type ChatImportJob = z.infer<typeof ChatImportJobSchema>

export const ChatImportScanSchema = z.object({
  sources: z.array(ChatImportSourceSchema),
  chats: z.array(ChatImportChatSchema),
  folders: z.array(ChatImportFolderSchema),
  /** A running import, or the last one this server finished. */
  job: ChatImportJobSchema.optional(),
})
export type ChatImportScan = z.infer<typeof ChatImportScanSchema>
