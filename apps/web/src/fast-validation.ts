export type FieldValidators<T> = { [Field in keyof T]-?: (value: unknown) => boolean }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Compile field iteration once. Validation keeps large reply graphs in place. */
export function objectValidator<T>(fields: FieldValidators<T>): (value: unknown) => value is T {
  const checks = Object.entries(fields) as Array<[string, (value: unknown) => boolean]>
  return (value): value is T => {
    if (!isRecord(value)) return false
    for (const [key, check] of checks) if (!check(value[key])) return false
    return true
  }
}

export const isString = (value: unknown): value is string => typeof value === 'string'
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
export const isNonnegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0
export const optional =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    value === undefined || check(value)
export const arrayOf =
  (check: (value: unknown) => boolean) =>
  (value: unknown): boolean =>
    Array.isArray(value) && value.every(check)
export const enumValidator =
  <T extends string>(values: Record<T, true>) =>
  (value: unknown): value is T =>
    typeof value === 'string' && Object.hasOwn(values, value)
