export function propertiesWhen<Condition, Properties extends object>(
  include: Condition | false | null | undefined,
  create: (included: Condition) => Properties,
): Partial<Properties> {
  if (!include) return {}
  return create(include)
}

export function propertiesWhenDefined<Value, Properties extends object>(
  value: Value | null | undefined,
  create: (value: Value) => Properties,
): Partial<Properties> {
  if (value === null || value === undefined) return {}
  return create(value)
}
