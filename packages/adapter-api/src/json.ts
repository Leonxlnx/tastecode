export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

export function parseJsonValue(text: string): JsonValue {
  // SAFETY: JSON.parse can return only JSON primitives, arrays, and objects.
  return JSON.parse(text) as JsonValue
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function jsonObject(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {}
}

export function jsonArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : []
}

export function jsonString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function jsonNumber(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
