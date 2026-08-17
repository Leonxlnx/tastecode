import { z } from 'zod'

const BoundaryValueSchema = z.unknown()
const BoundaryRecordSchema = z.looseObject({})
const BoundaryListSchema = z.array(BoundaryValueSchema)
const NonEmptyStringSchema = z.string().refine((value) => value.trim() !== '')
const StringListSchema = z.array(NonEmptyStringSchema)
const AnyStringListSchema = z.array(z.string())
const FontWeightSchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,4}$/u)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(1_000))

export type BoundaryValue = z.input<typeof BoundaryValueSchema>
export type BoundaryRecord = z.infer<typeof BoundaryRecordSchema>
export type BoundaryList = z.infer<typeof BoundaryListSchema>

export function record(value: BoundaryValue, field: string): BoundaryRecord {
  const result = BoundaryRecordSchema.safeParse(value)
  if (!result.success) throw new Error(`${field} must be an object`)
  return result.data
}

export function optionalRecord(value: BoundaryValue): BoundaryRecord | undefined {
  const result = BoundaryRecordSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function string(value: BoundaryValue, field: string): string {
  const result = NonEmptyStringSchema.safeParse(value)
  if (!result.success) throw new Error(`${field} must be a non-empty string`)
  return result.data
}

export function optionalString(value: BoundaryValue, field: string): string | undefined {
  if (value === undefined) return undefined
  return string(value, field)
}

export function strings(value: BoundaryValue, field: string): string[] {
  const result = StringListSchema.safeParse(value)
  if (!result.success) throw new Error(`${field} must be a string array`)
  return result.data
}

export function stringsAllowEmpty(value: BoundaryValue, field: string): string[] {
  const result = AnyStringListSchema.safeParse(value)
  if (!result.success) throw new Error(`${field} must be a string array`)
  return result.data
}

export function list(value: BoundaryValue, field: string): BoundaryList {
  const result = BoundaryListSchema.safeParse(value)
  if (!result.success) throw new Error(`${field} must be an array`)
  return result.data
}

export function array(value: BoundaryValue, field: string): BoundaryList {
  const result = BoundaryListSchema.nonempty().safeParse(value)
  if (!result.success) throw new Error(`${field} must be a non-empty array`)
  return result.data
}

export function integer(
  value: BoundaryValue,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const result = z.number().int().min(minimum).max(maximum).safeParse(value)
  if (!result.success) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return result.data
}

export function boundedInteger(
  value: BoundaryValue,
  minimum: number,
  maximum: number,
): number | undefined {
  const result = z.number().int().min(minimum).max(maximum).safeParse(value)
  return result.success ? result.data : undefined
}

export function fontWeights(value: BoundaryValue, field: string): number[] {
  const result = z.array(FontWeightSchema).nonempty().safeParse(value)
  if (!result.success) {
    throw new Error(`${field} must contain font weights between 1 and 1000`)
  }
  return result.data
}

export function member<const Values extends readonly string[]>(
  value: BoundaryValue,
  values: Values,
  field: string,
): Values[number] {
  const result = z.enum(values).safeParse(value)
  if (!result.success) throw new Error(`${field} must be one of ${values.join(', ')}`)
  return result.data
}
