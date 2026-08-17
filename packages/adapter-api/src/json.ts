import { z } from 'zod'

export const JsonValueSchema = z.json()
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema)
const BoundaryValueSchema = z.unknown()
const JsonArraySchema = z.array(JsonValueSchema)
const JsonStringSchema = z.string()
const JsonNumberSchema = z.number()

export type JsonValue = z.infer<typeof JsonValueSchema>
export type JsonObject = z.infer<typeof JsonObjectSchema>
export type JsonInput = z.input<typeof BoundaryValueSchema>

export function jsonObject(value: JsonInput): JsonObject {
  const result = JsonObjectSchema.safeParse(value)
  return result.success ? result.data : {}
}

export function jsonArray(value: JsonInput): JsonValue[] {
  const result = JsonArraySchema.safeParse(value)
  return result.success ? result.data : []
}

export function jsonString(value: JsonInput): string {
  const result = JsonStringSchema.safeParse(value)
  return result.success ? result.data : ''
}

export function jsonNumber(value: JsonInput): number {
  const result = JsonNumberSchema.safeParse(value)
  return result.success ? result.data : 0
}
