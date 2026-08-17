import { z } from 'zod'

const BoundaryValueSchema = z.unknown()

export type BoundaryValue = z.input<typeof BoundaryValueSchema>

export function errorMessage(
  cause: BoundaryValue,
  fallback = 'An unexpected error occurred.',
): string {
  const error = z.instanceof(Error).safeParse(cause)
  if (error.success) return error.data.message.trim() || fallback
  return String(cause).trim() || fallback
}
