/** A route-owned JSON payload that has already been encoded from immutable data. */
export class SerializedResult {
  constructor(readonly json: string) {}
}

/** Reuse the encoded form while an immutable response keeps the same identity. */
export function createSerializedResultCache<T extends object>() {
  const cache = new WeakMap<T, SerializedResult>()
  return (value: T, encoded?: string): SerializedResult => {
    const cached = cache.get(value)
    if (cached) return cached
    const serialized = new SerializedResult(encoded ?? JSON.stringify(value))
    cache.set(value, serialized)
    return serialized
  }
}

export function serializeSuccessResponse(id: string, result: unknown): string {
  if (result instanceof SerializedResult) {
    return `{"id":${JSON.stringify(id)},"result":${result.json}}`
  }
  return JSON.stringify({ id, result })
}
