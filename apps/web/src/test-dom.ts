type ElementConstructor<ElementType extends Element> = abstract new (
  ...arguments_: never[]
) => ElementType

export function requiredElement<ElementType extends Element>(
  root: ParentNode,
  selector: string,
  constructor: ElementConstructor<ElementType>,
): ElementType {
  const element = root.querySelector(selector)
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${selector} to match ${constructor.name}`)
  }
  return element
}

export function requiredInstance<ElementType extends Element>(
  element: Element,
  constructor: ElementConstructor<ElementType>,
): ElementType {
  if (!(element instanceof constructor)) {
    throw new Error(`Expected ${element.tagName} to be ${constructor.name}`)
  }
  return element
}

export function requiredValue<Value>(value: Value | null | undefined, label: string): Value {
  if (value === null || value === undefined) throw new Error(`Expected ${label}`)
  return value
}
