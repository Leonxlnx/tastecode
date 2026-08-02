export type ZoomAction = 'in' | 'out' | 'reset'

export function isZoomAction(value: unknown): value is ZoomAction {
  return value === 'in' || value === 'out' || value === 'reset'
}

export function zoomShortcut(input: {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
}): ZoomAction | undefined {
  if ((!input.control && !input.meta) || input.alt) return undefined
  switch (input.key.toLowerCase()) {
    case '+':
    case '=':
    case 'add':
      return 'in'
    case '-':
    case 'subtract':
      return 'out'
    case '0':
      return 'reset'
    default:
      return undefined
  }
}

export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset') return 1
  const delta = action === 'in' ? 0.1 : -0.1
  return Math.min(2, Math.max(0.5, Math.round((current + delta) * 10) / 10))
}
