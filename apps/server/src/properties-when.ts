export function propertiesWhen<Condition, Properties extends object>(
  include: Condition | false | null | undefined,
  create: (included: Condition) => Properties,
): Partial<Properties> {
  if (!include) return {}
  return create(include)
}
