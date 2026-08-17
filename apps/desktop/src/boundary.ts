import { z } from 'zod'

/** Value received from Electron IPC or another untyped native boundary. */
export const BoundaryValueSchema = z.unknown()
export type BoundaryValue = z.input<typeof BoundaryValueSchema>

export const NonEmptyStringSchema = z.string().min(1)
